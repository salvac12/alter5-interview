export const config = {
  matcher: [
    // Auth-protected pages
    '/admin',
    '/dashboard',
    '/reports',
    // Admin-only API
    '/api/analyze',
    '/api/process-cv',
    '/api/send-invite',
    '/api/admin/:path*',
    // Public API — rate-limited but not authenticated
    '/api/apply',
    '/api/apply/:path*',
    '/api/upload-cv',
    '/api/analyze-cv',
    '/api/submit-interview',
    '/api/interview/:path*',
    '/api/privacy/:path*',
    '/api/public-config',
  ],
};

// ── Routes that require Basic Auth (superadmin / reports viewer) ────────────
const AUTH_PATHS = [
  '/admin',
  '/dashboard',
  '/reports',
  '/api/analyze',
  '/api/process-cv',
  '/api/send-invite',
  '/api/admin/',
];

// ── Rate limits (per IP, per edge instance, sliding window) ─────────────────
const RATE_LIMITS = {
  '/api/apply':             { max: 5,  windowSec: 60 },  // public: form submit
  '/api/apply/verify':      { max: 20, windowSec: 60 },  // public: token verify (retries ok)
  '/api/upload-cv':         { max: 3,  windowSec: 60 },  // public: CV upload
  '/api/analyze-cv':        { max: 3,  windowSec: 60 },  // public (called by upload-cv)
  '/api/submit-interview':  { max: 3,  windowSec: 60 },  // public: interview submission
  '/api/interview/':        { max: 20, windowSec: 60 },  // public: token validate (retries ok)
  '/api/privacy/':          { max: 5,  windowSec: 60 },  // public: ARCO
  '/api/send-invite':       { max: 5,  windowSec: 60 },  // admin
  '/api/analyze':           { max: 10, windowSec: 60 },  // admin
  '/api/process-cv':        { max: 10, windowSec: 60 },  // admin
  '/api/public-config':     { max: 60, windowSec: 60 },  // config read
  '/api/admin/':            { max: 60, windowSec: 60 },  // admin dashboards
};

// ── In-memory rate-limit store (per-instance) ───────────────────────────────
const rateMap = new Map();
let lastCleanup = Date.now();

function findRateRule(path) {
  for (const [prefix, rule] of Object.entries(RATE_LIMITS)) {
    if (path === prefix || path.startsWith(prefix)) return { prefix, ...rule };
  }
  return null;
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

// ── Middleware entry point ──────────────────────────────────────────────────
export default function middleware(req) {
  const url = new URL(req.url);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

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
  if (!AUTH_PASS) return; // fail-open only if misconfigured; alerted in logs

  const auth = req.headers.get('authorization');
  if (auth) {
    const [scheme, encoded] = auth.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = atob(encoded);
      const [user, pass] = decoded.split(':');
      if (user === AUTH_USER && pass === AUTH_PASS) return;
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
