// GET /api/apply/verify?token=HEX
//
// Validates a verify_email magic link. On success:
//   - marks the link used_at
//   - updates applications.status = 'verified', verified_at = now
//   - sets a signed session cookie
//   - 302 redirects to /apply/upload
// On failure: 302 to /apply/verify-failed?reason=...

const { supabaseAdmin } = require('../../lib/supabase');
const { hashToken, isValidTokenFormat } = require('../../lib/tokens');
const { sign, setCookieHeader } = require('../../lib/session');
const { getClientIp, getUserAgent } = require('../../lib/validation');

function redirect(res, url, extraHeaders = {}) {
  res.statusCode = 302;
  res.setHeader('Location', url);
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const baseUrl = process.env.APPLY_BASE_URL || 'https://careers.alter-5.com/sw-architect';
  const origin = new URL(baseUrl).origin;

  const token = String((req.query && req.query.token) || '').trim();

  if (!isValidTokenFormat(token)) {
    return redirect(res, `${origin}/apply/verify-failed?reason=invalid`);
  }

  const tokenHash = hashToken(token);

  try {
    const { data: link, error } = await supabaseAdmin
      .from('magic_links')
      .select('id, application_id, purpose, expires_at, used_at, applications(email, deleted_at)')
      .eq('token_hash', tokenHash)
      .eq('purpose', 'verify_email')
      .maybeSingle();

    if (error) throw error;

    if (!link) return redirect(res, `${origin}/apply/verify-failed?reason=invalid`);
    if (link.used_at) return redirect(res, `${origin}/apply/verify-failed?reason=used`);
    if (new Date(link.expires_at) < new Date()) {
      return redirect(res, `${origin}/apply/verify-failed?reason=expired`);
    }
    if (!link.applications || link.applications.deleted_at) {
      return redirect(res, `${origin}/apply/verify-failed?reason=deleted`);
    }

    // Mark used + update application.
    const now = new Date().toISOString();
    await supabaseAdmin.from('magic_links').update({ used_at: now }).eq('id', link.id);

    await supabaseAdmin
      .from('applications')
      .update({
        status: 'verified',
        verified_at: now,
      })
      .eq('id', link.application_id)
      .eq('status', 'pending_verify'); // only transition from pending

    // Audit.
    await supabaseAdmin.from('application_events').insert({
      application_id: link.application_id,
      event_type: 'email_verified',
      actor: 'candidate',
      ip: getClientIp(req),
      user_agent: getUserAgent(req),
    });

    // Sign session cookie (60 min — enough to upload CV).
    const sessionToken = sign(
      { app_id: link.application_id, email: link.applications.email },
      60 * 60
    );

    return redirect(res, `${origin}/apply/upload`, {
      'Set-Cookie': setCookieHeader(sessionToken, 60 * 60),
    });
  } catch (e) {
    console.error('[verify] error:', e.message);
    return redirect(res, `${origin}/apply/verify-failed?reason=server`);
  }
};
