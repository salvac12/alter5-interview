// GET /api/admin/export?type=applications|interviews
//
// CSV export for admin/reports.

const { supabaseAdmin } = require('../../lib/supabase');

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

module.exports.default = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const type = req.query?.type || 'applications';

  try {
    if (type === 'applications') {
      const { data } = await supabaseAdmin
        .from('applications')
        .select(`
          id, email, name, status, source, experience,
          consent_privacy, consent_ai_decision, requested_human_review,
          utm_source, utm_medium, utm_campaign,
          created_at, verified_at, cv_uploaded_at, analyzed_at,
          interview_completed_at
        `)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      const cols = ['id', 'email', 'name', 'status', 'source', 'experience', 'consent_privacy', 'consent_ai_decision', 'requested_human_review', 'utm_source', 'utm_medium', 'utm_campaign', 'created_at', 'verified_at', 'cv_uploaded_at', 'analyzed_at', 'interview_completed_at'];
      const rows = [cols.join(',')];
      for (const r of data || []) rows.push(cols.map(c => csvEscape(r[c])).join(','));

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="applications_${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.status(200).send(rows.join('\n'));
    }

    if (type === 'interviews') {
      const { data } = await supabaseAdmin
        .from('interviews')
        .select('id, application_id, global_score, flags, answers_count, skipped_count, total_time_sec, verdict, recommendation, final_score, salary, source, completed_at, applications(email, name)')
        .order('completed_at', { ascending: false });

      const cols = ['id', 'application_id', 'email', 'name', 'global_score', 'flags', 'answers_count', 'skipped_count', 'total_time_sec', 'verdict', 'recommendation', 'final_score', 'salary', 'source', 'completed_at'];
      const rows = [cols.join(',')];
      for (const r of data || []) {
        const row = {
          ...r,
          email: r.applications?.email || '',
          name: r.applications?.name || '',
        };
        rows.push(cols.map(c => csvEscape(row[c])).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="interviews_${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.status(200).send(rows.join('\n'));
    }

    return res.status(400).json({ error: 'invalid_type' });
  } catch (e) {
    console.error('[admin/export] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
