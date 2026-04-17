// Cloudflare Turnstile verification.
//
// In dev we support the Cloudflare TEST keys (1x00...) which always pass.
// If TURNSTILE_SECRET_KEY is not set, verification is skipped (dev fallback).

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn('[turnstile] TURNSTILE_SECRET_KEY not set — skipping verification');
    return { success: true, skipped: true };
  }
  if (!token) return { success: false, error: 'missing_token' };

  const form = new URLSearchParams();
  form.append('secret', secret);
  form.append('response', String(token));
  if (ip) form.append('remoteip', ip);

  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await r.json();
    if (data.success) return { success: true };
    return { success: false, error: (data['error-codes'] || []).join(',') || 'failed' };
  } catch (e) {
    console.error('[turnstile] verify error:', e.message);
    return { success: false, error: 'network_error' };
  }
}

module.exports = { verifyTurnstile };
