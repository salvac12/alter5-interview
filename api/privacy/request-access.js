// POST /api/privacy/request-access
//
// Public ARCO endpoint. User submits their email; we send a magic link
// to self-serve (view, export, delete).
//
// Body: { email }
// Always returns {ok:true} to avoid leaking existence of an application.

const { supabaseAdmin } = require('../../lib/supabase');
const { isValidEmail, normalizeEmail, getClientIp } = require('../../lib/validation');
const { generateToken, hashToken } = require('../../lib/tokens');
const { sendArcoLinkEmail } = require('../../lib/email');

const ARCO_TTL_MIN = 30;

module.exports.default = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { email } = req.body || {};
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });

  const normEmail = normalizeEmail(email);
  const ip = getClientIp(req);

  try {
    const { data: app } = await supabaseAdmin
      .from('applications')
      .select('id, email')
      .eq('email', normEmail)
      .is('deleted_at', null)
      .maybeSingle();

    // If no app exists, still return ok to prevent enumeration.
    if (!app) {
      console.log('[privacy/request-access] no application for', normEmail);
      return res.status(200).json({ ok: true });
    }

    // Invalidate previous ARCO links.
    await supabaseAdmin
      .from('magic_links')
      .update({ used_at: new Date().toISOString() })
      .eq('application_id', app.id)
      .eq('purpose', 'privacy_arco')
      .is('used_at', null);

    const token = generateToken();
    const expiresAt = new Date(Date.now() + ARCO_TTL_MIN * 60 * 1000).toISOString();
    await supabaseAdmin.from('magic_links').insert({
      application_id: app.id,
      purpose: 'privacy_arco',
      token_hash: hashToken(token),
      expires_at: expiresAt,
    });

    const baseUrl = process.env.INTERVIEW_BASE_URL || 'https://careers.alter-5.com';
    const manageUrl = `${baseUrl}/privacy/my-data?token=${token}`;

    const mail = await sendArcoLinkEmail({ to: app.email, manageUrl, ttlMinutes: ARCO_TTL_MIN });

    await supabaseAdmin.from('application_events').insert({
      application_id: app.id,
      event_type: 'arco_link_sent',
      event_data: { email_ok: mail.ok },
      actor: 'candidate',
      ip,
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[privacy/request-access] error:', e.message);
    // Also return ok so attackers can't probe errors.
    return res.status(200).json({ ok: true });
  }
};
