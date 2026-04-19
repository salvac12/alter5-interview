// POST /api/headhunter/logout — clears the session cookie.

const { clearCookieHeader } = require('../../lib/headhunter-session');

module.exports.default = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  res.setHeader('Set-Cookie', clearCookieHeader());
  return res.status(200).json({ ok: true });
};
