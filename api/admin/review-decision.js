// POST /api/admin/review-decision
//
// Admin action for manually-reviewed candidates. Routes by current status:
//
//   CV stage  (analyzed_pending_review | analyzed_auto_rejected | analyzed_auto_invited)
//     approve -> analyzed_manual_approved  + interview link email
//     reject  -> analyzed_manual_rejected  + CV-stage rejection email
//
//   Interview stage  (interview_completed)
//     reject  -> post_interview_rejected   + post-interview rejection email
//     (approve is not a terminal action here — hiring happens outside the app)
//
// Body: { applicationId, decision: 'approve' | 'reject', note? }

const { supabaseAdmin } = require('../../lib/supabase');
const { generateToken, hashToken } = require('../../lib/tokens');
const {
  sendInterviewLinkEmail,
  sendPostCvRejectionEmail,
  sendPostInterviewRejectionEmail,
} = require('../../lib/email');

const INTERVIEW_TTL_DAYS = 7;

const CV_STAGE_STATES = ['analyzed_pending_review', 'analyzed_auto_rejected', 'analyzed_auto_invited'];
const INTERVIEW_STAGE_STATES = ['interview_completed'];

module.exports.default = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { applicationId, decision, note } = req.body || {};
  if (!applicationId || !['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'invalid' });
  }

  try {
    const { data: app, error: aerr } = await supabaseAdmin
      .from('applications')
      .select('id, email, name, status, deleted_at')
      .eq('id', applicationId)
      .maybeSingle();
    if (aerr) throw aerr;
    if (!app || app.deleted_at) return res.status(404).json({ error: 'not_found' });

    const inCvStage = CV_STAGE_STATES.includes(app.status);
    const inInterviewStage = INTERVIEW_STAGE_STATES.includes(app.status);
    if (!inCvStage && !inInterviewStage) {
      return res.status(409).json({ error: 'invalid_state', state: app.status });
    }

    // ── Reject ────────────────────────────────────────────────────────
    if (decision === 'reject') {
      const nextStatus = inInterviewStage ? 'post_interview_rejected' : 'analyzed_manual_rejected';
      const sendFn = inInterviewStage ? sendPostInterviewRejectionEmail : sendPostCvRejectionEmail;

      await supabaseAdmin
        .from('applications')
        .update({ status: nextStatus })
        .eq('id', applicationId);

      const mail = await sendFn({ to: app.email, name: app.name || '' });

      await supabaseAdmin.from('application_events').insert({
        application_id: applicationId,
        event_type: inInterviewStage ? 'post_interview_reject' : 'manual_reject',
        event_data: {
          note: note || null,
          email_ok: mail.ok,
          email_id: mail.id || null,
          email_error: mail.error || null,
        },
        actor: 'admin',
      });

      return res.status(200).json({ ok: true, status: nextStatus, email_ok: mail.ok });
    }

    // ── Approve ───────────────────────────────────────────────────────
    // Approve only makes sense in CV stage — from interview_completed the
    // next step is an out-of-band offer, not another app state.
    if (inInterviewStage) {
      return res.status(409).json({ error: 'approve_not_applicable_post_interview' });
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + INTERVIEW_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    await supabaseAdmin.from('magic_links').insert({
      application_id: applicationId,
      purpose: 'interview',
      token_hash: hashToken(token),
      expires_at: expiresAt,
    });

    await supabaseAdmin
      .from('applications')
      .update({ status: 'analyzed_manual_approved' })
      .eq('id', applicationId);

    const baseUrl = process.env.INTERVIEW_BASE_URL || 'https://careers.alter-5.com';
    const interviewUrl = `${baseUrl}/interview?token=${token}`;

    const mail = await sendInterviewLinkEmail({
      to: app.email,
      name: app.name || '',
      interviewUrl,
      expiresDays: INTERVIEW_TTL_DAYS,
    });

    await supabaseAdmin.from('application_events').insert({
      application_id: applicationId,
      event_type: 'manual_approve',
      event_data: { note: note || null, email_ok: mail.ok, email_id: mail.id || null },
      actor: 'admin',
    });

    return res.status(200).json({
      ok: true,
      status: 'analyzed_manual_approved',
      interview_url: interviewUrl,
      email_ok: mail.ok,
    });
  } catch (e) {
    console.error('[admin/review-decision] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
