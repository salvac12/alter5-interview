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

// Rough IP syntax check — enough to reject obvious garbage from spoofed
// X-Forwarded-For headers before we persist the value into Postgres's
// strict `inet` column (which would otherwise raise and break the request).
// We do NOT need to validate every corner of RFC 4291 here; the edge
// middleware already applies the same check for rate-limit keys.
function looksLikeIp(s) {
  if (typeof s !== 'string' || !s) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(s)) return true;                    // IPv4
  // IPv6: require hex chars + at least two colons (rejects ":::" garbage).
  if (/^[0-9a-fA-F:]+$/.test(s) && /[0-9a-fA-F]/.test(s) && (s.match(/:/g) || []).length >= 2) return true;
  return false;
}

function getClientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'] || req.headers?.get?.('x-forwarded-for');
  if (!fwd) return null;
  const first = String(fwd).split(',')[0].trim();
  return looksLikeIp(first) ? first : null;
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
  looksLikeIp,
  getClientIp,
  getUserAgent,
};
