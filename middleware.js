// Vercel Edge middleware. Runs in front of every request that matches `config.matcher`.
//
// Two responsibilities:
//   1. Per-IP, per-route rate limiting (in-memory, per-instance).
//      NOTE: in production with multiple instances, this gives best-effort
//      protection. For hard guarantees we'd need Vercel KV / Upstash.
//   2. Basic Auth for the admin/back-office surface.
//      Fail-CLOSED: if ADMIN_PASS is missing, the request is rejected.

export const config = {
  matcher: [
    // Auth-protected pages
    '/admin',
    '/dashboard',
    '/reports',
    // Admin-only API
    '/api/admin/:path*',
    // Public API — rate-limited but not authenticated
    '/api/apply',
    '/api/apply/:path*',
    '/api/upload-cv',
    '/api/analyze-cv',
    '/api/submit-interview',
    '/api/interview/:path*',
    '/api/privacy/:path*',
    '/api/headhunter/:path*',
    '/api/public-config',
    // Cron self-authenticates with Bearer, but we still rate-limit at the
    // edge so an unauthenticated flood doesn't keep waking the function.
    '/api/cron/:path*',
  ],
};

// ── Routes that require Basic Auth (superadmin / reports viewer) ────────────
const AUTH_PATHS = [
  '/admin',
  '/dashboard',
  '/reports',
  '/api/admin/',
];

// ── Rate limits (per IP, per edge instance, sliding window) ─────────────────
const RATE_LIMITS = {
  '/api/apply':             { max: 5,  windowSec: 60 },
  '/api/apply/verify':      { max: 20, windowSec: 60 },
  '/api/upload-cv':         { max: 3,  windowSec: 60 },
  '/api/analyze-cv':        { max: 3,  windowSec: 60 },
  '/api/submit-interview':  { max: 3,  windowSec: 60 },
  '/api/interview/':        { max: 20, windowSec: 60 },
  '/api/privacy/':          { max: 5,  windowSec: 60 },
  '/api/headhunter/login':       { max: 10, windowSec: 60 },
  '/api/headhunter/register':    { max: 5,  windowSec: 60 },
  '/api/headhunter/upload-cv':   { max: 10, windowSec: 60 },
  '/api/headhunter/':            { max: 60, windowSec: 60 },
  '/api/public-config':     { max: 60, windowSec: 60 },
  '/api/admin/':            { max: 60, windowSec: 60 },
  '/api/cron/':             { max: 10, windowSec: 60 },
};

// ── In-memory rate-limit store (per-instance) ───────────────────────────────
const rateMap = new Map();
let lastCleanup = Date.now();

function findRateRule(path) {
  // Longest-prefix match (avoid '/api/apply' shadowing '/api/apply/verify').
  let best = null;
  for (const [prefix, rule] of Object.entries(RATE_LIMITS)) {
    if (path === prefix || path.startsWith(prefix)) {
      if (!best || prefix.length > best.prefix.length) {
        best = { prefix, ...rule };
      }
    }
  }
  return best;
}

function checkRateLimit(ip, path) {
  const rule = findRateRule(path);
  if (!rule) return null;
  const key = `${ip}:${rule.prefix}`;
  const now = Date.now();
  const entry = rateMap.get(key);

  if (!entry || now - entry.start > rule.windowSec * 1000) {
    rateMap.set(key, { start: now, count: 1 });
    return null;
  }
  entry.count++;
  if (entry.count > rule.max) {
    return Math.ceil((entry.start + rule.windowSec * 1000 - now) / 1000);
  }
  return null;
}

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < 60000) return;
  lastCleanup = now;
  for (const [key, entry] of rateMap) {
    if (now - entry.start > 120000) rateMap.delete(key);
  }
}

function needsAuth(path) {
  for (const prefix of AUTH_PATHS) {
    if (path === prefix || path.startsWith(prefix)) return true;
  }
  return false;
}

// Constant-time comparison of two strings (defends against timing attacks).
//
// We use SHA-256 of both inputs so we always XOR over fixed-length
// 32-byte buffers — this avoids leaking the length of ADMIN_PASS via
// the early-exit on `a.length !== b.length` that the previous version
// had. SubtleCrypto.digest is available in the Vercel Edge runtime.
async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const ua = new Uint8Array(ha);
  const ub = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

// Validate that a value looks like an IP address (rough — just to reject
// obvious garbage from spoofed X-Forwarded-For).
function looksLikeIp(s) {
  if (!s) return false;
  // IPv4 — four octets 0-255 (rough — accepts 999, but acceptable for a
  // pre-DB-insert sanity check; Postgres `inet` will refuse the bad ones).
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(s)) return true;
  // IPv6 — require hex digits in addition to colons. The previous check
  // accepted strings like ":::::" because it tested only "hex OR colon"
  // and "contains colon". Now we require at least one hex digit AND at
  // least two colons (every valid IPv6 form has ≥2 colons).
  if (/^[0-9a-fA-F:]+$/.test(s) && /[0-9a-fA-F]/.test(s) && (s.match(/:/g) || []).length >= 2) return true;
  return false;
}

function clientIp(req) {
  const xff = req.headers.get('x-forwarded-for') || '';
  const first = xff.split(',')[0]?.trim() || '';
  return looksLikeIp(first) ? first : 'unknown';
}

// ── Middleware entry point ──────────────────────────────────────────────────
export default async function middleware(req) {
  const url = new URL(req.url);
  const ip = clientIp(req);

  cleanup();
  const retryAfter = checkRateLimit(ip, url.pathname);
  if (retryAfter) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      },
    });
  }

  if (!needsAuth(url.pathname)) return;

  const AUTH_USER = process.env.ADMIN_USER || 'admin';
  const AUTH_PASS = process.env.ADMIN_PASS;

  // Fail-CLOSED. A misconfigured deploy must NOT expose admin endpoints.
  if (!AUTH_PASS) {
    console.error('[middleware] ADMIN_PASS not set — refusing admin request');
    return new Response('Service Misconfigured', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const auth = req.headers.get('authorization');
  if (auth) {
    const [scheme, encoded] = auth.split(' ');
    if (scheme === 'Basic' && encoded) {
      try {
        const decoded = atob(encoded);
        const idx = decoded.indexOf(':');
        if (idx > 0) {
          const user = decoded.slice(0, idx);
          const pass = decoded.slice(idx + 1);
          const [okUser, okPass] = await Promise.all([
            safeEqual(user, AUTH_USER),
            safeEqual(pass, AUTH_PASS),
          ]);
          if (okUser && okPass) return;
        }
      } catch {
        // Malformed base64 — fall through to 401
      }
    }
  }

  return new Response('Acceso restringido', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Alter5 Admin"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
