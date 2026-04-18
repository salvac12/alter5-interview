// POST /api/privacy/delete
//
// ARCO: user's right to erasure. Validates a `privacy_arco` token, calls
// arco_delete_application() RPC (soft-delete + PII scrub), removes the
// underlying CV PDFs from Storage, and consumes the token so it can't be
// reused.
//
// Body: { token }
// Returns: { ok:true } or { ok:false, reason }

const { supabaseAdmin } = require('../../lib/supabase');
const { hashToken, isValidTokenFormat } = require('../../lib/tokens');
const { getClientIp } = require('../../lib/validation');
const { deleteCvsForApp } = require('../../lib/cv-storage');

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
    // leaked link. If the RPC fails, we revert `used_at` so the user can
    // retry — without that revert, a transient Supabase error would burn the
    // candidate's only ARCO link permanently (TOCTOU window).
    const consumedAt = new Date().toISOString();
    const { error: consumeErr } = await supabaseAdmin
      .from('magic_links')
      .update({ used_at: consumedAt })
      .eq('id', link.id)
      .is('used_at', null);          // Only consume if still unused (race-safe)
    if (consumeErr) throw consumeErr;

    const { error: rpcErr } = await supabaseAdmin.rpc('arco_delete_application', {
      app_id: app.id,
      reason: 'candidate_self_service',
    });
    if (rpcErr) {
      // Revert the consume so the candidate can retry their ARCO link.
      // If the revert ITSELF fails, log loudly — the link is now permanently
      // burned and the candidate must request a new one. We still throw the
      // original RPC error so the user gets a 500 (not a misleading 200).
      const { error: revertErr } = await supabaseAdmin
        .from('magic_links')
        .update({ used_at: null })
        .eq('id', link.id)
        .eq('used_at', consumedAt);
      if (revertErr) {
        console.error('[privacy/delete] CRITICAL: token revert failed after RPC error', {
          link_id: link.id,
          rpc_error: rpcErr.message,
          revert_error: revertErr.message,
        });
      }
      throw rpcErr;
    }

    // Now that the DB-side scrub succeeded, wipe the candidate's CV files
    // from Storage. Best-effort: a storage failure does NOT undo the
    // application scrub (PII is already gone from the row), but we log it.
    let storageResult = null;
    try {
      storageResult = await deleteCvsForApp(app.id);
      if (storageResult.errors.length > 0) {
        console.error('[privacy/delete] storage cleanup partial:', storageResult.errors);
      }
    } catch (storageErr) {
      console.error('[privacy/delete] storage cleanup failed:', storageErr.message);
      storageResult = { error: storageErr.message };
    }

    // Log the deletion event with the candidate's IP (before scrub already
    // dropped apply_ip; this new event row keeps the self-service trace).
    await supabaseAdmin.from('application_events').insert({
      application_id: app.id,
      event_type: 'arco_self_delete',
      event_data: { via: 'privacy_link', storage: storageResult },
      actor: 'candidate',
      ip,
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[privacy/delete] error:', e.message);
    return res.status(500).json({ ok: false, reason: 'server' });
  }
};
