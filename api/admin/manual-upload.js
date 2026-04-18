// POST /api/admin/manual-upload
//
// Superadmin-only: uploads a CV on behalf of a candidate (source='admin_manual').
// Creates application + uploads CV + analyzes + routes. Behind Basic Auth via middleware.
//
// Body: { email, name?, experience?, fileBase64, filename, autoInvite? }
// Score-based auto-invite was removed — candidates with score>=4 land in the
// review queue for manual approval. Only the explicit `autoInvite` flag (from
// the admin's "Invitar siempre" checkbox) forces an immediate invitation.

const crypto = require('crypto');
const { supabaseAdmin } = require('../../lib/supabase');
const { analyzeCv } = require('../../lib/cv-analysis');
const { generateToken, hashToken } = require('../../lib/tokens');
const { sendInterviewLinkEmail } = require('../../lib/email');
const { isValidEmail, normalizeEmail, getClientIp, getUserAgent, isValidExperience } = require('../../lib/validation');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '8mb' } },
};

const INTERVIEW_TTL_DAYS = 7;

module.exports.default = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { email, name, experience, fileBase64, filename, autoInvite, source } = req.body || {};

  // Whitelist of allowed source overrides. Prevents callers from spoofing
  // arbitrary values via the API. Defaults to 'admin_manual' for every
  // request that doesn't match an allowed source. The value must also exist
  // in the application_source Postgres enum — see the paired migration
  // 20260418150000_email_agent_source.sql.
  const ALLOWED_SOURCES = new Set(['email_agent']);
  const resolvedSource = ALLOWED_SOURCES.has(source) ? source : 'admin_manual';

  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });
  if (!fileBase64 || !filename) return res.status(400).json({ error: 'missing_file' });
  if (String(fileBase64).length > 7_500_000) return res.status(400).json({ error: 'file_too_large' });

  const normEmail = normalizeEmail(email);
  let buf;
  try { buf = Buffer.from(fileBase64, 'base64'); }
  catch { return res.status(400).json({ error: 'invalid_base64' }); }

  if (buf.slice(0, 5).toString('ascii') !== '%PDF-') {
    return res.status(400).json({ error: 'invalid_pdf' });
  }

  const sizeBytes = buf.length;
  const contentHash = crypto.createHash('sha256').update(buf).digest('hex');
  const ip = getClientIp(req);
  const ua = getUserAgent(req);

  try {
    // Find or create application.
    // We only need a handful of fields downstream — don't pull the whole
    // PII-laden row just to check existence.
    let appRow;
    const { data: existing } = await supabaseAdmin
      .from('applications')
      .select('id, email, name, experience')
      .eq('email', normEmail)
      .is('deleted_at', null)
      .maybeSingle();

    if (existing) {
      appRow = existing;
    } else {
      const { data: created, error: cerr } = await supabaseAdmin
        .from('applications')
        .insert({
          email: normEmail,
          source: resolvedSource,
          status: 'cv_uploaded',
          consent_privacy: true,
          consent_ai_decision: true,
          name: name || null,
          experience: isValidExperience(experience) ? experience : null,
          apply_ip: ip,
          apply_user_agent: ua,
        })
        .select('id, email, name, experience')
        .single();
      if (cerr) throw cerr;
      appRow = created;
    }

    // Upload to Storage.
    const ts = Date.now();
    const storagePath = `${appRow.id}/${ts}.pdf`;
    const { error: uplErr } = await supabaseAdmin.storage
      .from('cvs')
      .upload(storagePath, buf, { contentType: 'application/pdf', upsert: false });
    if (uplErr) throw uplErr;

    const { data: cvRow, error: cverr } = await supabaseAdmin
      .from('cvs')
      .insert({
        application_id: appRow.id,
        storage_path: storagePath,
        filename: String(filename).slice(0, 255),
        size_bytes: sizeBytes,
        content_hash: contentHash,
      })
      .select('id').single();
    if (cverr) throw cverr;

    await supabaseAdmin.from('application_events').insert({
      application_id: appRow.id,
      event_type: resolvedSource === 'email_agent' ? 'email_agent_upload' : 'admin_manual_upload',
      event_data: { filename, size_bytes: sizeBytes },
      actor: resolvedSource === 'email_agent' ? 'agent' : 'admin',
      ip, user_agent: ua,
    });

    // Analyze.
    const analysis = await analyzeCv({ fileBase64, filename });

    let updateApp = { status: 'cv_uploaded', cv_uploaded_at: new Date().toISOString() };
    if (name && !appRow.name) updateApp.name = name;
    if (isValidExperience(experience) && !appRow.experience) updateApp.experience = experience;

    if (!analysis.ok) {
      await supabaseAdmin.from('applications').update(updateApp).eq('id', appRow.id);
      return res.status(200).json({ ok: true, applicationId: appRow.id, analysis_error: analysis.error });
    }

    const { data: analysisRow } = await supabaseAdmin
      .from('analyses')
      .insert({
        application_id: appRow.id,
        cv_id: cvRow.id,
        score: analysis.score,
        recommendation: analysis.recommendation,
        summary: analysis.summary,
        raw_response: analysis.raw,
        model: analysis.model,
      })
      .select('id').single();

    updateApp.analyzed_at = new Date().toISOString();
    if (analysis.name && !appRow.name) updateApp.name = analysis.name;

    let nextStatus;
    const shouldInvite = !!autoInvite;
    let interviewUrl = null;

    if (shouldInvite) {
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
        event_data: { email_ok: mail.ok, email_id: mail.id || null, actor_reason: 'admin_override' },
        actor: 'admin',
      });
    } else if (analysis.score >= 4) {
      nextStatus = 'analyzed_pending_review';
    } else {
      nextStatus = 'analyzed_auto_rejected';
    }
    updateApp.status = nextStatus;

    await supabaseAdmin.from('applications').update(updateApp).eq('id', appRow.id);

    return res.status(200).json({
      ok: true,
      applicationId: appRow.id,
      score: analysis.score,
      recommendation: analysis.recommendation,
      status: nextStatus,
      interview_url: interviewUrl,
    });
  } catch (e) {
    console.error('[admin/manual-upload] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
