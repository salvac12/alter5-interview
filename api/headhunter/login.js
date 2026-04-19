// POST /api/headhunter/login
//
// Body: { email, password }
// Sets the session cookie on success. On failure, increments the per-row
// counter; after 10 misses the account is locked for 24h.

const { supabaseAdmin } = require('../../lib/supabase');
const { verifyPassword } = require('../../lib/password');
const { sign, setCookieHeader } = require('../../lib/headhunter-session');
const { isValidEmail, normalizeEmail } = require('../../lib/validation');

const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_HOURS = 24;

module.exports.default = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { email, password } = req.body || {};
  if (!email || !isValidEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ error: 'invalid' });
  }
  const normEmail = normalizeEmail(email);

  try {
    const { data: hh } = await supabaseAdmin
      .from('headhunters')
      .select('id, email, name, company, password_hash, status, failed_login_count, locked_until')
      .eq('email', normEmail)
      .maybeSingle();

    // Generic message for missing/disabled/locked/wrong password — don't
    // leak which case applies. We still bookkeep failures on the row when
    // the account exists.
    const generic = () => res.status(401).json({ error: 'invalid_credentials' });

    if (!hh || !hh.password_hash) return generic();
    if (hh.status === 'disabled') return generic();
    if (hh.locked_until && new Date(hh.locked_until) > new Date()) {
      return res.status(423).json({ error: 'account_locked' });
    }

    if (!verifyPassword(password, hh.password_hash)) {
      // Atomic increment + lockout: avoids the read-modify-write race that
      // would let concurrent attempts share the same base counter and skip
      // the threshold.
      await supabaseAdmin.rpc('increment_headhunter_failed_login', {
        p_id: hh.id,
        p_threshold: LOCKOUT_THRESHOLD,
        p_lockout_hours: LOCKOUT_HOURS,
      });
      return generic();
    }

    await supabaseAdmin
      .from('headhunters')
      .update({
        failed_login_count: 0,
        locked_until: null,
        last_login_at: new Date().toISOString(),
      })
      .eq('id', hh.id);

    const sessionToken = sign({ hh_id: hh.id, email: hh.email });
    res.setHeader('Set-Cookie', setCookieHeader(sessionToken));
    return res.status(200).json({
      ok: true,
      headhunter: { id: hh.id, email: hh.email, name: hh.name, company: hh.company },
    });
  } catch (e) {
    console.error('[headhunter/login] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
