// POST /api/privacy/data
//
// ARCO: user's right to access. Validates a `privacy_arco` token (without
// consuming it — many views don't need a new token per action) and returns
// the full data set held about the candidate.
//
// Body: { token }
// Returns: { ok:true, data: {...} } or { ok:false, reason }

const { supabaseAdmin } = require('../../lib/supabase');
const { hashToken, isValidTokenFormat } = require('../../lib/tokens');

module.exports.default = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });

  const { token } = req.body || {};
  if (!token || !isValidTokenFormat(token)) {
    return res.status(400).json({ ok: false, reason: 'invalid' });
  }

  try {
    const { data: link } = await supabaseAdmin
      .from('magic_links')
      .select('id, application_id, expires_at, used_at, purpose')
      .eq('token_hash', hashToken(token))
      .eq('purpose', 'privacy_arco')
      .maybeSingle();
    if (!link) return res.status(200).json({ ok: false, reason: 'not_found' });
    if (link.used_at) return res.status(200).json({ ok: false, reason: 'used' });
    if (new Date(link.expires_at) < new Date()) {
      return res.status(200).json({ ok: false, reason: 'expired' });
    }

    const { data: app } = await supabaseAdmin
      .from('applications')
      .select('*')
      .eq('id', link.application_id)
      .maybeSingle();
    if (!app || app.deleted_at) return res.status(200).json({ ok: false, reason: 'not_found' });

    const [analysesRes, cvsRes, interviewsRes, eventsRes] = await Promise.all([
      supabaseAdmin.from('analyses').select('id, cv_id, score, recommendation, summary, model, analyzed_at').eq('application_id', app.id),
      supabaseAdmin.from('cvs').select('id, filename, size_bytes, uploaded_at').eq('application_id', app.id),
      supabaseAdmin.from('interviews').select('id, global_score, dim_scores, flags, answers_count, skipped_count, total_time_sec, verdict, recommendation, final_score, salary, source, completed_at').eq('application_id', app.id),
      supabaseAdmin.from('application_events').select('event_type, event_data, actor, created_at').eq('application_id', app.id).order('created_at', { ascending: false }).limit(100),
    ]);

    const interviews = interviewsRes.data || [];
    let interviewAnswers = [];
    if (interviews.length) {
      const ivIds = interviews.map(i => i.id);
      const { data: ans } = await supabaseAdmin
        .from('interview_answers')
        .select('interview_id, question_idx, question_key, question_type, answer_text, answer_options, time_sec, flag')
        .in('interview_id', ivIds)
        .order('question_idx', { ascending: true });
      interviewAnswers = ans || [];
    }

    return res.status(200).json({
      ok: true,
      data: {
        application: {
          id: app.id,
          email: app.email,
          name: app.name,
          status: app.status,
          source: app.source,
          experience: app.experience,
          consent_privacy: app.consent_privacy,
          consent_ai_decision: app.consent_ai_decision,
          requested_human_review: app.requested_human_review,
          utm_source: app.utm_source,
          utm_medium: app.utm_medium,
          utm_campaign: app.utm_campaign,
          created_at: app.created_at,
          verified_at: app.verified_at,
          cv_uploaded_at: app.cv_uploaded_at,
          analyzed_at: app.analyzed_at,
          interview_started_at: app.interview_started_at,
          interview_completed_at: app.interview_completed_at,
          expires_at: app.expires_at,
        },
        analyses: analysesRes.data || [],
        cvs: cvsRes.data || [],
        interviews,
        interview_answers: interviewAnswers,
        events: eventsRes.data || [],
      },
    });
  } catch (e) {
    console.error('[privacy/data] error:', e.message);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
