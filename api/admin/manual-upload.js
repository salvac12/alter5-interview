// POST /api/admin/manual-upload
//
// Superadmin-only entry point for ingesting a CV on behalf of a candidate.
// Behind Basic Auth via middleware.js. The actual pipeline lives in
// lib/cv-upload.js so the headhunter portal can reuse it.
//
// Body: { email?, name?, experience?, fileBase64, filename, autoInvite?, source? }
//
// `email` is optional — if omitted we extract it from the CV via the LLM.
// `source` accepts the whitelist {'email_agent'} (Mastra HR agent ingest);
// any other value falls back to 'admin_manual'.

const { processCvUpload } = require('../../lib/cv-upload');
const { getClientIp, getUserAgent } = require('../../lib/validation');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '8mb' } },
};

const ALLOWED_SOURCES = new Set(['email_agent']);

module.exports.default = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { email, name, experience, fileBase64, filename, autoInvite, source } = req.body || {};
  const resolvedSource = ALLOWED_SOURCES.has(source) ? source : 'admin_manual';

  try {
    const result = await processCvUpload({
      fileBase64,
      filename,
      source: resolvedSource,
      prefilledEmail: email || null,
      prefilledName: name || null,
      prefilledExperience: experience || null,
      autoInvite: !!autoInvite,
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
      actor: resolvedSource === 'email_agent' ? 'agent' : 'admin',
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        error: result.error,
        ...(result.detail ? { detail: result.detail } : {}),
      });
    }

    return res.status(200).json({
      ok: true,
      applicationId: result.applicationId,
      score: result.score,
      recommendation: result.recommendation,
      status: result.appStatus,
      interview_url: result.interview_url,
      ...(result.analysis_error ? { analysis_error: result.analysis_error } : {}),
    });
  } catch (e) {
    console.error('[admin/manual-upload] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
