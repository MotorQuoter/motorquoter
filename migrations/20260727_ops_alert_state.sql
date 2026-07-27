-- Throttle store for lib/opsAlert.mjs — one row per alert `kind` (e.g. 'claude-platescan',
-- 'claude-assess') holding the last-send time, so a Claude infra outage emails at most once
-- per 60 min instead of storming. Writes come from server routes via the service-role key;
-- opsAlert fail-opens (sends anyway) if this table is absent, so deploy-before-apply is safe.
create table if not exists ops_alert_state (
  id text primary key,
  last_sent_at timestamptz not null
);

alter table ops_alert_state enable row level security;
-- no anon/authenticated policy — service-role only (bypasses RLS); nothing client-side touches it.
