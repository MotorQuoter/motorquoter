-- Commit 1 — Free First Report (Option A). Run in the Supabase SQL editor.
-- Adds the free-report entitlement table and the payment_kind stamp on salvage_sessions.
-- No admin DB connection exists (TASK-0 §3.1) — Vincent executes this and confirms before the
-- Commit 1 code push (the stamps reference payment_kind, which must exist on the shared DB first).

-- 0) PK FIX (reconciled to what actually ran — this repo file is the schema truth).
--    salvage_sessions predates this work and had NO primary key on `id`. TASK-0 reported `id` as a
--    PK from the PostgREST OpenAPI, but that read was wrong: the free_report_tokens.session_id
--    foreign key in section 1 failed at run time until a primary key was added here. A live-DB
--    error outranks the OpenAPI. One-time (not idempotent — errors if a PK already exists); must
--    precede the FK below.
alter table public.salvage_sessions add primary key (id);

-- 1) Free-report entitlement table — one free salvage assessment per verified email.
--    The UNIQUE(email_normalised) constraint IS the one-per-email rule (database-enforced,
--    not application logic). token is the single-use credential that rides the promoToken path.
create table if not exists public.free_report_tokens (
  id                uuid        primary key default gen_random_uuid(),
  email_normalised  text        unique not null,
  token             uuid        unique not null default gen_random_uuid(),
  issued_at         timestamptz not null default now(),
  consumed_at       timestamptz,
  session_id        uuid        references public.salvage_sessions(id),
  issue_ip          text,
  marketing_opt_in  boolean     not null default false,
  brevo_synced_at   timestamptz
);

-- 2) SECURITY — this table holds emails (PII) and single-use tokens (secrets). TASK-0 §3.4 proved
--    the PUBLIC anon key can read salvage_sessions (RLS off there); a raw table is anon-readable
--    by the same key. Enable RLS with NO policies so only the service role (every server route,
--    which bypasses RLS) can touch it; revoke table grants belt-and-braces.
alter table public.free_report_tokens enable row level security;
revoke all on public.free_report_tokens from anon, authenticated;

-- 3) payment_kind stamp on salvage_sessions (piece 1b) — additive, nullable, backward-compatible.
--    Values: 'paid' | 'promo' | 'free_report'. Retires the fragile promoToken/stripe_session_id
--    inference (TASK-0 §3.2). The 'free_report' value is written by the Commit 3 free path.
alter table public.salvage_sessions add column if not exists payment_kind text;
