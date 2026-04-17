// POST /api/interview/validate
//
// Body: { token }
// Validates an interview magic link without consuming it.
// Returns { ok, name, experience, applicationId, alreadyCompleted } or { ok:false, reason }.

const { supabaseAdmin } = require('../../lib/supabase');
const { hashToken, isValidTokenFormat } = require('../../lib/tokens');

module.exports.default = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });

  const { token } = req.body || {};
  if (!token || !isValidTokenFormat(token)) {
    return res.status(400).json({ ok: false, reason: 'invalid' });
  }

  try {
    const { data: link, error: linkErr } = await supabaseAdmin
      .from('magic_links')
      .select('id, application_id, expires_at, used_at, purpose')
      .eq('token_hash', hashToken(token))
      .eq('purpose', 'interview')
      .maybeSingle();
    if (linkErr) throw linkErr;
    if (!link) return res.status(200).json({ ok: false, reason: 'not_found' });
    if (link.used_at) return res.status(200).json({ ok: false, reason: 'used' });
    if (new Date(link.expires_at) < new Date()) {
      return res.status(200).json({ ok: false, reason: 'expired' });
    }

    const { data: app, error: appErr } = await supabaseAdmin
      .from('applications')
      .select('id, name, experience, status, deleted_at')
      .eq('id', link.application_id)
      .maybeSingle();
    if (appErr) throw appErr;
    if (!app || app.deleted_at) return res.status(200).json({ ok: false, reason: 'not_found' });
    if (app.status === 'interview_completed') {
      return res.status(200).json({ ok: false, reason: 'completed' });
    }

    return res.status(200).json({
      ok: true,
      applicationId: app.id,
      name: app.name || '',
      experience: app.experience || '',
    });
  } catch (e) {
    console.error('[interview/validate] error:', e.message);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
