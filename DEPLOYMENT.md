# Deployment — Alter5 Hiring Platform

End-to-end runbook for deploying the candidate-driven hiring platform at
`careers.alter-5.com`.

---

## 1. Supabase

Project: `srplzxewceuamubcbnzc` (Alter5-SW_Architect_Hiring, Frankfurt).

```bash
# Link once
supabase link --project-ref srplzxewceuamubcbnzc

# Push schema
npm run db:push
```

Verify in the dashboard:

- Tables: `applications`, `magic_links`, `cvs`, `analyses`, `interviews`,
  `interview_answers`, `application_events`, `admin_users`.
- Functions: `arco_delete_application`, `purge_expired_applications`.
- Storage bucket `cvs` (private, 10 MB limit, `application/pdf`).
- RLS enabled on every table (deny-all — service role bypasses).
- Seeded `admin_users`: `salvador.carrillo@alter-5.com` (superadmin),
  `miguel.solana@alter-5.com` (reports_viewer).

## 2. Vercel env vars

Set these in **Project Settings → Environment Variables** for both
Production and Preview:

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | `https://srplzxewceuamubcbnzc.supabase.co` |
| `SUPABASE_ANON_KEY` | from Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | ⚠ server-only, bypasses RLS |
| `ANTHROPIC_API_KEY` | Claude Sonnet 4 key |
| `RESEND_API_KEY` | Resend (domain `alter-5.com` must be verified) |
| `ADMIN_USER` | Basic Auth user (e.g. `admin`) |
| `ADMIN_PASS` | strong random — `openssl rand -base64 32` |
| `SESSION_SECRET` | `openssl rand -hex 32` — cookie signing |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile (public) |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile (server) |
| `CRON_SECRET` | `openssl rand -hex 32` — guards `/api/cron/*` |
| `INTERVIEW_BASE_URL` | `https://careers.alter-5.com` |
| `APPLY_BASE_URL` | `https://careers.alter-5.com/sw-architect` |
| `INTERVIEW_BOOKING_URL` | Google Calendar Appointment URL (Salva) |

## 3. Resend

1. Verify domain `alter-5.com` (SPF + DKIM records).
2. Ensure `hiring@alter-5.com` is the sender and `careers@alter-5.com`
   is configured as reply-to. `privacy@alter-5.com` is referenced in
   GDPR footers and must be a real inbox.

## 4. Cloudflare Turnstile

Create a site at
<https://dash.cloudflare.com/?to=/:account/turnstile> bound to
`careers.alter-5.com`. Use the managed widget; set keys above.

## 5. Google Meet / Appointment schedule (Salva)

Create a 30-min appointment schedule in Google Calendar. Copy the public
booking URL and set it as `INTERVIEW_BOOKING_URL`. The interview
completion screen renders this link automatically; if unset, the box is
hidden.

## 6. DNS — `careers.alter-5.com`

In the `alter-5.com` DNS zone, add a CNAME `careers` →
`cname.vercel-dns.com`. In Vercel → Project → Domains, add
`careers.alter-5.com`. Vercel will issue the TLS cert automatically.

## 7. Cron

`vercel.json` declares:

```json
"crons": [
  { "path": "/api/cron/purge-expired", "schedule": "0 3 * * *" }
]
```

Vercel Cron adds `Authorization: Bearer $CRON_SECRET` automatically.
The endpoint calls `purge_expired_applications()` which soft-deletes +
PII-scrubs any `applications` row past its 12-month retention.

## 8. Smoke tests

```bash
PLAYWRIGHT_BASE_URL=https://careers.alter-5.com npx playwright test
```

The suite covers: public page loads, security headers, admin auth
gating, rate limits, token-guarded endpoints, privacy self-service
request form. It is read-only and safe to run against production.

## 9. Manual acceptance checklist

- [ ] `/sw-architect` renders, form submits, magic link arrives.
- [ ] Magic link → `/apply/upload` accepts a PDF ≤ 5 MB.
- [ ] CV ≥ 7 → auto-invite email sent.
- [ ] CV 4–6 → appears in `/admin` review queue.
- [ ] CV < 4 → silent rejection (no email).
- [ ] Interview link → `/interview` loads questions, submits, persists.
- [ ] Interview success screen shows the booking link.
- [ ] `/privacy/my-data` request-access sends the ARCO email.
- [ ] ARCO token → view, export JSON, delete (soft-delete + scrub).
- [ ] `/admin` (Basic Auth) → review queue, all apps, manual upload.
- [ ] `/reports` (Basic Auth) → funnel, histogram, CSV export.
- [ ] Cron runs daily at 03:00 UTC and logs `affected`.
