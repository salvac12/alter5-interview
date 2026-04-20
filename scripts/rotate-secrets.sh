#!/usr/bin/env bash
# Rotate SUPABASE_SERVICE_ROLE_KEY and TURNSTILE_SECRET_KEY in Vercel (prod + preview)
# and redeploy production with the new values.
#
# PREREQUISITES (export before invoking):
#   NEW_SUPABASE_SERVICE_ROLE_KEY   fresh JWT from Supabase dashboard
#   NEW_TURNSTILE_SECRET_KEY        fresh secret from Cloudflare dashboard
#
# The caller is responsible for MAINTENANCE_MODE toggling around this script —
# see docs/rotation-runbook.md. The script itself only swaps the two secrets
# and promotes a new production deploy.
#
# Exits non-zero on any failure. Never prints secret values.

set -euo pipefail

: "${NEW_SUPABASE_SERVICE_ROLE_KEY:?missing — export NEW_SUPABASE_SERVICE_ROLE_KEY first}"
: "${NEW_TURNSTILE_SECRET_KEY:?missing — export NEW_TURNSTILE_SECRET_KEY first}"

command -v vercel >/dev/null || { echo "vercel CLI not in PATH" >&2; exit 1; }

log() { printf '[rotate %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

remove_env() {
  local name="$1" env="$2" out
  if out=$(vercel env rm "$name" "$env" --yes 2>&1); then
    log "removed $name ($env)"
  elif echo "$out" | grep -qiE "not.*found|does not exist"; then
    log "no existing $name ($env) — ok"
  else
    echo "$out" >&2
    return 1
  fi
}

add_env() {
  local name="$1" env="$2" value="$3"
  printf '%s' "$value" | vercel env add "$name" "$env" --sensitive --force >/dev/null
  log "added $name ($env) as sensitive"
}

# ── Swap secrets in Vercel (prod + preview, both keys) ──────────────────────
for target in production preview; do
  remove_env SUPABASE_SERVICE_ROLE_KEY "$target"
  add_env    SUPABASE_SERVICE_ROLE_KEY "$target" "$NEW_SUPABASE_SERVICE_ROLE_KEY"
  remove_env TURNSTILE_SECRET_KEY      "$target"
  add_env    TURNSTILE_SECRET_KEY      "$target" "$NEW_TURNSTILE_SECRET_KEY"
done

# ── Rebuild locally with fresh env, then promote prebuilt ───────────────────
log "pulling fresh prod env…"
rm -rf .vercel/output
vercel pull .vercel/.env.production.local --environment=production --yes >/dev/null

log "building prod locally…"
vercel build --prod >/dev/null

log "deploying prebuilt to production…"
vercel deploy --prebuilt --prod --yes

log "env swap + prod deploy complete"
