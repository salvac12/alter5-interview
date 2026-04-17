# Privacy & GDPR — Alter5 Hiring Platform

Reference for the DPO (`privacy@alter-5.com`) and auditors.

## Controller

Alter5 Financial Technologies, S.L. (Madrid). DPO contact:
`privacy@alter-5.com`.

## Lawful basis

Consent (art. 6.1.a GDPR) for the processing of CV and interview data
in the context of a specific hiring process. Consent is captured
explicitly in two checkboxes before form submission:

1. `consent_privacy` — acknowledges the privacy annex at
   `/apply/privacy` and authorizes data processing for this selection
   process only.
2. `consent_ai_decision` — authorizes automated screening (art. 22
   GDPR). A "request human review" toggle allows candidates to opt
   into manual-only review; when set, the CV never triggers auto-invite
   regardless of score.

Both flags are persisted on `applications`. A candidate who does not
accept both cannot submit the form (enforced client + server side).

## Data categories stored

- Identification: email, name (optional at apply-time).
- Context: experience range, UTM attribution.
- Technical: apply IP, user-agent (for audit only; scrubbed on delete).
- Candidacy documents: CV PDF (Supabase Storage, private bucket `cvs`).
- AI screening output: score 1–10, recommendation, summary.
- Interview results: per-question answers, timings, anti-copy flags,
  global and per-dimension scores, AI-generated HTML analysis.

Sensitive categories (art. 9) are NOT requested.

## Retention

12 months from `created_at`. Enforced by the `expires_at` column
(default `now() + interval '12 months'`) and a daily cron
(`/api/cron/purge-expired`) that calls the SQL function
`purge_expired_applications()`. The function soft-deletes the row
(`status='deleted'`, `deleted_at=now()`) and scrubs PII: email is
replaced with `deleted+<uuid>@invalid`, `name`, `apply_ip`,
`apply_user_agent`, and UTM fields are nulled.

A row in `application_events` is written with `event_type='retention_deleted'`
to preserve an anonymized audit trail.

## Candidate rights (ARCO)

All handled self-service via `/privacy/my-data`:

- **Access (art. 15)** — email prompts an ARCO magic link (30 min,
  one-use, sha256-hashed in DB). With a valid token, the candidate sees
  all data held about them.
- **Portability (art. 20)** — JSON export of the above.
- **Erasure (art. 17)** — one-click delete calls
  `arco_delete_application()` which performs the same soft-delete +
  PII scrub as the retention cron. Before the RPC runs, the token is
  consumed to prevent retry-after-crash races.
- **Rectification / limitation / opposition (art. 16, 18, 21)** — manual
  via `privacy@alter-5.com`.

Request-access never leaks whether an email is on file: the endpoint
always returns `{ok:true}`.

## Subprocessors

- **Supabase (EU/Frankfurt)** — database + CV storage.
- **Resend** — transactional email (magic links, ARCO).
- **Anthropic (Claude Sonnet 4)** — CV + interview analysis. Prompt
  content includes candidate CV text and interview responses. Anthropic
  does not train on API-submitted content.
- **Cloudflare Turnstile** — bot protection on public forms.
- **Vercel** — hosting + cron.

## Security controls

- CVs in a private Supabase bucket; served to admins only via short-
  lived signed URLs (`createSignedUrl`, 10 min TTL).
- Magic links: 32-byte random tokens in emails, sha256-hashed in DB;
  single-use; 30-min TTL for apply/ARCO, 7-day TTL for interview
  invites.
- Admin surface (`/admin`, `/reports`, `/api/admin/*`) behind Basic Auth
  + per-IP rate limiting in middleware.
- RLS enabled on every table; anon/authenticated roles have no direct
  access. All writes go through API routes using the service-role key.
- Transport: HSTS `max-age=2y`, X-Frame-Options DENY, referrer `no-referrer`.
- Prompt-injection defense on AI analysis: candidate-supplied text is
  wrapped in tagged XML blocks and breakout tokens are stripped.

## Anti-fraud signals

Interview submissions record `paste_count`, `paste_chars`,
`tab_switches`, and typing-burst counters per answer. These feed the
anti-IA flag column but do not block submission; they inform human
review.

## Incident response

- Data breach notification → DPO within 24 h; AEPD within 72 h if
  applicable.
- Log sources: Vercel runtime logs, Supabase audit logs,
  `application_events` for candidate-level traceability.

## Complaints

Candidates may lodge complaints with the Spanish DPA (AEPD) at
<https://www.aepd.es>.
