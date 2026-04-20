// GET /api/positions                        → all active positions (minimal)
// GET /api/positions?for_headhunters=1      → filter to share_with_headhunters=true
//
// Used by:
// - partners-upload.html to render the position dropdown in the headhunter
//   portal. `for_headhunters=1` is required there so a partner can't upload
//   a CV into a position we haven't explicitly opened to them.
// - (Future) a public /careers index page listing all open roles.

const { supabaseAdmin } = require('../../lib/supabase');

module.exports.default = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  try {
    let q = supabaseAdmin
      .from('positions')
      .select('id, slug, title, subtitle')
      .eq('status', 'active')
      .is('archived_at', null)
      .order('created_at', { ascending: false });

    if (req.query?.for_headhunters === '1') {
      q = q.eq('share_with_headhunters', true);
    }

    const { data, error } = await q;
    if (error) throw error;

    return res.status(200).json({ ok: true, positions: data || [] });
  } catch (e) {
    console.error('[positions/index] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
