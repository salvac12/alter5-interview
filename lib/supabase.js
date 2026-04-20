// Supabase client helpers.
//
// Usage from API routes (server-side):
//   const { supabaseAdmin } = require('../lib/supabase');
//   await supabaseAdmin.from('applications').insert({...});
//
// Admin client uses service role key and BYPASSES Row-Level Security.
// Never import it from browser code.
//
// Lazy-by-proxy: the clients are built on first *use*, not on require().
// The naïve `{ get supabaseAdmin() { ... } }` shape that used to live here
// was a footgun because every call site destructures at the top of the
// file (`const { supabaseAdmin } = require(...)`), and destructuring
// reads the property, which fires the getter — so a missing env var
// would crash every serverless function at module load with
// FUNCTION_INVOCATION_FAILED, before any try/catch in the handler could
// turn it into a proper HTTP response. A Proxy defers client creation
// until the caller actually touches a property (e.g. `.from`, `.storage`).

const { createClient } = require('@supabase/supabase-js');

function makeClient(keyName) {
  const url = process.env.SUPABASE_URL;
  const key = process.env[keyName];
  if (!url) throw new Error('SUPABASE_URL not set');
  if (!key) throw new Error(`${keyName} not set`);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function lazyClient(keyName) {
  let client = null;
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (!client) client = makeClient(keyName);
      const v = client[prop];
      return typeof v === 'function' ? v.bind(client) : v;
    },
    apply(_t, _thisArg, args) {
      if (!client) client = makeClient(keyName);
      return client(...args);
    },
  });
}

module.exports = {
  supabaseAdmin: lazyClient('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseAnon: lazyClient('SUPABASE_ANON_KEY'),
};
