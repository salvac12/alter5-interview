// GET /api/admin/application?id=<uuid>
//
// Returns a full application detail: analysis, interview + all answers, events.

const { supabaseAdmin } = require('../../lib/supabase');

module.exports.default = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const id = req.query?.id;
  if (!id) return res.status(400).json({ error: 'missing_id' });

  try {
    const { data: app, error: aerr } = await supabaseAdmin
      .from('applications')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (aerr) throw aerr;
    if (!app) return res.status(404).json({ error: 'not_found' });

    const [analyses, cvs, interviews, events] = await Promise.all([
      supabaseAdmin.from('analyses').select('*').eq('application_id', id).order('analyzed_at', { ascending: false }),
      supabaseAdmin.from('cvs').select('*').eq('application_id', id).order('uploaded_at', { ascending: false }),
      supabaseAdmin.from('interviews').select('*').eq('application_id', id).order('completed_at', { ascending: false }),
      supabaseAdmin.from('application_events').select('*').eq('application_id', id).order('created_at', { ascending: false }).limit(100),
    ]);

    const interviewIds = (interviews.data || []).map(i => i.id);
    let answers = [];
    if (interviewIds.length > 0) {
      const r = await supabaseAdmin
        .from('interview_answers')
        .select('*')
        .in('interview_id', interviewIds)
        .order('question_idx', { ascending: true });
      answers = r.data || [];
    }

    let headhunter = null;
    if (app.headhunter_id) {
      const { data: hh } = await supabaseAdmin
        .from('headhunters')
        .select('id, email, name, company')
        .eq('id', app.headhunter_id)
        .maybeSingle();
      headhunter = hh || null;
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      application: app,
      analyses: analyses.data || [],
      cvs: cvs.data || [],
      interviews: interviews.data || [],
      interview_answers: answers,
      events: events.data || [],
      headhunter,
    });
  } catch (e) {
    console.error('[admin/application] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
