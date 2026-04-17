// GET /api/public-config
//
// Returns config values that are safe to expose to the browser.
// Pages that need Turnstile fetch this at load time.

module.exports = function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({
    turnstile_site_key: process.env.TURNSTILE_SITE_KEY || '1x00000000000000000000AA',
    apply_base_url: process.env.APPLY_BASE_URL || 'https://careers.alter-5.com/sw-architect',
    booking_url: process.env.INTERVIEW_BOOKING_URL || '',
  });
};
