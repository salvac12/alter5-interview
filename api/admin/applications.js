// GET /api/admin/applications
//
// Admin-only (behind Basic Auth via middleware). Returns a paginated list
// of applications with their latest analysis + interview. Supports filters:
//   ?status=<application_status>
//   ?source=public|admin_manual|legacy
//   ?q=<email substring>
//   ?limit=<n>  (default 100, max 500)

const { supabaseAdmin } = require('../../lib/supabase');

module.exports.default = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const limit = Math.min(500, Math.max(1, parseInt(req.query?.limit) || 100));
  const status = req.query?.status;
  const source = req.query?.source;
  const q = req.query?.q;

  try {
    let query = supabaseAdmin
      .from('applications')
      .select(`
        id, email, status, source, name, experience,
        requested_human_review, consent_privacy, consent_ai_decision,
        apply_ip, utm_source, utm_medium, utm_campaign,
        created_at, verified_at, cv_uploaded_at, analyzed_at,
        interview_started_at, interview_completed_at, expires_at, deleted_at
      `)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);
    if (q) query = query.ilike('email', `%${String(q).slice(0, 80)}%`);

    const { data: apps, error } = await query;
    if (error) throw error;

    if (!apps || apps.length === 0) return res.status(200).json({ applications: [] });

    const appIds = apps.map(a => a.id);

    // Fetch latest analysis per application
    const { data: analyses } = await supabaseAdmin
      .from('analyses')
      .select('application_id, score, recommendation, summary, model, analyzed_at')
      .in('application_id', appIds)
      .order('analyzed_at', { ascending: false });

    // Fetch latest interview per application
    const { data: interviews } = await supabaseAdmin
      .from('interviews')
      .select('id, application_id, global_score, flags, dim_scores, verdict, recommendation, final_score, salary, completed_at')
      .in('application_id', appIds)
      .order('completed_at', { ascending: false });

    // Fetch latest CV per application
    const { data: cvs } = await supabaseAdmin
      .from('cvs')
      .select('id, application_id, filename, size_bytes, uploaded_at')
      .in('application_id', appIds)
      .order('uploaded_at', { ascending: false });

    const byId = (arr) => {
      const m = {};
      for (const r of arr || []) {
        if (!m[r.application_id]) m[r.application_id] = r;
      }
      return m;
    };
    const analysisMap = byId(analyses);
    const interviewMap = byId(interviews);
    const cvMap = byId(cvs);

    const out = apps.map(a => ({
      ...a,
      latest_analysis: analysisMap[a.id] || null,
      latest_interview: interviewMap[a.id] || null,
      latest_cv: cvMap[a.id] || null,
    }));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ applications: out });
  } catch (e) {
    console.error('[admin/applications] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
