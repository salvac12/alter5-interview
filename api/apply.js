// POST /api/apply
//
// Public endpoint. Candidate submits email + consents + Turnstile token.
// Creates (or reuses) an application row, issues a verify_email magic link,
// sends it via email. Always returns the same 200 response (don't leak
// whether email exists or not).

const { supabaseAdmin } = require('../lib/supabase');
const { isValidEmail, normalizeEmail, getClientIp, getUserAgent } = require('../lib/validation');
const { generateToken, hashToken } = require('../lib/tokens');
const { verifyTurnstile } = require('../lib/turnstile');
const { sendMagicLinkEmail } = require('../lib/email');

const MAGIC_LINK_TTL_MINUTES = 30;

// Current privacy policy version. Bump this whenever the wording of the
// consent checkboxes OR the linked privacy notice changes, so the audit
// log can later prove WHICH policy a given candidate agreed to.
const POLICY_VERSION = process.env.PRIVACY_POLICY_VERSION || '2026-04-18';

module.exports.default = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    email: rawEmail,
    consent_privacy,
    consent_ai_decision,
    requested_human_review,
    turnstile_token,
    utm_source,
    utm_medium,
    utm_campaign,
  } = req.body || {};

  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (!consent_privacy || !consent_ai_decision) {
    return res.status(400).json({ error: 'consent_required' });
  }

  const ip = getClientIp(req);
  const ua = getUserAgent(req);

  const turnstile = await verifyTurnstile(turnstile_token, ip);
  if (!turnstile.success) {
    // Surface the Cloudflare error code in logs so we can distinguish
    // expired tokens from secret/hostname misconfigurations. We do NOT
    // leak the code to the client (it would help attackers craft retries).
    console.error('[apply] turnstile_failed', {
      code: turnstile.error || 'unknown',
      ip_present: !!ip,
      token_len: turnstile_token ? String(turnstile_token).length : 0,
    });
    return res.status(400).json({ error: 'turnstile_failed' });
  }

  const baseUrl = process.env.APPLY_BASE_URL || 'https://careers.alter-5.com/hoe';
  const origin = new URL(baseUrl).origin;

  try {
    // 1. Lookup or create active application.
    const { data: existing, error: selErr } = await supabaseAdmin
      .from('applications')
      .select('id, status, apply_count, created_at')
      .eq('email', email)
      .is('deleted_at', null)
      .maybeSingle();

    if (selErr) throw selErr;

    let applicationId;
    if (existing) {
      applicationId = existing.id;
      await supabaseAdmin
        .from('applications')
        .update({
          apply_count: (existing.apply_count || 1) + 1,
          apply_ip: ip,
          apply_user_agent: ua,
          requested_human_review: !!requested_human_review,
        })
        .eq('id', applicationId);
    } else {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('applications')
        .insert({
          email,
          source: 'public',
          status: 'pending_verify',
          consent_privacy: !!consent_privacy,
          consent_ai_decision: !!consent_ai_decision,
          requested_human_review: !!requested_human_review,
          apply_ip: ip,
          apply_user_agent: ua,
          utm_source: utm_source || null,
          utm_medium: utm_medium || null,
          utm_campaign: utm_campaign || null,
        })
        .select('id')
        .single();
      if (insErr) throw insErr;
      applicationId = inserted.id;
    }

    // 2. Invalidate any prior unused verify_email links for this application.
    await supabaseAdmin
      .from('magic_links')
      .update({ used_at: new Date().toISOString() })
      .eq('application_id', applicationId)
      .eq('purpose', 'verify_email')
      .is('used_at', null);

    // 3. Create new magic link.
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000).toISOString();

    const { error: mlErr } = await supabaseAdmin.from('magic_links').insert({
      application_id: applicationId,
      purpose: 'verify_email',
      token_hash: tokenHash,
      expires_at: expiresAt,
    });
    if (mlErr) throw mlErr;

    // 4. Send email with raw token.
    const verifyUrl = `${origin}/apply/verify?token=${rawToken}`;
    const mail = await sendMagicLinkEmail({
      to: email,
      verifyUrl,
      ttlMinutes: MAGIC_LINK_TTL_MINUTES,
    });

    // 5. Record consent events (GDPR Art.7(1) — we must be able to prove
    //    when + which policy version the candidate accepted). One row per
    //    declared consent; the booleans on `applications` remain for fast
    //    lookups but this table is the audit source of truth.
    //
    //    A failure here is loud: if we cannot prove consent, we should know
    //    immediately. We still let the apply succeed (the booleans on the
    //    application row carry the consent data) but log loudly so an
    //    accidental schema/RLS regression is visible in Vercel logs.
    const { error: consentErr } = await supabaseAdmin.from('consent_events').insert([
      { application_id: applicationId, consent_type: 'privacy',       granted: !!consent_privacy,        policy_version: POLICY_VERSION, ip, user_agent: ua },
      { application_id: applicationId, consent_type: 'ai_decision',   granted: !!consent_ai_decision,    policy_version: POLICY_VERSION, ip, user_agent: ua },
      { application_id: applicationId, consent_type: 'human_review',  granted: !!requested_human_review, policy_version: POLICY_VERSION, ip, user_agent: ua },
    ]);
    if (consentErr) {
      console.error('[apply] consent_events insert failed', {
        application_id: applicationId,
        message: consentErr.message,
      });
    }

    // 6. Audit event.
    await supabaseAdmin.from('application_events').insert({
      application_id: applicationId,
      event_type: existing ? 'apply_retry' : 'apply_created',
      event_data: {
        email_sent: mail.ok,
        email_id: mail.id || null,
        turnstile_skipped: !!turnstile.skipped,
        policy_version: POLICY_VERSION,
      },
      actor: 'candidate',
      ip,
      user_agent: ua,
    });

    if (!mail.ok) {
      // Email failed but the application was recorded. Surface a generic error.
      console.error('[apply] email send failed for', email, mail);
      return res.status(502).json({ error: 'email_send_failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[apply] error:', e.message, e.details || '');
    return res.status(500).json({ error: 'internal_error' });
  }
};
