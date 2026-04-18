// GET /api/cron/purge-expired
//
// Daily cron: scrubs PII from any application whose 12-month retention
// window has elapsed AND deletes the underlying CV PDFs from Storage.
//
// Order matters:
//   1. Snapshot the IDs of applications about to expire (before they get
//      scrubbed — once `email` is rewritten, we lose the easy way to
//      correlate them, but we still have the ID).
//   2. Call purge_expired_applications() RPC (soft-delete + scrub).
//   3. Delete the corresponding rows in `cvs` and the matching objects in
//      Storage. Best-effort: storage errors are logged but the job still
//      reports ok=true so Vercel doesn't endlessly retry.
//
// Protected by CRON_SECRET header. Vercel Cron sends
// `Authorization: Bearer <CRON_SECRET>` when configured.

const { supabaseAdmin } = require('../../lib/supabase');
const { deleteCvsForApps } = require('../../lib/cv-storage');

module.exports.default = async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers?.authorization || '';
  if (!expected || auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    // 1. Run the DB-side scrub first.
    const { data, error } = await supabaseAdmin.rpc('purge_expired_applications');
    if (error) throw error;
    const affected = typeof data === 'number' ? data : (data?.[0] ?? 0);

    // 2. Find every soft-deleted application that still has CV rows. This
    //    is intentionally based on POST-RPC state (not a pre-RPC snapshot)
    //    so we catch:
    //      - records the RPC just scrubbed in this run, AND
    //      - any orphans left behind by previous runs that crashed
    //        between the RPC and the storage delete (self-healing).
    //    The join through `cvs` keeps the result set bounded — we only
    //    scan apps that actually have files to clean, regardless of how
    //    long they have been soft-deleted.
    const { data: orphans, error: orphanErr } = await supabaseAdmin
      .from('cvs')
      .select('application_id, applications!inner(id, deleted_at)')
      .not('applications.deleted_at', 'is', null);
    if (orphanErr) throw orphanErr;

    const ids = Array.from(new Set((orphans || []).map(r => r.application_id)));

    let storageResult = { storage_deleted: 0, rows_deleted: 0, errors: [] };
    if (ids.length > 0) {
      try {
        storageResult = await deleteCvsForApps(ids);
        if (storageResult.errors.length > 0) {
          console.error('[cron/purge-expired] storage cleanup partial:', storageResult.errors);
        }
      } catch (storageErr) {
        console.error('[cron/purge-expired] storage cleanup failed:', storageErr.message);
        storageResult.errors.push({ stage: 'fatal', message: storageErr.message });
      }
    }

    console.log('[cron/purge-expired] affected:', affected, 'storage:', storageResult);
    return res.status(200).json({ ok: true, affected, storage: storageResult });
  } catch (e) {
    console.error('[cron/purge-expired] error:', e.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
};
