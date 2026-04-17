// GET /api/admin/cv-url?id=<cv_id>
//
// Returns a short-lived signed URL to download the candidate's CV.
// Admin-only (protected by Basic Auth in middleware).

const { supabaseAdmin } = require('../../lib/supabase');

const URL_TTL_SECONDS = 600; // 10 minutes

module.exports.default = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const id = req.query?.id;
  if (!id) return res.status(400).json({ error: 'missing_id' });

  try {
    const { data: cv, error } = await supabaseAdmin
      .from('cvs')
      .select('id, storage_path, filename')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!cv) return res.status(404).json({ error: 'not_found' });

    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from('cvs')
      .createSignedUrl(cv.storage_path, URL_TTL_SECONDS, { download: cv.filename });
    if (signErr) throw signErr;

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url: signed.signedUrl, expires_in: URL_TTL_SECONDS });
  } catch (e) {
    console.error('[admin/cv-url] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
