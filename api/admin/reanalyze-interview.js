// POST /api/admin/reanalyze-interview
//
// Body: { interviewId }
// Regenerates the AI analysis for a completed interview.

const { supabaseAdmin } = require('../../lib/supabase');
const { analyzeInterview } = require('../../lib/interview-analysis');

module.exports.default = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const { interviewId } = req.body || {};
  if (!interviewId) return res.status(400).json({ error: 'missing_id' });

  try {
    const { data: iv, error: ierr } = await supabaseAdmin
      .from('interviews')
      .select('id, application_id')
      .eq('id', interviewId)
      .maybeSingle();
    if (ierr) throw ierr;
    if (!iv) return res.status(404).json({ error: 'not_found' });

    const { data: app } = await supabaseAdmin
      .from('applications')
      .select('name, experience')
      .eq('id', iv.application_id)
      .maybeSingle();

    const { data: answers } = await supabaseAdmin
      .from('interview_answers')
      .select('question_idx, question_key, question_type, answer_text, answer_options, time_sec, flag')
      .eq('interview_id', interviewId)
      .order('question_idx');

    const summaryText = (answers || []).map(a => {
      const ans = a.answer_text || (Array.isArray(a.answer_options) ? a.answer_options.join(', ') : '') || 'Sin respuesta';
      const mm = Math.floor((a.time_sec || 0) / 60);
      const ss = String((a.time_sec || 0) % 60).padStart(2, '0');
      return `[${a.question_key || ''}] ${a.question_type || ''}\nRespuesta: ${ans}\nTiempo: ${mm}:${ss}`;
    }).join('\n\n');

    const result = await analyzeInterview({
      name: app?.name || '',
      experience: app?.experience || '',
      summaryText,
    });
    if (!result.ok) return res.status(502).json({ error: result.error });

    await supabaseAdmin
      .from('interviews')
      .update({ ai_analysis_html: result.html })
      .eq('id', interviewId);

    return res.status(200).json({ ok: true, html: result.html });
  } catch (e) {
    console.error('[admin/reanalyze-interview] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
