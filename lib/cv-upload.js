// Shared CV-upload pipeline.
//
// Used by every server-side caller that ingests a CV on behalf of a candidate
// (admin manual upload, the email_agent ingestion, the headhunter portal).
// The public /api/upload-cv flow used by candidates themselves still lives in
// its own handler because it sits behind the magic-link verify session and has
// a different consent posture.
//
// Responsibilities:
//   1. Validate the PDF buffer.
//   2. Resolve the candidate email — either prefilled by the caller or
//      extracted from the CV via the LLM.
//   3. Find or create the application row.
//   4. Persist the CV file in Storage + a `cvs` row.
//   5. Run analyze (or reuse the prefetch we did in step 2).
//   6. Persist analyses, transition the application status, optionally send
//      the interview invite email when the caller forces auto-invite.
//
// Returns: { ok: true, applicationId, score, recommendation, status,
//            interview_url } on success, or { ok: false, status, error,
//            detail? } on failure (status is the HTTP code the wrapper should
//            return).

const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase');
const { analyzeCv } = require('./cv-analysis');
const { generateToken, hashToken } = require('./tokens');
const { sendInterviewLinkEmail } = require('./email');
const { isValidEmail, normalizeEmail, isValidExperience } = require('./validation');

const INTERVIEW_TTL_DAYS = 7;
const ALLOWED_SOURCES = new Set(['admin_manual', 'email_agent', 'headhunter']);

async function processCvUpload({
  fileBase64,
  filename,
  source = 'admin_manual',
  prefilledEmail = null,
  prefilledName = null,
  prefilledExperience = null,
  headhunterId = null,
  uploaderNote = null,
  autoInvite = false,
  ip = null,
  userAgent = null,
  // Label used in application_events.actor / event_type.
  // 'admin' | 'agent' | 'headhunter'
  actor = 'admin',
}) {
  if (!fileBase64 || !filename) {
    return { ok: false, status: 400, error: 'missing_file' };
  }
  if (String(fileBase64).length > 7_500_000) {
    return { ok: false, status: 400, error: 'file_too_large' };
  }
  if (!ALLOWED_SOURCES.has(source)) {
    source = 'admin_manual';
  }

  let buf;
  try { buf = Buffer.from(fileBase64, 'base64'); }
  catch { return { ok: false, status: 400, error: 'invalid_base64' }; }

  if (buf.slice(0, 5).toString('ascii') !== '%PDF-') {
    return { ok: false, status: 400, error: 'invalid_pdf' };
  }

  const sizeBytes = buf.length;
  const contentHash = crypto.createHash('sha256').update(buf).digest('hex');

  // Sanitize filename before persisting/logging. The storage path is built
  // from the application id so traversal can't escape the bucket prefix,
  // but we still don't want `../../etc/passwd` ending up in cvs.filename
  // or in event audit data. Whitelist printable ASCII, keep the .pdf
  // extension visible, cap at 200 chars.
  const safeFilename = String(filename)
    .replace(/[^A-Za-z0-9._\- ]+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 200) || 'cv.pdf';

  // Resolve email — prefilled wins; otherwise extract from CV.
  let analysisPrefetched = null;
  let resolvedEmail = prefilledEmail && isValidEmail(prefilledEmail) ? prefilledEmail : null;
  if (!resolvedEmail) {
    analysisPrefetched = await analyzeCv({ fileBase64, filename });
    if (!analysisPrefetched.ok) {
      return { ok: false, status: 400, error: 'analysis_failed', detail: analysisPrefetched.error };
    }
    if (!analysisPrefetched.email || !isValidEmail(analysisPrefetched.email)) {
      return { ok: false, status: 400, error: 'email_not_found_in_cv' };
    }
    resolvedEmail = analysisPrefetched.email;
  }

  const normEmail = normalizeEmail(resolvedEmail);
  const eventType = `${actor}_upload`; // admin_upload, agent_upload, headhunter_upload

  // 1. Find or create application.
  let appRow;
  const { data: existing, error: findErr } = await supabaseAdmin
    .from('applications')
    .select('id, email, name, experience, source, headhunter_id')
    .eq('email', normEmail)
    .is('deleted_at', null)
    .maybeSingle();
  if (findErr) return { ok: false, status: 500, error: 'db_error', detail: findErr.message };

  if (existing) {
    appRow = existing;
    // Backfill headhunter_id if this candidate was first uploaded by a
    // partner (so the origin label sticks even if a later upload comes from
    // admin manual).
    if (headhunterId && !existing.headhunter_id) {
      await supabaseAdmin
        .from('applications')
        .update({ headhunter_id: headhunterId })
        .eq('id', existing.id);
      appRow.headhunter_id = headhunterId;
    }
  } else {
    const { data: created, error: cerr } = await supabaseAdmin
      .from('applications')
      .insert({
        email: normEmail,
        source,
        status: 'cv_uploaded',
        consent_privacy: true,
        consent_ai_decision: true,
        name: prefilledName || null,
        experience: isValidExperience(prefilledExperience) ? prefilledExperience : null,
        headhunter_id: headhunterId,
        apply_ip: ip,
        apply_user_agent: userAgent,
      })
      .select('id, email, name, experience, source, headhunter_id')
      .single();
    if (cerr) return { ok: false, status: 500, error: 'db_error', detail: cerr.message };
    appRow = created;
  }

  // 2. Upload PDF to Storage.
  const ts = Date.now();
  const storagePath = `${appRow.id}/${ts}.pdf`;
  const { error: uplErr } = await supabaseAdmin.storage
    .from('cvs')
    .upload(storagePath, buf, { contentType: 'application/pdf', upsert: false });
  if (uplErr) return { ok: false, status: 500, error: 'storage_error', detail: uplErr.message };

  const { data: cvRow, error: cverr } = await supabaseAdmin
    .from('cvs')
    .insert({
      application_id: appRow.id,
      storage_path: storagePath,
      filename: safeFilename,
      size_bytes: sizeBytes,
      content_hash: contentHash,
      uploader_note: uploaderNote ? String(uploaderNote).slice(0, 2000) : null,
    })
    .select('id').single();
  if (cverr) return { ok: false, status: 500, error: 'db_error', detail: cverr.message };

  await supabaseAdmin.from('application_events').insert({
    application_id: appRow.id,
    event_type: eventType,
    event_data: {
      filename: safeFilename,
      size_bytes: sizeBytes,
      headhunter_id: headhunterId,
      note: uploaderNote || null,
    },
    actor,
    ip,
    user_agent: userAgent,
  });

  // 3. Analyze (or reuse the email-extraction prefetch).
  const analysis = analysisPrefetched || await analyzeCv({ fileBase64, filename });

  const updateApp = { status: 'cv_uploaded', cv_uploaded_at: new Date().toISOString() };
  if (prefilledName && !appRow.name) updateApp.name = prefilledName;
  if (isValidExperience(prefilledExperience) && !appRow.experience) {
    updateApp.experience = prefilledExperience;
  }

  if (!analysis.ok) {
    await supabaseAdmin.from('applications').update(updateApp).eq('id', appRow.id);
    return {
      ok: true,
      status: 200,
      applicationId: appRow.id,
      analysis_error: analysis.error,
    };
  }

  await supabaseAdmin.from('analyses').insert({
    application_id: appRow.id,
    cv_id: cvRow.id,
    score: analysis.score,
    recommendation: analysis.recommendation,
    summary: analysis.summary,
    raw_response: analysis.raw,
    model: analysis.model,
  });

  updateApp.analyzed_at = new Date().toISOString();
  if (analysis.name && !appRow.name) updateApp.name = analysis.name;

  let nextStatus;
  let interviewUrl = null;

  if (autoInvite) {
    nextStatus = 'analyzed_manual_approved';
    const token = generateToken();
    const expiresAt = new Date(Date.now() + INTERVIEW_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await supabaseAdmin.from('magic_links').insert({
      application_id: appRow.id,
      purpose: 'interview',
      token_hash: hashToken(token),
      expires_at: expiresAt,
    });
    const baseUrl = process.env.INTERVIEW_BASE_URL || 'https://careers.alter-5.com';
    interviewUrl = `${baseUrl}/interview?token=${token}`;

    const mail = await sendInterviewLinkEmail({
      to: appRow.email,
      name: (updateApp.name || appRow.name || ''),
      interviewUrl,
      expiresDays: INTERVIEW_TTL_DAYS,
    });
    await supabaseAdmin.from('application_events').insert({
      application_id: appRow.id,
      event_type: 'interview_sent',
      event_data: { email_ok: mail.ok, email_id: mail.id || null, actor_reason: `${actor}_override` },
      actor,
    });
  } else if (analysis.score >= 4) {
    nextStatus = 'analyzed_pending_review';
  } else {
    nextStatus = 'analyzed_auto_rejected';
  }
  updateApp.status = nextStatus;

  await supabaseAdmin.from('applications').update(updateApp).eq('id', appRow.id);

  return {
    ok: true,
    status: 200,
    applicationId: appRow.id,
    score: analysis.score,
    recommendation: analysis.recommendation,
    appStatus: nextStatus,
    interview_url: interviewUrl,
  };
}

module.exports = { processCvUpload, INTERVIEW_TTL_DAYS };
