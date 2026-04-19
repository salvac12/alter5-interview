// Password hashing using Node's built-in crypto.scrypt.
//
// Format stored in headhunters.password_hash:
//   scrypt$N$r$p$saltB64$hashB64
//
// Why scrypt and not bcrypt: it's in the Node standard library, so no native
// bindings to break on Vercel and no extra dependency to audit. Parameters
// chosen to land around ~100ms on a single Vercel function CPU.

const crypto = require('crypto');

const N = 16384;     // CPU/memory cost
const R = 8;         // block size
const P = 1;         // parallelization
const KEY_LEN = 32;  // 256-bit derived key
const SALT_LEN = 16;
const MIN_PASSWORD_LEN = 10;

function isValidPasswordShape(pw) {
  return typeof pw === 'string' && pw.length >= MIN_PASSWORD_LEN && pw.length <= 256;
}

function hashPassword(plain) {
  if (!isValidPasswordShape(plain)) {
    throw new Error('password_too_weak');
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const derived = crypto.scryptSync(plain, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

// Upper bounds for scrypt parameters read from the stored hash. A hash
// tampered with in the DB could otherwise force `scryptSync` to allocate
// gigabytes of memory or run for minutes, DoSing the function. These
// bounds are well above what `hashPassword` ever produces (16384/8/1)
// but well below anything that would block a Vercel serverless instance.
const MAX_N = 131072;  // 2^17
const MAX_R = 16;
const MAX_P = 4;

function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  if (n < 1024 || n > MAX_N || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return false;
  // scryptSync also requires N to be a power of 2 ≥ 2 — Node throws
  // otherwise. Guard explicitly so a tampered value returns false instead
  // of bubbling up a 500.
  if ((n & (n - 1)) !== 0) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  let derived;
  try {
    derived = crypto.scryptSync(plain, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword, isValidPasswordShape, MIN_PASSWORD_LEN };
