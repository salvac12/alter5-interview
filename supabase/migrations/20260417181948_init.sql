-- Alter5 SW Architect Hiring — initial schema
--
-- Data model for public candidate flow:
--   applications  -- one row per candidate email
--   magic_links   -- one-use tokens (email verify, interview link, ARCO)
--   cvs           -- PDF metadata (files live in storage.objects:cvs/*)
--   analyses      -- Claude screening output
--   interviews    -- completed interview results
--   interview_answers  -- per-question detail
--   application_events -- GDPR audit log
--   admin_users   -- who can reach /admin and /reports
--
-- Auth model: we DO NOT use Supabase Auth for candidates. Custom flow:
--   email -> magic_link (token, sha256 hashed in DB) -> signed cookie session
--   API routes use SERVICE_ROLE key (bypasses RLS). RLS itself denies all
--   direct access from anon/authenticated roles, so a leaked anon key
--   grants nothing.

-- ─── Extensions ──────────────────────────────────────────────────────
create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ─── Enums ───────────────────────────────────────────────────────────
do $$ begin
  create type application_status as enum (
    'pending_verify',
    'verified',
    'cv_uploaded',
    'analyzed_pending_review',
    'analyzed_auto_invited',
    'analyzed_auto_rejected',
    'analyzed_manual_approved',
    'analyzed_manual_rejected',
    'interview_started',
    'interview_completed',
    'deleted'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type application_source as enum ('public', 'admin_manual', 'legacy');
exception when duplicate_object then null; end $$;

do $$ begin
  create type magic_link_purpose as enum ('verify_email', 'interview', 'privacy_arco');
exception when duplicate_object then null; end $$;

do $$ begin
  create type admin_role as enum ('superadmin', 'reports_viewer');
exception when duplicate_object then null; end $$;

-- ─── Tables ──────────────────────────────────────────────────────────

create table if not exists applications (
  id uuid primary key default gen_random_uuid(),
  email citext not null,
  source application_source not null default 'public',
  status application_status not null default 'pending_verify',
  consent_privacy boolean not null,
  consent_ai_decision boolean not null,
  requested_human_review boolean not null default false,
  name text,
  experience text check (experience in ('3-5','5-8','8-12','12+') or experience is null),
  apply_count integer not null default 1,
  apply_ip inet,
  apply_user_agent text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  cv_uploaded_at timestamptz,
  analyzed_at timestamptz,
  interview_started_at timestamptz,
  interview_completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '12 months'),
  deleted_at timestamptz
);

-- An active application (deleted_at is null) is unique per email.
-- After soft-delete we allow the same email to apply again.
create unique index if not exists uq_applications_email_active
  on applications (email) where deleted_at is null;

create index if not exists idx_applications_status on applications (status);
create index if not exists idx_applications_created on applications (created_at desc);
create index if not exists idx_applications_expires on applications (expires_at) where deleted_at is null;

create table if not exists magic_links (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  purpose magic_link_purpose not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_magic_links_app on magic_links (application_id);
create index if not exists idx_magic_links_expires on magic_links (expires_at) where used_at is null;

create table if not exists cvs (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  size_bytes integer not null,
  content_hash text not null,
  uploaded_at timestamptz not null default now()
);

create index if not exists idx_cvs_app on cvs (application_id);
create index if not exists idx_cvs_hash on cvs (content_hash);

create table if not exists analyses (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  cv_id uuid not null references cvs(id) on delete cascade,
  score integer not null check (score between 1 and 10),
  recommendation text not null check (recommendation in ('enviar','revisar','descartar')),
  summary text,
  raw_response jsonb,
  model text not null,
  analyzed_at timestamptz not null default now()
);

create index if not exists idx_analyses_app on analyses (application_id);
create index if not exists idx_analyses_score on analyses (score);

create table if not exists interviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  global_score numeric(3,1),
  dim_scores jsonb,
  flags integer default 0,
  answers_count integer default 0,
  skipped_count integer default 0,
  total_time_sec integer default 0,
  verdict text,
  ai_analysis_html text,
  recommendation text,
  final_score numeric(3,1),
  final_notes text,
  salary text,
  source application_source not null default 'public',
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists idx_interviews_app on interviews (application_id);
create index if not exists idx_interviews_completed on interviews (completed_at desc);

create table if not exists interview_answers (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references interviews(id) on delete cascade,
  question_idx integer not null,
  question_key text,
  question_type text,
  answer_text text,
  answer_options text[],
  time_sec integer,
  flag text,
  paste_count integer,
  paste_chars integer,
  tab_switches integer,
  burst_count integer,
  ai_flags text[],
  unique (interview_id, question_idx)
);

create table if not exists application_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  event_type text not null,
  event_data jsonb,
  actor text,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists idx_events_app on application_events (application_id, created_at desc);
create index if not exists idx_events_type on application_events (event_type, created_at desc);

create table if not exists admin_users (
  email citext primary key,
  name text,
  role admin_role not null default 'reports_viewer',
  created_at timestamptz not null default now()
);

-- ─── Row-Level Security ──────────────────────────────────────────────
alter table applications enable row level security;
alter table magic_links enable row level security;
alter table cvs enable row level security;
alter table analyses enable row level security;
alter table interviews enable row level security;
alter table interview_answers enable row level security;
alter table application_events enable row level security;
alter table admin_users enable row level security;

-- ─── Storage bucket for CVs (private) ────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cvs', 'cvs', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

-- ─── Seed admin users ────────────────────────────────────────────────
insert into admin_users (email, name, role) values
  ('salvador.carrillo@alter-5.com', 'Salvador Carrillo', 'superadmin'),
  ('miguel.solana@alter-5.com',     'Miguel Solana',     'reports_viewer')
on conflict (email) do update set name = excluded.name, role = excluded.role;

-- ─── Helper functions ────────────────────────────────────────────────

-- ARCO delete: soft-delete with PII scrub. Keeps audit trail intact.
create or replace function arco_delete_application(app_id uuid, reason text default 'candidate_request')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update applications
    set status = 'deleted',
        deleted_at = now(),
        email = concat('deleted+', id::text, '@invalid'),
        name = null,
        apply_ip = null,
        apply_user_agent = null,
        utm_source = null,
        utm_medium = null,
        utm_campaign = null
    where id = app_id and deleted_at is null;

  insert into application_events (application_id, event_type, event_data, actor)
    values (app_id, 'arco_delete', jsonb_build_object('reason', reason), 'system');
end;
$$;

-- Retention purge: scrub applications past expires_at. Called daily.
create or replace function purge_expired_applications()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  insert into application_events (application_id, event_type, event_data, actor)
    select id, 'retention_deleted', jsonb_build_object('reason', 'expired'), 'system'
    from applications
    where expires_at < now() and deleted_at is null;

  update applications
    set status = 'deleted',
        deleted_at = now(),
        email = concat('deleted+', id::text, '@invalid'),
        name = null,
        apply_ip = null,
        apply_user_agent = null,
        utm_source = null,
        utm_medium = null,
        utm_campaign = null
    where expires_at < now() and deleted_at is null;

  get diagnostics affected = row_count;
  return affected;
end;
$$;
