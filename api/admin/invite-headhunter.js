// POST /api/admin/invite-headhunter
//
// Superadmin-only. Issues a one-shot magic link for a partner (headhunter)
// to register or reset their password.
//
// Body: { email }
// Returns: { ok, headhunterId, status, inviteUrl } — inviteUrl is included
// for the operator's reference (not strictly needed; the link also goes by
// email).
//
// Idempotent: re-inviting a registered email rotates the password (the
// /api/headhunter/register endpoint upserts on the email).

const { supabaseAdmin } = require('../../lib/supabase');
const { generateToken, hashToken } = require('../../lib/tokens');
const { sendHeadhunterInviteEmail } = require('../../lib/email');
const { isValidEmail, normalizeEmail } = require('../../lib/validation');

const INVITE_TTL_HOURS = 7 * 24;

module.exports.default = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { email } = req.body || {};
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  const normEmail = normalizeEmail(email);

  try {
    // Upsert the headhunter row so we can list "invited" partners in admin
    // even before they complete registration.
    const { data: existing } = await supabaseAdmin
      .from('headhunters')
      .select('id, status')
      .eq('email', normEmail)
      .maybeSingle();

    let headhunterId;
    if (existing) {
      headhunterId = existing.id;
      // Re-invitation: don't downgrade an active account, but reset lockout.
      await supabaseAdmin
        .from('headhunters')
        .update({ failed_login_count: 0, locked_until: null })
        .eq('id', headhunterId);
    } else {
      const { data: created, error: cerr } = await supabaseAdmin
        .from('headhunters')
        .insert({
          email: normEmail,
          status: 'invited',
          // Best-effort attribution. Behind basic-auth so the operator
          // identity isn't easily extracted; we just log a static label.
          invited_by_email: 'admin@alter-5.com',
        })
        .select('id').single();
      if (cerr) throw cerr;
      headhunterId = created.id;
    }

    // Invalidate prior unused invites for this email so a stolen old link
    // can't beat the new one.
    await supabaseAdmin
      .from('headhunter_invites')
      .update({ used_at: new Date().toISOString() })
      .eq('email', normEmail)
      .is('used_at', null);

    const token = generateToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000).toISOString();
    const { error: ierr } = await supabaseAdmin
      .from('headhunter_invites')
      .insert({
        email: normEmail,
        token_hash: hashToken(token),
        expires_at: expiresAt,
        invited_by_email: 'admin@alter-5.com',
      });
    if (ierr) throw ierr;

    const baseUrl = process.env.INTERVIEW_BASE_URL || 'https://careers.alter-5.com';
    const inviteUrl = `${baseUrl}/partners?token=${token}`;
    const mail = await sendHeadhunterInviteEmail({
      to: normEmail,
      inviteUrl,
      ttlHours: INVITE_TTL_HOURS,
    });

    return res.status(200).json({
      ok: true,
      headhunterId,
      status: existing?.status || 'invited',
      inviteUrl,
      email_ok: mail.ok,
      email_id: mail.id || null,
    });
  } catch (e) {
    console.error('[admin/invite-headhunter] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
