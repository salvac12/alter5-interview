// GET /api/headhunter/invite-info?token=...
//
// Public endpoint that the /partners page hits to decide whether to render
// the registration form. Returns { ok: true, email } when the token is
// valid and unused, otherwise an error code so the page can show a friendly
// message instead of leaking which case it is in detail.

const { supabaseAdmin } = require('../../lib/supabase');
const { hashToken, isValidTokenFormat } = require('../../lib/tokens');

module.exports.default = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const token = String(req.query?.token || '');
  if (!isValidTokenFormat(token)) {
    return res.status(400).json({ error: 'invalid_token' });
  }

  try {
    const { data: row } = await supabaseAdmin
      .from('headhunter_invites')
      .select('email, expires_at, used_at')
      .eq('token_hash', hashToken(token))
      .maybeSingle();

    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.used_at) return res.status(410).json({ error: 'already_used' });
    if (new Date(row.expires_at) < new Date()) {
      return res.status(410).json({ error: 'expired' });
    }

    return res.status(200).json({ ok: true, email: row.email });
  } catch (e) {
    console.error('[headhunter/invite-info] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
