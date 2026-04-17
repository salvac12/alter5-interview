// Input validation helpers shared across API routes.

const EMAIL_RX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length > 254) return false;
  return EMAIL_RX.test(email);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// HTML-escape for safe insertion in email templates.
function esc(s) {
  return String(s || '').replace(/[<>"'&]/g, c => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;',
  })[c]);
}

function isValidExperience(exp) {
  return ['3-5', '5-8', '8-12', '12+'].includes(exp);
}

function getClientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'] || req.headers?.get?.('x-forwarded-for');
  if (!fwd) return null;
  return String(fwd).split(',')[0].trim() || null;
}

function getUserAgent(req) {
  return (req.headers?.['user-agent'] || req.headers?.get?.('user-agent') || '').slice(0, 500);
}

module.exports = {
  EMAIL_RX,
  isValidEmail,
  normalizeEmail,
  esc,
  isValidExperience,
  getClientIp,
  getUserAgent,
};
