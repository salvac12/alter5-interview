// Resend wrapper.
//
// Five templates (all branded against the Alter5 design tokens):
//   sendMagicLinkEmail              - verify email + upload CV
//   sendInterviewLinkEmail          - invitation to the technical interview
//   sendArcoLinkEmail               - GDPR data-management link
//   sendPostCvRejectionEmail        - formal decline after CV review
//   sendPostInterviewRejectionEmail - formal decline after completing interview
//
// Design notes for email rendering:
// - Email clients (especially Outlook) don't support CSS variables, flexbox,
//   or grid. Everything here is inline-styled, table-based layout.
// - Brand palette is duplicated here as plain constants because /ds/tokens.css
//   is a browser artefact — emails can't reach it.
// - We deliberately use a solid navy header with a teal bottom rule instead
//   of a CSS gradient; Outlook falls back to the first color and it looks
//   worse than the solid. Solid + rule keeps it bulletproof.

const FROM = 'Alter5 Hiring <hiring@alter-5.com>';
const REPLY_TO = 'careers@alter-5.com';
const DPO = 'privacy@alter-5.com';
const PRIVACY_URL = 'https://careers.alter-5.com/privacy/my-data';

// Brand palette (subset of /ds/tokens.css frozen at module scope).
const C = {
  navy:       '#13285B',
  navyDark:   '#0A1628',
  teal:       '#51B6BE',
  tealDark:   '#2CA1AB',
  text:       '#1A2B3D',
  textMuted:  '#6B7F94',
  textDim:    '#94A3B8',
  surface:    '#F8FAFC',
  border:     '#E2E8F0',
  white:      '#FFFFFF',
  pageBg:     '#F0F4F8',
};

// Font stacks. First declaration wins in email clients.
const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`;
const FONT_SERIF = `Georgia,"Times New Roman",serif`;

function esc(s) {
  return String(s || '').replace(/[<>"'&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' })[c]);
}

function brandHeader() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.navy};border-bottom:4px solid ${C.teal}">
  <tr><td style="padding:32px 40px">
    <div style="font-family:${FONT_SERIF};font-size:28px;letter-spacing:-0.5px;color:${C.white};line-height:1">
      Alter<span style="color:${C.teal};font-weight:700">5</span>
    </div>
    <div style="font-family:${FONT};font-size:11px;color:${C.textDim};letter-spacing:0.14em;text-transform:uppercase;margin-top:8px">
      Head of Engineering &middot; AI &amp; Infrastructure
    </div>
  </td></tr>
</table>`;
}

function brandFooter() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td style="padding:24px 40px;text-align:center">
    <p style="font-family:${FONT};font-size:11px;color:${C.textDim};margin:0 0 6px;line-height:1.6">
      Alter5 Financial Technologies, S.L. &middot; Madrid
    </p>
    <p style="font-family:${FONT};font-size:11px;color:${C.textDim};margin:0;line-height:1.6">
      Derechos GDPR &middot; <a href="mailto:${DPO}" style="color:${C.tealDark};text-decoration:none">${DPO}</a>
      &middot; <a href="${PRIVACY_URL}" style="color:${C.tealDark};text-decoration:none">Gestionar mis datos</a>
    </p>
  </td></tr>
</table>`;
}

function wrap(bodyHtml) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Alter5</title>
</head>
<body style="margin:0;padding:0;background:${C.pageBg};font-family:${FONT};color:${C.text}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.pageBg};padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${C.white};border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(19,40,91,0.08)">
        <tr><td>${brandHeader()}</td></tr>
        <tr><td style="padding:40px">${bodyHtml}</td></tr>
      </table>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">
        <tr><td>${brandFooter()}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Primary CTA. Bulletproof table-button: renders as a tappable block in
// Outlook, Gmail (web + mobile), Apple Mail. The outer <table> gives Outlook
// the hit area; the inner <a> gives other clients the gradient-less fill.
function cta(url, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:32px auto">
  <tr><td align="center" bgcolor="${C.teal}" style="background:${C.teal};border-radius:8px;box-shadow:0 2px 8px rgba(81,182,190,0.3)">
    <a href="${url}" target="_blank" style="display:inline-block;color:${C.white};text-decoration:none;font-family:${FONT};font-size:15px;font-weight:600;padding:14px 36px;letter-spacing:0.02em">${label}</a>
  </td></tr>
</table>`;
}

// Reusable paragraph styles (keep inline so email clients don't strip them).
const P_LEAD     = `font-family:${FONT};font-size:17px;color:${C.text};line-height:1.6;margin:0 0 20px;font-weight:500`;
const P_BODY     = `font-family:${FONT};font-size:15px;color:${C.textMuted};line-height:1.7;margin:0 0 16px`;
const P_BODY_END = `font-family:${FONT};font-size:15px;color:${C.textMuted};line-height:1.7;margin:0 0 28px`;
const P_FINE     = `font-family:${FONT};font-size:13px;color:${C.textDim};line-height:1.6;margin:24px 0 0`;
const P_SIGN     = `font-family:${FONT};font-size:14px;color:${C.textMuted};line-height:1.7;margin:28px 0 0`;

// ───────────────────────────────────────────────────────────────────────────
// Resend transport
// ───────────────────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('[email] RESEND_API_KEY missing');
    return { ok: false, error: 'email_service_unavailable' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, reply_to: REPLY_TO }),
    });
    const d = await r.json();
    if (!r.ok) {
      console.error('[email] resend error:', r.status, d);
      return { ok: false, error: d.message || 'email_error', status: r.status };
    }
    return { ok: true, id: d.id };
  } catch (e) {
    console.error('[email] network error:', e.message);
    return { ok: false, error: 'network_error' };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Templates
// ───────────────────────────────────────────────────────────────────────────

function sendMagicLinkEmail({ to, verifyUrl, ttlMinutes = 30 }) {
  const body = `
    <p style="${P_LEAD}">Hola,</p>
    <p style="${P_BODY}">
      Recibimos tu candidatura a <strong style="color:${C.text}">Head of Engineering (AI &amp; Infrastructure)</strong>.
    </p>
    <p style="${P_BODY_END}">
      Para continuar, verifica tu email y sube tu CV con el siguiente enlace.
      Caduca en <strong style="color:${C.text}">${ttlMinutes} minutos</strong> y es de un solo uso.
    </p>
    ${cta(verifyUrl, 'Verificar email y subir CV →')}
    <p style="${P_FINE}">
      Si no has solicitado esta candidatura, ignora este mensaje y no se guardará ningún dato.
    </p>`;
  return sendEmail({
    to,
    subject: 'Alter5 — Verifica tu email para completar tu candidatura',
    html: wrap(body),
  });
}

function sendInterviewLinkEmail({ to, name, interviewUrl, expiresDays = 7 }) {
  const safeName = esc(name);
  const hi = safeName ? `Hola ${safeName},` : 'Hola,';
  const body = `
    <p style="${P_LEAD}">${hi}</p>
    <p style="${P_BODY}">
      Tu perfil encaja con lo que buscamos para <strong style="color:${C.text}">Head of Engineering (AI &amp; Infrastructure)</strong>.
    </p>
    <p style="${P_BODY_END}">
      Como siguiente paso te invitamos a completar una entrevista técnica estructurada (~15 min).
      El enlace caduca en <strong style="color:${C.text}">${expiresDays} días</strong> y es de un solo uso.
    </p>
    ${cta(interviewUrl, 'Comenzar entrevista →')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px">
      <tr><td style="background:${C.surface};border:1px solid ${C.border};border-radius:8px;padding:20px">
        <p style="font-family:${FONT};font-size:12px;color:${C.textMuted};letter-spacing:0.08em;text-transform:uppercase;margin:0 0 10px;font-weight:600">
          Instrucciones
        </p>
        <p style="font-family:${FONT};font-size:13px;color:${C.textMuted};line-height:1.7;margin:0 0 6px">
          &middot; Responde con ejemplos reales y concretos.
        </p>
        <p style="font-family:${FONT};font-size:13px;color:${C.textMuted};line-height:1.7;margin:0 0 6px">
          &middot; El tiempo de respuesta es visible para el entrevistador.
        </p>
        <p style="font-family:${FONT};font-size:13px;color:${C.textMuted};line-height:1.7;margin:0">
          &middot; Este enlace es personal e intransferible.
        </p>
      </td></tr>
    </table>
    <p style="${P_SIGN}">Un saludo,<br><strong style="color:${C.text}">Equipo Alter5</strong></p>`;
  return sendEmail({
    to,
    subject: `Alter5 — Entrevista técnica${safeName ? ' · ' + safeName : ''}`,
    html: wrap(body),
  });
}

function sendArcoLinkEmail({ to, manageUrl, ttlMinutes = 30 }) {
  const body = `
    <p style="${P_LEAD}">Hola,</p>
    <p style="${P_BODY}">
      Recibimos una solicitud para gestionar los datos personales asociados a este email
      en el proceso de selección de Alter5.
    </p>
    <p style="${P_BODY_END}">
      Para ver, exportar o solicitar el borrado de tus datos, usa el siguiente enlace.
      Caduca en <strong style="color:${C.text}">${ttlMinutes} minutos</strong>.
    </p>
    ${cta(manageUrl, 'Gestionar mis datos →')}
    <p style="${P_FINE}">
      Si no has solicitado esto, ignora este mensaje.
    </p>`;
  return sendEmail({
    to,
    subject: 'Alter5 — Gestiona tus datos personales',
    html: wrap(body),
  });
}

// Rejection emails share a common body pattern: warm greeting, clear decision,
// thanks, retention notice, GDPR link already in the footer. Two variants so
// we can acknowledge the effort difference — a CV-stage decline is fine with
// a short note; a post-interview decline deserves explicit acknowledgement of
// the time the candidate invested.

function sendPostCvRejectionEmail({ to, name }) {
  const safeName = esc(name);
  const hi = safeName ? `Hola ${safeName},` : 'Hola,';
  const body = `
    <p style="${P_LEAD}">${hi}</p>
    <p style="${P_BODY}">
      Gracias por tu interés en la posición de <strong style="color:${C.text}">Head of Engineering (AI &amp; Infrastructure)</strong> en Alter5
      y por haberte tomado el tiempo de enviarnos tu CV.
    </p>
    <p style="${P_BODY}">
      Tras revisar tu candidatura con detenimiento, hemos decidido no avanzar con ella en esta ocasión.
      Para este rol concreto estamos priorizando perfiles con un encaje específico con nuestra realidad técnica y de producto,
      y en este momento no hemos podido contrastarlo con suficiente claridad.
    </p>
    <p style="${P_BODY_END}">
      Lamentamos no darte mejores noticias. Conservaremos tu perfil en nuestra base de datos durante 6 meses
      por si se abre una posición con mejor encaje. Si prefieres que lo eliminemos antes, puedes hacerlo tú mismo desde el enlace del pie.
    </p>
    <p style="${P_SIGN}">
      Te deseamos mucho éxito en tu búsqueda.<br>
      Un saludo,<br>
      <strong style="color:${C.text}">Equipo Alter5</strong>
    </p>`;
  return sendEmail({
    to,
    subject: 'Alter5 — Actualización sobre tu candidatura',
    html: wrap(body),
  });
}

function sendPostInterviewRejectionEmail({ to, name }) {
  const safeName = esc(name);
  const hi = safeName ? `Hola ${safeName},` : 'Hola,';
  const body = `
    <p style="${P_LEAD}">${hi}</p>
    <p style="${P_BODY}">
      Gracias por haber completado la entrevista técnica para <strong style="color:${C.text}">Head of Engineering (AI &amp; Infrastructure)</strong> en Alter5.
      Somos muy conscientes del tiempo y la energía que exige un proceso como este, y lo valoramos mucho.
    </p>
    <p style="${P_BODY}">
      Hemos revisado tus respuestas en detalle y, tras comparar el conjunto de candidaturas en esta ronda,
      hemos decidido no avanzar con la tuya. La decisión se basa en el encaje específico con lo que buscamos para este rol concreto
      y no es un reflejo de tu trayectoria profesional en general.
    </p>
    <p style="${P_BODY_END}">
      Conservaremos tu perfil en nuestra base de datos durante 6 meses por si abrimos una posición con mejor encaje.
      Si prefieres que lo eliminemos antes, puedes hacerlo tú mismo desde el enlace del pie.
    </p>
    <p style="${P_SIGN}">
      Te deseamos mucho éxito en los siguientes pasos de tu carrera.<br>
      Un saludo,<br>
      <strong style="color:${C.text}">Equipo Alter5</strong>
    </p>`;
  return sendEmail({
    to,
    subject: 'Alter5 — Resultado del proceso de selección',
    html: wrap(body),
  });
}

function sendHeadhunterInviteEmail({ to, inviteUrl, ttlHours = 168 }) {
  const days = Math.round(ttlHours / 24);
  const ttlLabel = days >= 1 ? `${days} días` : `${ttlHours} horas`;
  const body = `
    <p style="${P_LEAD}">Hola,</p>
    <p style="${P_BODY}">
      Te invitamos a colaborar con <strong style="color:${C.text}">Alter5</strong> como partner de talento.
      A través de tu portal podrás enviarnos candidatos para nuestras posiciones abiertas
      directamente desde una zona privada.
    </p>
    <p style="${P_BODY_END}">
      Para activar tu cuenta, completa el registro con tu nombre, empresa y una contraseña.
      Este enlace caduca en <strong style="color:${C.text}">${ttlLabel}</strong> y es de un solo uso.
    </p>
    ${cta(inviteUrl, 'Activar cuenta de partner →')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px">
      <tr><td style="background:${C.surface};border:1px solid ${C.border};border-radius:8px;padding:20px">
        <p style="font-family:${FONT};font-size:12px;color:${C.textMuted};letter-spacing:0.08em;text-transform:uppercase;margin:0 0 10px;font-weight:600">
          Cómo funciona
        </p>
        <p style="font-family:${FONT};font-size:13px;color:${C.textMuted};line-height:1.7;margin:0 0 6px">
          &middot; Activas tu cuenta y entras al portal con email + contraseña.
        </p>
        <p style="font-family:${FONT};font-size:13px;color:${C.textMuted};line-height:1.7;margin:0 0 6px">
          &middot; Subes uno o varios CVs en PDF, opcionalmente con una nota tuya.
        </p>
        <p style="font-family:${FONT};font-size:13px;color:${C.textMuted};line-height:1.7;margin:0">
          &middot; Nuestro equipo revisa cada candidatura con la nota y el origen visibles.
        </p>
      </td></tr>
    </table>
    <p style="${P_FINE}">
      Si no esperabas esta invitación, ignora este mensaje.
    </p>
    <p style="${P_SIGN}">Un saludo,<br><strong style="color:${C.text}">Equipo Alter5</strong></p>`;
  return sendEmail({
    to,
    subject: 'Alter5 — Invitación al portal de partners',
    html: wrap(body),
  });
}

module.exports = {
  sendEmail,
  sendMagicLinkEmail,
  sendInterviewLinkEmail,
  sendArcoLinkEmail,
  sendPostCvRejectionEmail,
  sendPostInterviewRejectionEmail,
  sendHeadhunterInviteEmail,
};
