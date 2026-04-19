// GET /api/headhunter/me
//
// Returns the current partner's profile if authenticated, else 401. The
// /partners/upload page calls this on load to decide whether to redirect to
// the login screen.

const { supabaseAdmin } = require('../../lib/supabase');
const { getSession } = require('../../lib/headhunter-session');

module.exports.default = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const session = getSession(req);
  if (!session?.hh_id) return res.status(401).json({ error: 'unauthenticated' });

  try {
    const { data: hh } = await supabaseAdmin
      .from('headhunters')
      .select('id, email, name, company, status')
      .eq('id', session.hh_id)
      .maybeSingle();
    // Fail-closed: only `active` may proceed. Anything else (invited,
    // disabled, future states) is treated as unauthenticated.
    if (!hh || hh.status !== 'active') {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    return res.status(200).json({
      ok: true,
      headhunter: { id: hh.id, email: hh.email, name: hh.name, company: hh.company },
    });
  } catch (e) {
    console.error('[headhunter/me] error:', e.message);
    return res.status(500).json({ error: 'internal_error' });
  }
};
