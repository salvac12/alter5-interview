// POST /api/privacy/delete
//
// ARCO: user's right to erasure. Validates a `privacy_arco` token, calls
// arco_delete_application() RPC (soft-delete + PII scrub), and consumes the
// token so it can't be reused.
//
// Body: { token }
// Returns: { ok:true } or { ok:false, reason }

const { supabaseAdmin } = require('../../lib/supabase');
const { hashToken, isValidTokenFormat } = require('../../lib/tokens');
const { getClientIp } = require('../../lib/validation');

module.exports.default = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });

  const { token } = req.body || {};
  if (!token || !isValidTokenFormat(token)) {
    return res.status(400).json({ ok: false, reason: 'invalid' });
  }

  const ip = getClientIp(req);

  try {
    const { data: link } = await supabaseAdmin
      .from('magic_links')
      .select('id, application_id, expires_at, used_at')
      .eq('token_hash', hashToken(token))
      .eq('purpose', 'privacy_arco')
      .maybeSingle();
    if (!link) return res.status(200).json({ ok: false, reason: 'not_found' });
    if (link.used_at) return res.status(200).json({ ok: false, reason: 'used' });
    if (new Date(link.expires_at) < new Date()) {
      return res.status(200).json({ ok: false, reason: 'expired' });
    }

    const { data: app } = await supabaseAdmin
      .from('applications')
      .select('id, deleted_at')
      .eq('id', link.application_id)
      .maybeSingle();
    if (!app || app.deleted_at) {
      return res.status(200).json({ ok: false, reason: 'not_found' });
    }

    // Consume the token first so a crash mid-way can't allow a retry from a
    // leaked link. If the RPC fails, we've burned the token — user must
    // request a new ARCO link.
    await supabaseAdmin
      .from('magic_links')
      .update({ used_at: new Date().toISOString() })
      .eq('id', link.id);

    const { error: rpcErr } = await supabaseAdmin.rpc('arco_delete_application', {
      app_id: app.id,
      reason: 'candidate_self_service',
    });
    if (rpcErr) throw rpcErr;

    // Log the deletion event with the candidate's IP (before scrub already
    // dropped apply_ip; this new event row keeps the self-service trace).
    await supabaseAdmin.from('application_events').insert({
      application_id: app.id,
      event_type: 'arco_self_delete',
      event_data: { via: 'privacy_link' },
      actor: 'candidate',
      ip,
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[privacy/delete] error:', e.message);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
