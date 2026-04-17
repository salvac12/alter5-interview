// POST /api/admin/review-decision
//
// Admin action for manually-reviewed applications (score 4-6 or human review request).
// Body: { applicationId, decision: 'approve' | 'reject', note? }
// - approve: status -> analyzed_manual_approved, creates interview magic link, sends email
// - reject:  status -> analyzed_manual_rejected (silent, no email)

const { supabaseAdmin } = require('../../lib/supabase');
const { generateToken, hashToken } = require('../../lib/tokens');
const { sendInterviewLinkEmail } = require('../../lib/email');

const INTERVIEW_TTL_DAYS = 7;

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

    const allowed = ['analyzed_pending_review', 'analyzed_auto_rejected', 'analyzed_auto_invited'];
    if (!allowed.includes(app.status)) {
      return res.status(409).json({ error: 'invalid_state', state: app.status });
    }

    if (decision === 'reject') {
      await supabaseAdmin
        .from('applications')
        .update({ status: 'analyzed_manual_rejected' })
        .eq('id', applicationId);
      await supabaseAdmin.from('application_events').insert({
        application_id: applicationId,
        event_type: 'manual_reject',
        event_data: { note: note || null },
        actor: 'admin',
      });
      return res.status(200).json({ ok: true, status: 'analyzed_manual_rejected' });
    }

    // Approve: create new interview magic link + send email.
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
