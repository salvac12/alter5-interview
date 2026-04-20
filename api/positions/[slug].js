// GET /api/positions/[slug] — public endpoint used by /positions/<slug>
// landing pages. Returns only safe-to-expose fields; never the prompts or
// the interview_questions (those leak interview content to the world).

const { supabaseAdmin } = require('../../lib/supabase');

const SLUG_RE = /^[a-z0-9][a-z0-9\-]{1,40}$/;

module.exports.default = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const slug = req.query?.slug;
  if (!slug || !SLUG_RE.test(slug)) return res.status(400).json({ error: 'invalid_slug' });

  try {
    const { data, error } = await supabaseAdmin
      .from('positions')
      .select('slug, title, subtitle, status, public_intro_html')
      .eq('slug', slug)
      .is('archived_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (data.status !== 'active') return res.status(404).json({ error: 'not_available' });

    return res.status(200).json({ ok: true, position: data });
  } catch (e) {
    console.error('[positions/[slug]] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
