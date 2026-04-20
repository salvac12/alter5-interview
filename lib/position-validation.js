// Validators for the prompt-as-data surface of `positions`.
//
// An admin pastes JSON blobs into the editor modal. A malformed block/question
// shape would render `interview.html` unusable for every candidate assigned
// to that position, so we fail the write at the API boundary rather than
// catching it downstream.
//
// Rules are deliberately tight — if an admin wants something the schema
// doesn't allow, that's a v2 conversation, not a schema bypass.

const SLUG_RE = /^[a-z0-9][a-z0-9\-]{1,40}$/;
const STATUSES = new Set(['active', 'paused', 'closed']);
const QUESTION_TYPES = new Set(['single', 'multi', 'salary']);

function isNonEmptyString(v, max = 10000) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { ok: false, error: 'blocks_must_be_non_empty_array' };
  }
  if (blocks.length > 20) {
    return { ok: false, error: 'too_many_blocks' };
  }
  const seen = new Set();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || typeof b !== 'object') {
      return { ok: false, error: `block_${i}_invalid_shape` };
    }
    if (!isNonEmptyString(b.id, 40) || !/^[a-z0-9_\-]+$/.test(b.id)) {
      return { ok: false, error: `block_${i}_invalid_id` };
    }
    if (seen.has(b.id)) {
      return { ok: false, error: `block_${i}_duplicate_id:${b.id}` };
    }
    seen.add(b.id);
    if (!isNonEmptyString(b.label, 80)) {
      return { ok: false, error: `block_${i}_invalid_label` };
    }
    if (!isNonEmptyString(b.icon, 10)) {
      return { ok: false, error: `block_${i}_invalid_icon` };
    }
    if (!isNonEmptyString(b.desc, 400)) {
      return { ok: false, error: `block_${i}_invalid_desc` };
    }
  }
  return { ok: true, blockIds: seen };
}

function validateQuestions(questions, blockIds) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: 'questions_must_be_non_empty_array' };
  }
  if (questions.length > 50) {
    return { ok: false, error: 'too_many_questions' };
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== 'object') {
      return { ok: false, error: `question_${i}_invalid_shape` };
    }
    if (!isNonEmptyString(q.block, 40) || !blockIds.has(q.block)) {
      return { ok: false, error: `question_${i}_unknown_block:${q.block}` };
    }
    if (!QUESTION_TYPES.has(q.type)) {
      return { ok: false, error: `question_${i}_invalid_type:${q.type}` };
    }
    if (!Number.isInteger(q.w) || q.w < 1 || q.w > 5) {
      return { ok: false, error: `question_${i}_invalid_weight` };
    }
    if (!isNonEmptyString(q.text, 2000)) {
      return { ok: false, error: `question_${i}_invalid_text` };
    }
    if (q.hint !== undefined && q.hint !== null && typeof q.hint !== 'string') {
      return { ok: false, error: `question_${i}_invalid_hint` };
    }
    if (q.hint && q.hint.length > 1000) {
      return { ok: false, error: `question_${i}_hint_too_long` };
    }
    if (!Number.isInteger(q.min) || q.min < 0 || q.min > 600) {
      return { ok: false, error: `question_${i}_invalid_min` };
    }
    if (!Number.isInteger(q.sus) || q.sus < 0 || q.sus > 3600) {
      return { ok: false, error: `question_${i}_invalid_sus` };
    }

    if (q.type === 'salary') {
      // No options, no correct.
      if (q.options !== undefined && q.options !== null) {
        return { ok: false, error: `question_${i}_salary_must_not_have_options` };
      }
      continue;
    }

    // single or multi → need options.
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 10) {
      return { ok: false, error: `question_${i}_invalid_options_count` };
    }
    for (let j = 0; j < q.options.length; j++) {
      if (!isNonEmptyString(q.options[j], 500)) {
        return { ok: false, error: `question_${i}_option_${j}_invalid` };
      }
    }
    if (q.type === 'single') {
      if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) {
        // `correct` is optional ONLY for the motivation block (no scoring).
        // Motivation block is identified by block id === 'motivation' — if the
        // admin wants a non-scored single question in a different block they
        // must still put it under block id 'motivation' or accept scoring.
        if (q.block !== 'motivation' || q.correct !== undefined) {
          return { ok: false, error: `question_${i}_invalid_correct` };
        }
      }
    }
    // multi questions never have `correct` (no "right answer" — multi is
    // used for self-report style questions like frameworks worked with).
    if (q.type === 'multi' && q.correct !== undefined) {
      return { ok: false, error: `question_${i}_multi_must_not_have_correct` };
    }
  }
  return { ok: true };
}

// Top-level validator for the full position payload. Used by POST create and
// by PATCH whenever the caller sends a field we care about.
function validatePosition(payload, { requireAll = false } = {}) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'invalid_payload' };
  }

  if (requireAll || payload.slug !== undefined) {
    if (typeof payload.slug !== 'string' || !SLUG_RE.test(payload.slug)) {
      return { ok: false, error: 'invalid_slug' };
    }
  }
  if (requireAll || payload.title !== undefined) {
    if (!isNonEmptyString(payload.title, 200)) {
      return { ok: false, error: 'invalid_title' };
    }
  }
  if (payload.subtitle !== undefined && payload.subtitle !== null) {
    if (typeof payload.subtitle !== 'string' || payload.subtitle.length > 200) {
      return { ok: false, error: 'invalid_subtitle' };
    }
  }
  if (payload.status !== undefined) {
    if (!STATUSES.has(payload.status)) {
      return { ok: false, error: 'invalid_status' };
    }
  }
  if (payload.share_with_headhunters !== undefined) {
    if (typeof payload.share_with_headhunters !== 'boolean') {
      return { ok: false, error: 'invalid_share_with_headhunters' };
    }
  }
  if (payload.min_score_to_invite !== undefined) {
    if (!Number.isInteger(payload.min_score_to_invite)
        || payload.min_score_to_invite < 1
        || payload.min_score_to_invite > 10) {
      return { ok: false, error: 'invalid_min_score_to_invite' };
    }
  }
  if (payload.public_intro_html !== undefined && payload.public_intro_html !== null) {
    if (typeof payload.public_intro_html !== 'string' || payload.public_intro_html.length > 50000) {
      return { ok: false, error: 'invalid_public_intro_html' };
    }
  }
  if (requireAll || payload.cv_analysis_prompt !== undefined) {
    if (!isNonEmptyString(payload.cv_analysis_prompt, 30000)) {
      return { ok: false, error: 'invalid_cv_analysis_prompt' };
    }
  }
  if (requireAll || payload.interview_system_prompt !== undefined) {
    if (!isNonEmptyString(payload.interview_system_prompt, 30000)) {
      return { ok: false, error: 'invalid_interview_system_prompt' };
    }
  }

  // Blocks + questions must be validated together — questions reference block
  // ids. If the caller is sending one but not the other, we cannot safely
  // partial-validate, so reject the PATCH.
  const hasBlocks = payload.interview_blocks !== undefined;
  const hasQuestions = payload.interview_questions !== undefined;
  if (requireAll || hasBlocks || hasQuestions) {
    if (!hasBlocks || !hasQuestions) {
      return { ok: false, error: 'blocks_and_questions_must_be_sent_together' };
    }
    const blocksResult = validateBlocks(payload.interview_blocks);
    if (!blocksResult.ok) return blocksResult;
    const qResult = validateQuestions(payload.interview_questions, blocksResult.blockIds);
    if (!qResult.ok) return qResult;
  }

  return { ok: true };
}

module.exports = {
  validateBlocks,
  validateQuestions,
  validatePosition,
  SLUG_RE,
};
