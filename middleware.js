export const config = {
  matcher: ['/admin', '/dashboard', '/api/analyze', '/api/process-cv', '/api/send-invite'],
};

// ── Rate limiting (in-memory per edge instance) ─────────────────────────────
const rateMap = new Map();
const RATE_LIMITS = {
  '/api/send-invite': { max: 5, windowSec: 60 },
  '/api/analyze': { max: 10, windowSec: 60 },
  '/api/process-cv': { max: 10, windowSec: 60 },
};

function checkRateLimit(ip, path) {
  const rule = Object.entries(RATE_LIMITS).find(([p]) => path.startsWith(p));
  if (!rule) return null;
  const [, { max, windowSec }] = rule;
  const key = `${ip}:${rule[0]}`;
  const now = Date.now();
  const entry = rateMap.get(key);

  if (!entry || now - entry.start > windowSec * 1000) {
    rateMap.set(key, { start: now, count: 1 });
    return null;
  }

  entry.count++;
  if (entry.count > max) {
    const retryAfter = Math.ceil((entry.start + windowSec * 1000 - now) / 1000);
    return retryAfter;
  }
  return null;
}

// Cleanup stale entries every 60s to prevent memory leak
let lastCleanup = Date.now();
function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < 60000) return;
  lastCleanup = now;
  for (const [key, entry] of rateMap) {
    if (now - entry.start > 120000) rateMap.delete(key);
  }
}

// ── Middleware ───────────────────────────────────────────────────────────────
export default function middleware(req) {
  const url = new URL(req.url);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  // Rate limiting on API routes (before auth, to block brute force too)
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

  // Auth on protected routes
  const AUTH_USER = process.env.ADMIN_USER || 'admin';
  const AUTH_PASS = process.env.ADMIN_PASS;

  if (!AUTH_PASS) return;

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
