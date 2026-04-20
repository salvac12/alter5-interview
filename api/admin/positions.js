// GET /api/admin/positions        → list with counts
// POST /api/admin/positions        → create a new position
//
// The editor modal in admin.html posts the full position payload (prompts,
// blocks, questions). Validation happens server-side via lib/position-validation
// so a malformed JSON paste never lands in the DB.

const { supabaseAdmin } = require('../../lib/supabase');
const { validatePosition } = require('../../lib/position-validation');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
};

async function list(res) {
  const { data: rows, error } = await supabaseAdmin
    .from('positions')
    .select('id, slug, title, subtitle, status, share_with_headhunters, min_score_to_invite, created_at, updated_at, archived_at')
    .order('created_at', { ascending: false });
  if (error) throw error;

  // Per-position candidate count. Small list → one extra round-trip is fine.
  const ids = rows.map(r => r.id);
  const counts = {};
  const lastAppAt = {};
  if (ids.length) {
    const { data: appRows } = await supabaseAdmin
      .from('applications')
      .select('position_id, created_at')
      .in('position_id', ids)
      .is('deleted_at', null);
    for (const a of appRows || []) {
      counts[a.position_id] = (counts[a.position_id] || 0) + 1;
      if (!lastAppAt[a.position_id] || a.created_at > lastAppAt[a.position_id]) {
        lastAppAt[a.position_id] = a.created_at;
      }
    }
  }

  return res.status(200).json({
    ok: true,
    positions: rows.map(r => ({
      ...r,
      candidates_count: counts[r.id] || 0,
      last_application_at: lastAppAt[r.id] || null,
    })),
  });
}

async function create(req, res) {
  const payload = req.body || {};
  const v = validatePosition(payload, { requireAll: true });
  if (!v.ok) return res.status(400).json({ error: v.error });

  const insert = {
    slug: payload.slug,
    title: payload.title,
    subtitle: payload.subtitle || null,
    status: payload.status || 'active',
    share_with_headhunters: !!payload.share_with_headhunters,
    min_score_to_invite: payload.min_score_to_invite ?? 7,
    public_intro_html: payload.public_intro_html || null,
    cv_analysis_prompt: payload.cv_analysis_prompt,
    interview_system_prompt: payload.interview_system_prompt,
    interview_blocks: payload.interview_blocks,
    interview_questions: payload.interview_questions,
  };

  const { data, error } = await supabaseAdmin
    .from('positions')
    .insert(insert)
    .select('id, slug, title, status')
    .single();
  if (error) {
    // 23505 = unique_violation (slug)
    if (error.code === '23505') return res.status(409).json({ error: 'slug_taken' });
    throw error;
  }
  return res.status(201).json({ ok: true, position: data });
}

module.exports.default = async function handler(req, res) {
  try {
    if (req.method === 'GET') return await list(res);
    if (req.method === 'POST') return await create(req, res);
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    console.error('[admin/positions] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
