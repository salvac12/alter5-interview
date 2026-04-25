// POST /api/admin/resend-interview-reminder
//
// Admin-triggered nudge for candidates who were approved after CV screening
// but didn't open or didn't finish the interview. Issues a fresh interview
// magic link (same 7-day TTL as the initial invite) and sends a reminder
// email. Application status is NOT changed — only the link is refreshed.
//
// Eligible statuses:
//   - analyzed_manual_approved  (admin approved, link sent, never opened)
//   - analyzed_auto_invited     (auto-approved, link sent, never opened)
//   - interview_started         (candidate opened the link and started but
//                                never submitted; token only gets marked
//                                used_at on submit, so a fresh token here
//                                covers the case where the original expired)
//
// Any prior unused interview magic_link for this application is invalidated
// (used_at = now()) before issuing the new one — same defense-in-depth
// pattern as api/admin/invite-headhunter.js.
//
// Body: { applicationId }
//
// Auth: middleware.js enforces Basic Auth on /api/admin/*.

const { supabaseAdmin } = require('../../lib/supabase');
const { generateToken, hashToken } = require('../../lib/tokens');
const { getPositionByApplication } = require('../../lib/positions');
const { sendInterviewReminderEmail } = require('../../lib/email');

const INTERVIEW_TTL_DAYS = 7;

const ELIGIBLE_STATES = [
  'analyzed_manual_approved',
  'analyzed_auto_invited',
  'interview_started',
];

function positionTitleOf(p) {
  if (!p) return null;
  return p.subtitle ? `${p.title} · ${p.subtitle}` : p.title;
}

module.exports.default = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { applicationId } = req.body || {};
  if (!applicationId) return res.status(400).json({ error: 'invalid' });

  try {
    const { data: app, error: aerr } = await supabaseAdmin
      .from('applications')
      .select('id, email, name, status, deleted_at')
      .eq('id', applicationId)
      .maybeSingle();
    if (aerr) throw aerr;
    if (!app || app.deleted_at) return res.status(404).json({ error: 'not_found' });
    if (!ELIGIBLE_STATES.includes(app.status)) {
      return res.status(409).json({ error: 'invalid_state', state: app.status });
    }

    // Invalidate any prior unused interview magic link for this application
    // before minting a new one.
    await supabaseAdmin
      .from('magic_links')
      .update({ used_at: new Date().toISOString() })
      .eq('application_id', applicationId)
      .eq('purpose', 'interview')
      .is('used_at', null);

    const token = generateToken();
    const expiresAt = new Date(Date.now() + INTERVIEW_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { error: lerr } = await supabaseAdmin.from('magic_links').insert({
      application_id: applicationId,
      purpose: 'interview',
      token_hash: hashToken(token),
      expires_at: expiresAt,
    });
    if (lerr) throw lerr;

    const position = await getPositionByApplication(applicationId);
    const positionTitle = positionTitleOf(position);

    const baseUrl = process.env.INTERVIEW_BASE_URL || 'https://careers.alter-5.com';
    const interviewUrl = `${baseUrl}/interview?token=${token}`;

    const mail = await sendInterviewReminderEmail({
      to: app.email,
      name: app.name || '',
      interviewUrl,
      expiresDays: INTERVIEW_TTL_DAYS,
      positionTitle,
    });

    await supabaseAdmin.from('application_events').insert({
      application_id: applicationId,
      event_type: 'interview_reminder_sent',
      event_data: {
        email_ok: mail.ok,
        email_id: mail.id || null,
        email_error: mail.error || null,
      },
      actor: 'admin',
    });

    return res.status(200).json({
      ok: true,
      email_ok: mail.ok,
      interview_url: interviewUrl,
    });
  } catch (e) {
    console.error('[admin/resend-interview-reminder] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
