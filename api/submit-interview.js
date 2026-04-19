// POST /api/submit-interview
//
// Persists a completed interview to Supabase.
// Body: { token, globalScore, dimScores, flags, totalTimeSec, verdict,
//         salary, answers: [{idx, key, type, text, options, time, flag,
//                            pasteCount, pasteChars, tabSwitches, burstCount, aiFlags}] }
//
// Validates the interview magic link, marks it used, creates an interviews
// row plus interview_answers. Triggers AI analysis asynchronously (best-effort).
// Returns { ok, interviewId, analysis } where analysis is HTML or null.

const { supabaseAdmin } = require('../lib/supabase');
const { hashToken, isValidTokenFormat } = require('../lib/tokens');
const { getClientIp, getUserAgent } = require('../lib/validation');
const { analyzeInterview } = require('../lib/interview-analysis');
const { sanitizeHtml } = require('../lib/sanitize-html');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
};

const ALLOWED_FLAGS = new Set(['ok', 'fast', 'susp', 'multiwork']);

function sanitizeStr(v, max = 5000) {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

module.exports.default = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const body = req.body || {};
  const { token } = body;
  if (!token || !isValidTokenFormat(token)) {
    return res.status(400).json({ error: 'invalid_token' });
  }
  if (!Array.isArray(body.answers) || body.answers.length === 0 || body.answers.length > 100) {
    return res.status(400).json({ error: 'invalid_answers' });
  }

  const ip = getClientIp(req);
  const ua = getUserAgent(req);

  try {
    // 1. Validate magic link.
    const { data: link, error: linkErr } = await supabaseAdmin
      .from('magic_links')
      .select('id, application_id, expires_at, used_at, purpose')
      .eq('token_hash', hashToken(token))
      .eq('purpose', 'interview')
      .maybeSingle();
    if (linkErr) throw linkErr;
    if (!link) return res.status(401).json({ error: 'not_found' });
    if (link.used_at) return res.status(409).json({ error: 'already_used' });
    if (new Date(link.expires_at) < new Date()) {
      return res.status(410).json({ error: 'expired' });
    }

    const appId = link.application_id;

    const { data: app, error: appErr } = await supabaseAdmin
      .from('applications')
      .select('id, name, experience, status, deleted_at, source')
      .eq('id', appId)
      .maybeSingle();
    if (appErr) throw appErr;
    if (!app || app.deleted_at) return res.status(404).json({ error: 'application_not_found' });

    // 2. Insert interview row.
    const skippedCount = body.answers.filter(a => a.skipped).length;
    const answersCount = body.answers.length - skippedCount;

    const { data: interview, error: ivErr } = await supabaseAdmin
      .from('interviews')
      .insert({
        application_id: appId,
        global_score: Number.isFinite(body.globalScore) ? Math.min(10, Math.max(0, body.globalScore)) : null,
        dim_scores: body.dimScores || null,
        flags: Number.isFinite(body.flags) ? Math.max(0, Math.floor(body.flags)) : 0,
        answers_count: answersCount,
        skipped_count: skippedCount,
        total_time_sec: Number.isFinite(body.totalTimeSec) ? Math.max(0, Math.floor(body.totalTimeSec)) : 0,
        verdict: sanitizeStr(body.verdict, 200),
        salary: sanitizeStr(body.salary, 200),
        source: app.source || 'public',
        started_at: body.startedAt ? new Date(body.startedAt).toISOString() : null,
        completed_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (ivErr) throw ivErr;

    // 3. Insert per-answer rows.
    const answerRows = body.answers.slice(0, 100).map((a, i) => {
      const flag = ALLOWED_FLAGS.has(a.flag) ? a.flag : 'ok';
      const options = Array.isArray(a.options)
        ? a.options.slice(0, 20).map(o => String(o).slice(0, 500))
        : null;
      const aiFlags = Array.isArray(a.aiFlags)
        ? a.aiFlags.slice(0, 20).map(f => String(f).slice(0, 300))
        : null;
      return {
        interview_id: interview.id,
        question_idx: Number.isFinite(a.idx) ? a.idx : i,
        question_key: sanitizeStr(a.key, 100),
        question_type: sanitizeStr(a.type, 20),
        answer_text: sanitizeStr(a.text, 10000),
        answer_options: options,
        time_sec: Number.isFinite(a.time) ? Math.max(0, Math.floor(a.time)) : 0,
        flag,
        paste_count: Number.isFinite(a.pasteCount) ? Math.max(0, Math.floor(a.pasteCount)) : 0,
        paste_chars: Number.isFinite(a.pasteChars) ? Math.max(0, Math.floor(a.pasteChars)) : 0,
        tab_switches: Number.isFinite(a.tabSwitches) ? Math.max(0, Math.floor(a.tabSwitches)) : 0,
        burst_count: Number.isFinite(a.burstCount) ? Math.max(0, Math.floor(a.burstCount)) : 0,
        copy_blocked: Number.isFinite(a.copyBlocked) ? Math.max(0, Math.floor(a.copyBlocked)) : 0,
        right_click_blocked: Number.isFinite(a.rightClickBlocked) ? Math.max(0, Math.floor(a.rightClickBlocked)) : 0,
        shortcut_blocked: Number.isFinite(a.shortcutBlocked) ? Math.max(0, Math.floor(a.shortcutBlocked)) : 0,
        drag_blocked: Number.isFinite(a.dragBlocked) ? Math.max(0, Math.floor(a.dragBlocked)) : 0,
        ai_flags: aiFlags,
      };
    });

    const { error: ansErr } = await supabaseAdmin.from('interview_answers').insert(answerRows);
    if (ansErr) throw ansErr;

    // 4. Mark link used + update application status.
    await supabaseAdmin
      .from('magic_links')
      .update({ used_at: new Date().toISOString() })
      .eq('id', link.id);

    await supabaseAdmin
      .from('applications')
      .update({
        status: 'interview_completed',
        interview_started_at: app.interview_started_at || new Date().toISOString(),
        interview_completed_at: new Date().toISOString(),
      })
      .eq('id', appId);

    await supabaseAdmin.from('application_events').insert({
      application_id: appId,
      event_type: 'interview_completed',
      event_data: {
        interview_id: interview.id,
        global_score: body.globalScore,
        flags: body.flags,
        answers_count: answersCount,
      },
      actor: 'candidate',
      ip,
      user_agent: ua,
    });

    // 5. Best-effort inline AI analysis. If it fails or times out, admin can rerun later.
    try {
      const summaryText = body.answers.map(a => {
        const block = a.blockLabel || a.key || 'General';
        let ans = a.skipped ? 'Omitida' : (a.text || (Array.isArray(a.options) ? a.options.join(', ') : '')) || 'Sin respuesta';
        const mm = Math.floor((a.time || 0) / 60);
        const ss = String((a.time || 0) % 60).padStart(2, '0');
        // Surface the anti-extraction signals inline per-question so the
        // grader can correlate "tried to copy the question" with "then gave
        // a suspiciously polished answer" — the strongest AI-cheating tell
        // we have short of keystroke playback.
        const sig = [];
        if (a.pasteCount > 0) sig.push(`pegó ${a.pasteCount}x (${a.pasteChars} chars)`);
        if (a.copyBlocked > 0) sig.push(`intentó copiar ${a.copyBlocked}x (bloqueado)`);
        if (a.rightClickBlocked > 0) sig.push(`click derecho ${a.rightClickBlocked}x (bloqueado)`);
        if (a.shortcutBlocked > 0) sig.push(`atajos Cmd/Ctrl ${a.shortcutBlocked}x (bloqueado)`);
        if (a.dragBlocked > 0) sig.push(`drag ${a.dragBlocked}x (bloqueado)`);
        if (a.tabSwitches > 0) sig.push(`cambió pestaña ${a.tabSwitches}x`);
        if (a.burstCount > 10) sig.push(`escritura en ráfaga (${a.burstCount})`);
        const sigLine = sig.length ? `\nSeñales: ${sig.join(' · ')}` : '';
        return `[${block}] ${a.questionText || ''}\nRespuesta: ${ans}\nTiempo: ${mm}:${ss}${sigLine}`;
      }).join('\n\n');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);
      const analysis = await analyzeInterview({
        name: app.name || '',
        experience: app.experience || '',
        summaryText,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (analysis.ok) {
        // Sanitize at WRITE time so admin/reports HTML is always trusted
        // when read. A prompt injection inside a candidate answer cannot
        // smuggle <script> or onerror= past this allowlist.
        const safeHtml = sanitizeHtml(analysis.html);
        await supabaseAdmin
          .from('interviews')
          .update({ ai_analysis_html: safeHtml })
          .eq('id', interview.id);
      } else {
        await supabaseAdmin.from('application_events').insert({
          application_id: appId,
          event_type: 'interview_analysis_failed',
          event_data: { error: analysis.error, interview_id: interview.id },
          actor: 'system',
        });
      }
    } catch (aiErr) {
      console.error('[submit-interview] analysis error:', aiErr.message);
    }

    return res.status(200).json({ ok: true, interviewId: interview.id });
  } catch (e) {
    console.error('[submit-interview] error:', e.message, e.stack);
    return res.status(500).json({ error: 'internal_error' });
  }
};
