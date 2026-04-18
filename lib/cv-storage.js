// Helpers for deleting CV files from Supabase Storage.
//
// The DB-side soft-delete (arco_delete_application / purge_expired_applications)
// scrubs PII from the `applications` row but cannot reach storage.objects.
// For GDPR Art.17 compliance we must also delete the underlying PDF binaries
// AND the `cvs` metadata rows (which contain the original filename — itself
// PII for some candidates).

const { supabaseAdmin } = require('./supabase');

const BUCKET = 'cvs';

// Removes every storage object + cvs row associated with a list of app IDs.
// Returns { storage_deleted, rows_deleted, errors[] }. Best-effort: a
// failure to remove a storage object is logged but does not throw, since
// the DB-side scrub may already have completed.
async function deleteCvsForApps(appIds) {
  const out = { storage_deleted: 0, rows_deleted: 0, errors: [] };
  if (!Array.isArray(appIds) || appIds.length === 0) return out;

  const { data: cvs, error: selErr } = await supabaseAdmin
    .from('cvs')
    .select('id, storage_path, application_id')
    .in('application_id', appIds);
  if (selErr) {
    out.errors.push({ stage: 'select_cvs', message: selErr.message });
    return out;
  }
  if (!cvs || cvs.length === 0) return out;

  const paths = cvs.map(c => c.storage_path).filter(Boolean);
  if (paths.length > 0) {
    // Supabase remove() handles up to 1000 paths per call.
    const chunks = [];
    for (let i = 0; i < paths.length; i += 500) chunks.push(paths.slice(i, i + 500));
    for (const chunk of chunks) {
      const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove(chunk);
      if (rmErr) {
        out.errors.push({ stage: 'storage_remove', message: rmErr.message });
      } else {
        out.storage_deleted += chunk.length;
      }
    }
  }

  const ids = cvs.map(c => c.id);
  const { error: delErr, count } = await supabaseAdmin
    .from('cvs')
    .delete({ count: 'exact' })
    .in('id', ids);
  if (delErr) {
    out.errors.push({ stage: 'delete_rows', message: delErr.message });
  } else {
    // Trust `count` when present (including 0). Fall back to ids.length
    // ONLY if Supabase returned `null`/`undefined` for count (older client
    // versions). The previous `count || ids.length` reported a false
    // positive when zero rows actually got deleted.
    out.rows_deleted = (count == null) ? ids.length : count;
  }
  return out;
}

async function deleteCvsForApp(appId) {
  return deleteCvsForApps([appId]);
}

module.exports = { deleteCvsForApp, deleteCvsForApps, BUCKET };
