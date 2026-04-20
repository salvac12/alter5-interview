// POST /api/upload-cv
//
// Session-gated (candidate cookie from /apply/verify).
// Steps:
//   1. Validate session + payload
//   2. Write PDF to Supabase Storage (bucket 'cvs')
//   3. Insert cvs row
//   4. Call Claude for CV analysis
//   5. Insert analyses row
//   6. Route by score:
//      - >=4: status=analyzed_pending_review (admin decides whether to invite)
//      - <=3: status=analyzed_auto_rejected (silent)
//   7. Always respond "ok" — do not leak score.
//
// Note: auto-invitation for high scores was removed on purpose. All qualifying
// candidates now go through manual admin review before an interview link is
// emailed. The admin panel's review queue surfaces the score; approval there
// creates the magic link and sends the email via /api/admin/review-decision.
//
// Max body ~8MB to fit base64-encoded PDFs up to ~5.5MB.

const crypto = require('crypto');
const { supabaseAdmin } = require('../lib/supabase');
const { getSession, clearCookieHeader } = require('../lib/session');
const { analyzeCv } = require('../lib/cv-analysis');
const { getPositionByApplication } = require('../lib/positions');
const { getClientIp, getUserAgent } = require('../lib/validation');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '8mb' } },
};

module.exports.default = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = getSession(req);
  if (!session || !session.app_id) {
    return res.status(401).json({ error: 'session_expired' });
  }

  const { fileBase64, filename, experience } = req.body || {};
  if (!fileBase64 || !filename) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (String(filename).length > 255) {
    return res.status(400).json({ error: 'filename_too_long' });
  }
  if (String(fileBase64).length > 7_500_000) {
    return res.status(400).json({ error: 'file_too_large', message: 'Max 5 MB' });
  }
  // Decode once, compute size + hash.
  let buf;
  try {
    buf = Buffer.from(fileBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid_base64' });
  }
  const sizeBytes = buf.length;
  const contentHash = crypto.createHash('sha256').update(buf).digest('hex');

  // Verify PDF magic bytes.
  const isPDF = buf.slice(0, 5).toString('ascii') === '%PDF-';
  if (!isPDF) {
    return res.status(400).json({ error: 'invalid_pdf' });
  }

  const appId = session.app_id;
  const ip = getClientIp(req);
  const ua = getUserAgent(req);

  try {
    // Confirm application still exists and is in a state that allows upload.
    const { data: app, error: selErr } = await supabaseAdmin
      .from('applications')
      .select('id, email, status, deleted_at')
      .eq('id', appId)
      .maybeSingle();
    if (selErr) throw selErr;
    if (!app || app.deleted_at) return res.status(404).json({ error: 'application_not_found' });
    if (!['verified', 'cv_uploaded', 'analyzed_pending_review', 'analyzed_auto_rejected'].includes(app.status)) {
      return res.status(409).json({ error: 'invalid_state', state: app.status });
    }

    // 1. Upload to Storage.
    const ts = Date.now();
    const storagePath = `${appId}/${ts}.pdf`;
    const { error: uplErr } = await supabaseAdmin.storage
      .from('cvs')
      .upload(storagePath, buf, {
        contentType: 'application/pdf',
        upsert: false,
      });
    if (uplErr) {
      console.error('[upload-cv] storage error:', uplErr);
      throw new Error('storage_upload_failed');
    }

    // 2. Insert cv row.
    const { data: cvRow, error: cvErr } = await supabaseAdmin
      .from('cvs')
      .insert({
        application_id: appId,
        storage_path: storagePath,
        filename: String(filename).slice(0, 255),
        size_bytes: sizeBytes,
        content_hash: contentHash,
      })
      .select('id')
      .single();
    if (cvErr) throw cvErr;

    await supabaseAdmin
      .from('applications')
      .update({ status: 'cv_uploaded', cv_uploaded_at: new Date().toISOString() })
      .eq('id', appId);

    await supabaseAdmin.from('application_events').insert({
      application_id: appId,
      event_type: 'cv_uploaded',
      event_data: { filename, size_bytes: sizeBytes, content_hash: contentHash },
      actor: 'candidate',
      ip,
      user_agent: ua,
    });

    // 3. Analyze with Claude (reuses the base64 already in memory).
    //    Load the position-specific prompt so the LLM judges the candidate
    //    against THIS funnel's criteria, not a generic template.
    const position = await getPositionByApplication(appId);
    const analysis = await analyzeCv({
      fileBase64,
      filename,
      systemPrompt: position?.cv_analysis_prompt || null,
    });
    if (!analysis.ok) {
      console.error('[upload-cv] analysis error:', analysis.error);
      await supabaseAdmin.from('application_events').insert({
        application_id: appId,
        event_type: 'cv_analysis_failed',
        event_data: { error: analysis.error },
        actor: 'system',
      });
      // We still succeed from the candidate's perspective; admin will re-run.
      return res.status(200).json({ ok: true, status: 'received' });
    }

    const { data: analysisRow, error: anErr } = await supabaseAdmin
      .from('analyses')
      .insert({
        application_id: appId,
        cv_id: cvRow.id,
        score: analysis.score,
        recommendation: analysis.recommendation,
        summary: analysis.summary,
        raw_response: analysis.raw,
        model: analysis.model,
      })
      .select('id')
      .single();
    if (anErr) throw anErr;

    // 4. Persist candidate name + experience if we extracted them.
    const updateApp = { analyzed_at: new Date().toISOString() };
    if (analysis.name) updateApp.name = analysis.name;
    if (experience && ['3-5', '5-8', '8-12', '12+'].includes(experience)) {
      updateApp.experience = experience;
    }

    // 5. Route by score. High scorers now wait for admin approval instead of
    //    being auto-invited — admin reviews the score and sends the interview
    //    link manually from the admin panel (/api/admin/review-decision).
    const nextStatus = analysis.score >= 4
      ? 'analyzed_pending_review'
      : 'analyzed_auto_rejected';
    updateApp.status = nextStatus;

    await supabaseAdmin.from('applications').update(updateApp).eq('id', appId);

    await supabaseAdmin.from('application_events').insert({
      application_id: appId,
      event_type: 'cv_analyzed',
      event_data: {
        score: analysis.score,
        recommendation: analysis.recommendation,
        routed_to: nextStatus,
        analysis_id: analysisRow.id,
      },
      actor: 'system',
    });

    // 6. Clear candidate session cookie (upload flow is done).
    res.setHeader('Set-Cookie', clearCookieHeader());
    return res.status(200).json({ ok: true, status: 'received' });
  } catch (e) {
    console.error('[upload-cv] error:', e.message, e.stack);
    return res.status(500).json({ error: 'internal_error' });
  }
};
