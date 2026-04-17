// Signed session cookies for candidate flow.
// No external deps — uses Node crypto HMAC.
//
// A session cookie carries { application_id, email, exp } signed with SESSION_SECRET.
// Cookie name: a5_candidate_session. HttpOnly + Secure + SameSite=Lax.
// TTL: 60 min (long enough to upload CV after magic link verify).

const crypto = require('crypto');

const COOKIE_NAME = 'a5_candidate_session';
const DEFAULT_TTL_SEC = 60 * 60; // 60 min

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET not set or too short');
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function sign(payload, ttlSec = DEFAULT_TTL_SEC) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const bodyB64 = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', getSecret()).update(bodyB64).digest();
  return `${bodyB64}.${b64url(sig)}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [bodyB64, sigB64] = parts;
  const expectedSig = crypto.createHmac('sha256', getSecret()).update(bodyB64).digest();
  const givenSig = b64urlDecode(sigB64);
  if (expectedSig.length !== givenSig.length) return null;
  if (!crypto.timingSafeEqual(expectedSig, givenSig)) return null;
  let body;
  try {
    body = JSON.parse(b64urlDecode(bodyB64).toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

function setCookieHeader(token, ttlSec = DEFAULT_TTL_SEC) {
  // Prod: Secure + HttpOnly + SameSite=Lax (allows magic-link redirect from email)
  return `${COOKIE_NAME}=${token}; Max-Age=${ttlSec}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(req) {
  const raw = req.headers?.cookie || '';
  const parts = raw.split(/;\s*/);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const name = p.slice(0, eq);
    if (name === COOKIE_NAME) return p.slice(eq + 1);
  }
  return null;
}

function getSession(req) {
  const token = readCookie(req);
  return verify(token);
}

module.exports = {
  COOKIE_NAME,
  sign,
  verify,
  setCookieHeader,
  clearCookieHeader,
  readCookie,
  getSession,
};
