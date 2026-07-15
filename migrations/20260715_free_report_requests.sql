-- Commit 2 — Free First Report rate-limit store (ruling D). Run in the Supabase SQL editor
-- BEFORE the Commit 2 push (the request route reads/writes this table; inserts fail if absent).
-- Rows are pruned opportunistically inside the request route (older than 2 days), so this stays tiny.

create table if not exists public.free_report_requests (
  id          uuid        primary key default gen_random_uuid(),
  ip          text,
  created_at  timestamptz not null default now()
);

-- Indexes for the two count queries (per-ip-today, global-today) and the prune scan.
create index if not exists free_report_requests_created_idx    on public.free_report_requests (created_at);
create index if not exists free_report_requests_ip_created_idx on public.free_report_requests (ip, created_at);

-- Holds IP addresses (PII-adjacent). Same lock as free_report_tokens: RLS on, no policies,
-- grants revoked → only the service role (every server route, which bypasses RLS) can touch it.
alter table public.free_report_requests enable row level security;
revoke all on public.free_report_requests from anon, authenticated;
