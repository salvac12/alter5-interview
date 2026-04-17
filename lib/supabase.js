// Supabase client helpers.
//
// Usage from API routes (server-side):
//   const { supabaseAdmin } = require('../lib/supabase');
//   await supabaseAdmin.from('applications').insert({...});
//
// Admin client uses service role key and BYPASSES Row-Level Security.
// Never import it from browser code.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL not set');
}

// Admin (server-side, bypasses RLS). Only import from /api/*.
function getSupabaseAdmin() {
  if (!SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Anon (safe anywhere). RLS enforced.
function getSupabaseAnon() {
  if (!ANON_KEY) throw new Error('SUPABASE_ANON_KEY not set');
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Lazily instantiated singletons for serverless reuse.
let _admin = null;
let _anon = null;

module.exports = {
  get supabaseAdmin() {
    if (!_admin) _admin = getSupabaseAdmin();
    return _admin;
  },
  get supabaseAnon() {
    if (!_anon) _anon = getSupabaseAnon();
    return _anon;
  },
};
