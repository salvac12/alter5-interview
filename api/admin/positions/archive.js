// POST /api/admin/positions/archive
//
// Body: { id }
//
// Sets status='closed' and archived_at=now(). We deliberately do NOT physically
// delete: applications reference positions via FK and the admin panel still
// wants to render the position label for historical candidates. Unarchive is
// a sibling PATCH (status='active', archived_at=null) through the main detail
// endpoint.

const { supabaseAdmin } = require('../../../lib/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports.default = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const { id } = req.body || {};
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'invalid_id' });

  try {
    const { data, error } = await supabaseAdmin
      .from('positions')
      .update({
        status: 'closed',
        archived_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, slug, status, archived_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    return res.status(200).json({ ok: true, position: data });
  } catch (e) {
    console.error('[admin/positions/archive] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
