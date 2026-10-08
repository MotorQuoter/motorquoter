-- batch 229 — where free-report visitors came from (UTM capture). Run in the Supabase SQL editor.
-- Additive and idempotent. The code is safe either side of it: until it runs, the request route's attribution insert
-- and verify's UTM write fail, are logged ("[FREE REPORT] attribution insert failed" / "token utm write failed"),
-- and nothing a visitor sees changes. Rows written before it runs are simply not recorded.

-- 1) Permanent per-request record. free_report_requests is pruned after 2 days (FREE_REPORT_REQUEST_PRUNE_DAYS), so it
--    cannot hold attribution. This table is NEVER pruned and holds no email and no IP.
--    outcome: 'requested' (new link sent) | 'resent' (unused report emailed again) | 'capped' (per-IP or global cap).
create table if not exists public.free_report_attribution (
  id            uuid        primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  outcome       text        not null
);

create index if not exists free_report_attribution_created_idx on public.free_report_attribution (created_at);

-- Same lock as the other free-report tables: RLS on, no policies, grants revoked → service role only.
alter table public.free_report_attribution enable row level security;
revoke all on public.free_report_attribution from anon, authenticated;

-- 2) Follow the tag to confirmation and use: written at verify from the signed link. Consumption already sets
--    session_id on this row, so use is traceable from here.
alter table public.free_report_tokens add column if not exists utm_source   text;
alter table public.free_report_tokens add column if not exists utm_medium   text;
alter table public.free_report_tokens add column if not exists utm_campaign text;
