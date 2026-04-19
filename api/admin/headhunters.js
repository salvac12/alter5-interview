// GET /api/admin/headhunters
//
// Lists every partner (registered or just invited) with their candidate count.

const { supabaseAdmin } = require('../../lib/supabase');

module.exports.default = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('headhunters')
      .select('id, email, name, company, status, invited_by_email, created_at, registered_at, last_login_at, locked_until, auto_invite_allowed')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Per-row count of applications. One round-trip per partner is fine
    // because the list is human-sized (<50 expected). Bigger scale would
    // warrant a view + RPC.
    const ids = rows.map(r => r.id);
    const counts = {};
    if (ids.length) {
      // GROUP BY headhunter_id via a single query.
      const { data: countRows } = await supabaseAdmin
        .from('applications')
        .select('headhunter_id')
        .in('headhunter_id', ids)
        .is('deleted_at', null);
      for (const c of countRows || []) {
        counts[c.headhunter_id] = (counts[c.headhunter_id] || 0) + 1;
      }
    }

    return res.status(200).json({
      ok: true,
      headhunters: rows.map(r => ({
        ...r,
        candidates_uploaded: counts[r.id] || 0,
        is_locked: !!(r.locked_until && new Date(r.locked_until) > new Date()),
      })),
    });
  } catch (e) {
    console.error('[admin/headhunters] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
