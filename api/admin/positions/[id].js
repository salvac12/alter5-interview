// GET   /api/admin/positions/[id]  → full position (prompts included)
// PATCH /api/admin/positions/[id]  → partial update
//
// Archive + delete-while-referenced are handled by the sibling archive.js
// route so the semantics stay explicit.

const { supabaseAdmin } = require('../../../lib/supabase');
const { validatePosition } = require('../../../lib/position-validation');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whitelist of PATCH-able columns. Anything outside this set is silently
// dropped so an attacker can't set e.g. created_at or archived_at via PATCH.
const PATCHABLE = new Set([
  'slug', 'title', 'subtitle', 'status', 'share_with_headhunters',
  'min_score_to_invite', 'public_intro_html',
  'cv_analysis_prompt', 'interview_system_prompt',
  'interview_blocks', 'interview_questions',
]);

async function getOne(id, res) {
  const { data, error } = await supabaseAdmin
    .from('positions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'not_found' });
  return res.status(200).json({ ok: true, position: data });
}

async function patch(id, req, res) {
  const body = req.body || {};
  const v = validatePosition(body, { requireAll: false });
  if (!v.ok) return res.status(400).json({ error: v.error });

  const update = {};
  for (const key of Object.keys(body)) {
    if (PATCHABLE.has(key)) update[key] = body[key];
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'no_patchable_fields' });
  }

  const { data, error } = await supabaseAdmin
    .from('positions')
    .update(update)
    .eq('id', id)
    .select('id, slug, title, status')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'slug_taken' });
    throw error;
  }
  if (!data) return res.status(404).json({ error: 'not_found' });
  return res.status(200).json({ ok: true, position: data });
}

module.exports.default = async function handler(req, res) {
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'invalid_id' });

  try {
    if (req.method === 'GET') return await getOne(id, res);
    if (req.method === 'PATCH') return await patch(id, req, res);
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    console.error('[admin/positions/[id]] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
