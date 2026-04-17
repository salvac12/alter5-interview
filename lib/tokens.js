// Magic-link token generation + hashing.
//
// Raw tokens (32 bytes hex) go into emails. The DB stores only sha256(raw) so
// a DB leak cannot impersonate candidates. Validation: hash the received token
// and look it up.

const crypto = require('crypto');

// Generate a URL-safe random token. 32 bytes (64 hex chars) = 256 bits.
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Validate token format so we can reject nonsense without DB hit.
function isValidTokenFormat(token) {
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
}

module.exports = { generateToken, hashToken, isValidTokenFormat };
