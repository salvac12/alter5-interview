// GET /api/admin/stats
//
// Aggregates funnel + distribution metrics for /reports.

const { supabaseAdmin } = require('../../lib/supabase');

module.exports.default = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  try {
    // Status counts
    const { data: apps } = await supabaseAdmin
      .from('applications')
      .select('id, status, source, created_at, analyzed_at, interview_completed_at')
      .is('deleted_at', null);

    const statusCounts = {};
    const sourceCounts = {};
    let byMonth = {};
    for (const a of apps || []) {
      statusCounts[a.status] = (statusCounts[a.status] || 0) + 1;
      sourceCounts[a.source] = (sourceCounts[a.source] || 0) + 1;
      const month = (a.created_at || '').slice(0, 7); // YYYY-MM
      if (month) byMonth[month] = (byMonth[month] || 0) + 1;
    }

    const total = (apps || []).length;
    const funnel = {
      applied: total,
      verified: ['verified', 'cv_uploaded', 'analyzed_pending_review', 'analyzed_auto_invited', 'analyzed_auto_rejected', 'analyzed_manual_approved', 'analyzed_manual_rejected', 'interview_started', 'interview_completed']
        .reduce((s, k) => s + (statusCounts[k] || 0), 0),
      cv_uploaded: ['cv_uploaded', 'analyzed_pending_review', 'analyzed_auto_invited', 'analyzed_auto_rejected', 'analyzed_manual_approved', 'analyzed_manual_rejected', 'interview_started', 'interview_completed']
        .reduce((s, k) => s + (statusCounts[k] || 0), 0),
      analyzed: ['analyzed_pending_review', 'analyzed_auto_invited', 'analyzed_auto_rejected', 'analyzed_manual_approved', 'analyzed_manual_rejected', 'interview_started', 'interview_completed']
        .reduce((s, k) => s + (statusCounts[k] || 0), 0),
      invited: ['analyzed_auto_invited', 'analyzed_manual_approved', 'interview_started', 'interview_completed']
        .reduce((s, k) => s + (statusCounts[k] || 0), 0),
      interview_completed: statusCounts['interview_completed'] || 0,
    };

    // CV score distribution
    const { data: analyses } = await supabaseAdmin
      .from('analyses')
      .select('score');
    const scoreHist = Array(10).fill(0);
    for (const a of analyses || []) {
      const s = Math.min(10, Math.max(1, parseInt(a.score) || 1));
      scoreHist[s - 1]++;
    }

    // Interview metrics
    const { data: ivs } = await supabaseAdmin
      .from('interviews')
      .select('global_score, flags, final_score, recommendation, completed_at');
    const ivScores = (ivs || []).filter(i => i.global_score != null).map(i => Number(i.global_score));
    const ivAvg = ivScores.length ? (ivScores.reduce((a, b) => a + b, 0) / ivScores.length) : null;
    const ivFlags = (ivs || []).reduce((s, i) => s + (i.flags || 0), 0);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      total,
      funnel,
      status_counts: statusCounts,
      source_counts: sourceCounts,
      by_month: byMonth,
      cv_score_histogram: scoreHist,
      interview_avg_score: ivAvg,
      interview_flags_total: ivFlags,
      interviews_completed: (ivs || []).length,
    });
  } catch (e) {
    console.error('[admin/stats] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
