// Resend wrapper.
//
// Three templates:
//   sendMagicLinkEmail     - link to verify email and upload CV
//   sendInterviewLinkEmail - link to start the interview (score >= 7)
//   sendArcoLinkEmail      - link to manage own data (GDPR)

const FROM = 'Alter5 Hiring <hiring@alter-5.com>';
const REPLY_TO = 'careers@alter-5.com';
const DPO = 'privacy@alter-5.com';

function brandHeader() {
  return `<div style="background:#0A1628;padding:32px 40px;border-radius:12px 12px 0 0">
    <div style="font-family:Georgia,serif;font-size:22px;color:#fff;margin-bottom:4px">Alter<span style="color:#10B981">5</span></div>
    <div style="font-size:13px;color:#94A3B8;letter-spacing:0.5px">SW Architect / AI Head of Engineering</div>
  </div>`;
}

function brandFooter() {
  return `<div style="text-align:center;padding:24px 0">
    <p style="font-size:12px;color:#94A3B8;margin:0 0 4px">Alter5 Financial Technologies, S.L. · Madrid</p>
    <p style="font-size:11px;color:#CBD5E1;margin:0">Derechos GDPR: <a href="mailto:${DPO}" style="color:#64748B">${DPO}</a></p>
  </div>`;
}

function wrap(bodyHtml) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto">
    ${brandHeader()}
    <div style="background:#fff;border:1px solid #E2E8F0;border-top:none;padding:40px;border-radius:0 0 12px 12px">
      ${bodyHtml}
    </div>
    ${brandFooter()}
  </div>`;
}

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

function sendMagicLinkEmail({ to, verifyUrl, ttlMinutes = 30 }) {
  const body = `
    <p style="font-size:16px;color:#1E293B;line-height:1.6;margin:0 0 20px">Hola,</p>
    <p style="font-size:15px;color:#475569;line-height:1.7;margin:0 0 16px">
      Recibimos tu candidatura a <strong>SW Architect / AI Head of Engineering</strong>.
    </p>
    <p style="font-size:15px;color:#475569;line-height:1.7;margin:0 0 28px">
      Para continuar, verifica tu email y sube tu CV haciendo click en el siguiente botón.
      El enlace caduca en <strong>${ttlMinutes} minutos</strong> y es de un solo uso.
    </p>
    <div style="text-align:center;margin:32px 0">
      <a href="${verifyUrl}" style="display:inline-block;background:#0A1628;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600">Verificar email y subir CV →</a>
    </div>
    <p style="font-size:13px;color:#64748B;line-height:1.6;margin:24px 0 0">
      Si no has solicitado esta candidatura, ignora este mensaje y no se guardará ningún dato.
    </p>`;
  return sendEmail({
    to,
    subject: 'Alter5 — Verifica tu email para completar tu candidatura',
    html: wrap(body),
  });
}

function sendInterviewLinkEmail({ to, name, interviewUrl, expiresDays = 7 }) {
  const safeName = String(name || '').replace(/[<>"'&]/g, '');
  const hi = safeName ? `Hola ${safeName},` : 'Hola,';
  const body = `
    <p style="font-size:16px;color:#1E293B;line-height:1.6;margin:0 0 20px">${hi}</p>
    <p style="font-size:15px;color:#475569;line-height:1.7;margin:0 0 16px">
      Tu perfil encaja con lo que buscamos para <strong>SW Architect / AI Head of Engineering</strong>.
    </p>
    <p style="font-size:15px;color:#475569;line-height:1.7;margin:0 0 28px">
      Como siguiente paso te invitamos a completar una entrevista técnica estructurada (~15 min).
      El enlace caduca en <strong>${expiresDays} días</strong> y es de un solo uso.
    </p>
    <div style="text-align:center;margin:32px 0">
      <a href="${interviewUrl}" style="display:inline-block;background:#0A1628;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600">Comenzar entrevista →</a>
    </div>
    <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:20px;margin:28px 0">
      <p style="font-size:13px;color:#64748B;line-height:1.6;margin:0 0 8px"><strong style="color:#1E293B">Instrucciones:</strong></p>
      <p style="font-size:13px;color:#64748B;line-height:1.6;margin:0 0 4px">· Responde con ejemplos reales y concretos.</p>
      <p style="font-size:13px;color:#64748B;line-height:1.6;margin:0 0 4px">· El tiempo de respuesta es visible para el entrevistador.</p>
      <p style="font-size:13px;color:#64748B;line-height:1.6;margin:0">· Este enlace es personal e intransferible.</p>
    </div>
    <p style="font-size:14px;color:#475569;line-height:1.6;margin:0">Un saludo,<br><strong>Equipo de Alter5</strong></p>`;
  return sendEmail({
    to,
    subject: `Alter5 — Entrevista técnica · ${safeName || 'siguiente paso'}`,
    html: wrap(body),
  });
}

function sendArcoLinkEmail({ to, manageUrl, ttlMinutes = 30 }) {
  const body = `
    <p style="font-size:16px;color:#1E293B;line-height:1.6;margin:0 0 20px">Hola,</p>
    <p style="font-size:15px;color:#475569;line-height:1.7;margin:0 0 16px">
      Recibimos una solicitud para gestionar los datos personales asociados a este email
      en el proceso de selección de Alter5.
    </p>
    <p style="font-size:15px;color:#475569;line-height:1.7;margin:0 0 28px">
      Para ver, exportar o solicitar el borrado de tus datos, usa el siguiente enlace.
      Caduca en <strong>${ttlMinutes} minutos</strong>.
    </p>
    <div style="text-align:center;margin:32px 0">
      <a href="${manageUrl}" style="display:inline-block;background:#0A1628;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:15px;font-weight:600">Gestionar mis datos →</a>
    </div>
    <p style="font-size:13px;color:#64748B;line-height:1.6;margin:24px 0 0">
      Si no has solicitado esto, ignora este mensaje.
    </p>`;
  return sendEmail({
    to,
    subject: 'Alter5 — Gestiona tus datos personales',
    html: wrap(body),
  });
}

module.exports = { sendEmail, sendMagicLinkEmail, sendInterviewLinkEmail, sendArcoLinkEmail };
