-- Headhunter portal v1: external partners that upload CVs on behalf of
-- candidates. Admin invites by email, partner registers (name, company,
-- password), then logs in to the /partners portal to upload PDFs. The CV
-- pipeline (analyze → review queue) is unchanged; the candidate detail
-- in /admin shows the origin.

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists headhunters (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  name text,
  company text,
  password_hash text,                          -- scrypt format: scrypt$N$r$p$saltb64$hashb64
  status text not null default 'invited',      -- invited | active | disabled
  invited_by_email citext,
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  registered_at timestamptz,
  last_login_at timestamptz
);
alter table headhunters enable row level security;

-- Invite tokens are kept separate from `magic_links` because the latter has a
-- NOT NULL FK to applications (irrelevant for partner signup). Same token
-- pattern: only sha256(token) is persisted; the raw token only travels by
-- email.
create table if not exists headhunter_invites (
  id uuid primary key default gen_random_uuid(),
  email citext not null,
  token_hash text unique not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  invited_by_email citext,
  created_at timestamptz not null default now()
);
create index if not exists idx_hh_invites_email on headhunter_invites (email);
alter table headhunter_invites enable row level security;

-- ── Source enum + applications/cvs columns ──────────────────────────────────

alter type application_source add value if not exists 'headhunter';

alter table applications
  add column if not exists headhunter_id uuid references headhunters(id) on delete set null;

create index if not exists idx_apps_headhunter
  on applications (headhunter_id) where headhunter_id is not null;

-- Optional free-text note attached by the uploader (the headhunter) at the
-- moment of upload. Stored on the cv row, not the application, so multiple
-- CVs from the same partner can carry distinct notes.
alter table cvs
  add column if not exists uploader_note text;
