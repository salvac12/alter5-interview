// GET /api/cron/purge-expired
//
// Daily cron: calls purge_expired_applications() which soft-deletes + scrubs
// PII from any application whose 12-month retention window has elapsed.
//
// Protected by CRON_SECRET header. Vercel Cron sends
// `Authorization: Bearer <CRON_SECRET>` when configured.

const { supabaseAdmin } = require('../../lib/supabase');

module.exports.default = async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers?.authorization || '';
  if (!expected || auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('purge_expired_applications');
    if (error) throw error;
    const affected = typeof data === 'number' ? data : (data?.[0] ?? 0);
    console.log('[cron/purge-expired] affected:', affected);
    return res.status(200).json({ ok: true, affected });
  } catch (e) {
    console.error('[cron/purge-expired] error:', e.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
};
