// POST /api/headhunter/register
//
// Completes a partner signup (or password reset, when the email is already
// registered — the admin re-invites in that case) using a one-shot magic
// link. Sets the session cookie on success so the partner lands on
// /partners/upload already authenticated.
//
// Body: { token, name, company, password }

const { supabaseAdmin } = require('../../lib/supabase');
const { hashToken, isValidTokenFormat } = require('../../lib/tokens');
const { hashPassword, isValidPasswordShape, MIN_PASSWORD_LEN } = require('../../lib/password');
const { sign, setCookieHeader } = require('../../lib/headhunter-session');

module.exports.default = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { token, name, company, password } = req.body || {};
  if (!isValidTokenFormat(token)) return res.status(400).json({ error: 'invalid_token' });
  if (!name || !company) return res.status(400).json({ error: 'missing_profile' });
  if (!isValidPasswordShape(password)) {
    return res.status(400).json({ error: 'weak_password', min_length: MIN_PASSWORD_LEN });
  }

  try {
    const { data: invite } = await supabaseAdmin
      .from('headhunter_invites')
      .select('id, email, expires_at, used_at')
      .eq('token_hash', hashToken(token))
      .maybeSingle();
    if (!invite) return res.status(404).json({ error: 'invite_not_found' });
    if (invite.used_at) return res.status(410).json({ error: 'invite_used' });
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: 'invite_expired' });
    }

    const passwordHash = hashPassword(password);
    const safeName = String(name).trim().slice(0, 100);
    const safeCompany = String(company).trim().slice(0, 100);

    // Upsert the headhunter row by email. The row already exists from the
    // invite endpoint, so this is essentially "fill in the blanks".
    const { data: hh, error: uerr } = await supabaseAdmin
      .from('headhunters')
      .update({
        name: safeName,
        company: safeCompany,
        password_hash: passwordHash,
        status: 'active',
        registered_at: new Date().toISOString(),
        failed_login_count: 0,
        locked_until: null,
      })
      .eq('email', invite.email)
      .select('id, email, name, company').single();
    if (uerr) throw uerr;

    // CRITICAL: if marking the invite as used fails silently, the magic
    // link stays valid and can be replayed to overwrite the password we
    // just set. Throw on error so the registration is rolled-back at the
    // application layer (the headhunter row already has the new hash, but
    // the invite is what gates re-use).
    const { error: muErr } = await supabaseAdmin
      .from('headhunter_invites')
      .update({ used_at: new Date().toISOString() })
      .eq('id', invite.id);
    if (muErr) throw muErr;

    const sessionToken = sign({ hh_id: hh.id, email: hh.email });
    res.setHeader('Set-Cookie', setCookieHeader(sessionToken));
    return res.status(200).json({
      ok: true,
      headhunter: { id: hh.id, email: hh.email, name: hh.name, company: hh.company },
    });
  } catch (e) {
    console.error('[headhunter/register] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
