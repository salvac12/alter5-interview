// POST /api/admin/headhunter-disable
//
// Admin actions on a headhunter row.
//
// Body:
//   { id, action: 'disable' }                 → status = 'disabled'
//   { id, action: 'enable' }                  → status = 'active' (or 'invited' if never registered)
//   { id, action: 'set_auto_invite', value }  → toggles auto_invite_allowed
//
// (Endpoint name kept for backwards-compat with the deployed admin UI.)

const { supabaseAdmin } = require('../../lib/supabase');

const STATUS_ACTIONS = new Set(['disable', 'enable']);

module.exports.default = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { id, action, value } = req.body || {};
  if (!id || !['disable', 'enable', 'set_auto_invite'].includes(action)) {
    return res.status(400).json({ error: 'invalid' });
  }

  try {
    const { data: hh, error: ferr } = await supabaseAdmin
      .from('headhunters')
      .select('id, status, registered_at')
      .eq('id', id)
      .maybeSingle();
    if (ferr) throw ferr;
    if (!hh) return res.status(404).json({ error: 'not_found' });

    if (STATUS_ACTIONS.has(action)) {
      const nextStatus = action === 'disable'
        ? 'disabled'
        : (hh.registered_at ? 'active' : 'invited');

      const { error: uerr } = await supabaseAdmin
        .from('headhunters')
        .update({ status: nextStatus, failed_login_count: 0, locked_until: null })
        .eq('id', id);
      if (uerr) throw uerr;
      return res.status(200).json({ ok: true, status: nextStatus });
    }

    // set_auto_invite — explicit opt-in toggle for the autoInvite shortcut.
    const nextValue = !!value;
    const { error: uerr } = await supabaseAdmin
      .from('headhunters')
      .update({ auto_invite_allowed: nextValue })
      .eq('id', id);
    if (uerr) throw uerr;
    return res.status(200).json({ ok: true, auto_invite_allowed: nextValue });
  } catch (e) {
    console.error('[admin/headhunter-disable] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
