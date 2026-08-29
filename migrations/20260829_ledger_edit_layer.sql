-- Buyer ledger edits (batch 82). A separate, reversible, VERSION-STAMPED edit layer over the immutable
-- engine `assessment`. The assessment jsonb is NEVER mutated. `edit_layer` holds:
--   {
--     rerunStamp : int   -- the salvage_sessions.rerun_count the edits were made against
--     strikes    : [rowKey]                 -- engine-costed rows the buyer removed from the totals
--     adds       : [{ id, text, amount }]   -- the buyer's own free-text lines (their figure, not ours)
--     updatedAt  : timestamptz
--   }
-- Strikes are shown struck-through (never deleted from the page); adds are marked as the buyer's figure.
-- Both are reversible. The free re-run (app/api/salvage/rerun) nulls `assessment` and writes a fresh one
-- to the SAME row, incrementing rerun_count — so an edit layer whose `rerunStamp` no longer matches the
-- current rerun_count is KEPT (it is valid calibration data about the assessment it was made against)
-- but NOT applied (lib/ledgerEdits.applyEdits scopes on the stamp). Written only by the service-role
-- edits route (app/api/salvage/edits); the client never writes it directly. Deploy-before-apply is safe:
-- the edits route no-ops if the column is absent and the render/PDF treat a null edit_layer as "no edits".
alter table salvage_sessions
  add column if not exists edit_layer jsonb;
