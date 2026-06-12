# fable5-probe — carry-back candidates for core-slots

*Items proven on the probe branch that protect Opus too. None applied to core-slots yet — each needs its own commit + proof there. 2026-06-10.*

## 1. stop_reason=max_tokens fail-loud (main assess call, both sites)
Pre-existing gap: any non-tool_use stop is silently accepted as final prose (route.js `!== 'tool_use'` branch). Run-1 truncation was this. Fail loud — run discarded, identical pattern to the refusal check. Protects Opus: an Opus response that ever exceeds the ceiling would today render a truncated report.

## 2. stop_reason=refusal fail-loud (main) / loud-log + soft-fail with status (lamp-detect)
Same silent-acceptance species. Lamp-detect soft-fails by design (lamp absence is a handled state) but must record WHY it returned null — status enum in the run record / log line.

## 3. lamp-detect: read text blocks, not content[0]
`data.content?.[0]?.text` is a positional read that breaks whenever block 0 is not a text block (thinking blocks on Fable 5 always-on; any future model emitting non-text first). Filter `type === 'text'` and join — same pattern as the main call's rawText assembly. Reading machinery, not steering.

## 4. normName parenthetical-collapse — latent join-identity defect (RECLASSIFIED from quirk)
`normName` strips parentheticals (`.replace(/\s*\([^)]*\)/g,'')`), so any same-base-name part pair shares one identity at the gate join: both rows `find()`-match the SAME first verdict entry, strip logs print the first name twice, and the flag dedupe collapses two stripped parts into one flag.
**Worked example:** a future lot with `Door mirror (left)` and `Door mirror (right)` — both normalise to `door mirror`; one iv=true / one iv=false would apply ONE verdict to BOTH lines. Observed on SF69YBB run-2 (`Front headlamp (one side)/(other side)`, both iv=false — benign there only because the verdicts agreed and reconcile normally absorbs lamp lines first).
No fix now; needs a join key that preserves the parenthetical qualifier.

## 5. Adjacency-misattribution mechanism + two-pass challenge question
Ground-truthed failure class (exposed-substrate false positive) unifying
the SF69YBB rear-quarter and bonnet findings across both model generations.
Full section in VERDICT-NOTES.md ("MECHANISM — Adjacency misattribution").
DESIGN INPUT for the decorrelated two-pass build; explicitly NOT a
single-pass prompt change. Must survive into docs/ with the rest of the
durable outputs.

## 6. Lamp-allowance silent extraction (observability)
reconcileParts removes surplus lamp rows to allowanceParts with no per-part
log (route.js:978–982; also lamp-insert branches 985/994/997). Exact
"silent pass" shape under the Phase 2 re-state principle. Fix: emit a
[LAMP][ALLOWANCE] line per extracted row, mirroring [GATE] stripped.

## 7. Lamp order-dependence money hazard (HIGH)
Reconcile keeps lampIndices[0] regardless of independentlyVisible. Mirror
ordering (iv=false lamp first) keeps the unconfirmed lamp priced, sends the
confirmed one to allowance, gate then strips the kept lamp → repair total
carries ZERO priced lamps while lamp_inserted/lamp_delta assume one. Silent
repair understatement ≥ one lamp band (£350+ LED), decided by model row
order. BL75JAU run 2 was one ordering away. Fix is a design decision
(iv-aware keep-selection or gate-aware allowance merge) — built right at
carry-back application, not patched. Include removal of the dead _allowance
pass-through at route.js:1970.
Per-run watch until fixed: a [GATE] stripped line naming a lamp while
lamps=2 → that run's repair total is distorted; disposition must say so.

## 8. Wheel-net checklist contradiction
Unconditional eight-line "not clearly visible" wheel/tyre append renders
alongside costed, prose-confirmed wheel destruction (BL75JAU 3/3).
User-falsifiable incoherence. Fix: wheel-net lines must yield where run
evidence confirms a wheel/tyre's condition.

## Watch items (not carry-back yet)
- **38K unexplained cache_creation on the final call of front-struck (2-call) runs** — observed SF69YBB run-3 (write=38,317 beyond the system breakpoint, input=13). TTL unknown → $0.48–$0.77 cost spread per run. Confirm reproduction on next front-struck run.
- **frontStruck regex single-source** — reads only listing primaryDamage/secondaryDamage (paste-derived); never consults the salvage-history record damage descriptors the route already fetches. Bit run-2 (null fields → dead lamp path). Mitigated operationally by the paste checklist; a real fix would OR-in `rec.*_damage_desc`.

## 9. Flag-render dedup review (Q4, parked 12 Jun)
Flag-render dedup review: normName-based dedup (:1905) may double-flag lamps
with variant phrasings; related: run-2 front-tyres strip row absent from
rendered Inspection Flags (12 Jun, unadjudicated). Review together, post-CB7.

## 10. PDF parts-table prose-fallback path (not scheduled)
pdf/route.js:524-526 — if _reconciledParts absent, the PDF parts table falls
back to parsing assessment['Parts Breakdown'] prose; the repair banner still
reads _partsReconciliation.parts_sum. Latent display inconsistency: table rows
and banner value may not agree if the fallback fires. Logged 12 Jun, not scheduled.

## 11. Radiator double-row — CLOSED 12 Jun
Mechanism: parts-survival loop (parts.mjs:167–196) has no already-matched
tracking; duplicate rawParts rows both match one iv=true verdict and both
survive to gatedParts — duplicate money IN the displayed floor (observed live,
SF69 S1). Separate from CB9. Fix shape is a design decision (reconcile-time
name dedup vs consumed-verdict tracking) — own audit-and-propose before THE merge.

CLOSED 12 Jun: consumed-verdict Set fix (bd98a04); fixture-proven (CB11, harness 20/20); regression-clean across 4 live validation runs.

## 12. Physical section wheel/tyre slots (not scheduled)
8 unconditional rows, _slots render path, route.js:1919–1923. Render
'not clearly visible' beside costed wheel/tyre parts — same coherence class
as CB8, slots surface. Product decision owed (adapt like CB8 or stay
unconditional). Logged 12 Jun, not scheduled.

## 13. Lamp tier-1-by-silence — PRE-MERGE FIX REQUIRED
Observed live: SF69YBB 15:49 run, iter=0 stop=end_turn output=3907 —
model never fired recordLampObservation on a genuinely struck front
(bumper displaced, ground-truth band condition met). Floor at
route.js:1774–1777 forced apertureExposed:false → tier 1 → lamps=0,
£350 band absent from displayed total. [LAMP ORPHAN] watchdog fired
correctly. Mitigation in current output: model lamp row gate-stripped
AND flagged, so the omission is disclosed under Phase 3 framing —
honest but violates the unconditional-band lock. Fix shape is a
design decision (fail-loud + retry when frontStruck && no lampObs, vs
code-side trigger fallback) — own audit-and-propose before THE merge,
alongside item 11.

RE-DIAGNOSIS 12 Jun: the founding 15:49 incident, the 18:20 run, and
the SF69 Fable probe 'lamp inert' runs were ALL the null-null class —
the Copart listing paste truncated at 'V5 available:', structured
damage lines absent, primaryDamage/secondaryDamage stored null,
frontStruck=false, lamp tool never OFFERED (not declined). Zero
confirmed instances of true model-silence on a frontStruck lot to
date. The item 13 forced-call fix STANDS as defence-in-depth for the
silence class (BL75JAU live-proven 17:26: iter=0 stop=tool_use, 97
tokens, observation extracted) but had no reach on these sessions.
The real defect is item 14: trigger input integrity.

CLOSED 12 Jun: defence-in-depth forced-call fix (8b211a1); live-proven BL75JAU 17:26 (iter=0 stop=tool_use, forced) per re-diagnosis note; null-null class addressed by item 14.

## 14. Lamp trigger single-point-of-failure — CLOSED 12 Jun
£350–£700 of code-owned band money hangs entirely on two pasted text
lines. Proven same-lot: SF69 morning paste carried 'Front
End'(secondary) → frontStruck=true → £350 banded; afternoon pastes
truncated → null-null → entire lamp machinery silently off (tool,
detect, band). Ratified design: Layer 1 = offer LAMP_OBS_TOOL
unconditionally, force only when text fields say front, voluntary
otherwise; Layer 2 = post-Call-2 backstop — perZone contains
front/impact && lampObs null → one targeted forced observation call;
Layer 3 = [LAMP][TRIGGER] log line every run stating which source
armed (or failed to arm) the lamp path. No path guesses
apertureExposed — every path obtains it from model observation.

CLOSED 12 Jun: layered fix (54e04e1); matrix 4/4: truncated SF69 banded (source=voluntary-iter0; layer 1 live-proven, layer 2 fixture-proven only, self-announces via [LAMP][TRIGGER] on first natural fire), full SF69 text-forced, BL75JAU regression clean, LB18HDU no-arm control clean.

## 15. Left/right prose-ban drift — PRE-MERGE FIX REQUIRED (pending Vincent ratification)
Left/right prose-ban drift with DEMONSTRATED ERROR. Sighting 1: BL75JAU 18:15 —
offside/nearside in prose + parts-table names, content correct. Sighting 2:
LB18HDU 18:20 — 'driver's-side flank' named in prose AND WRONG: ground truth
(Vincent, photo-verified) is the burn sits on the OPPOSITE flank. The ban exists
because side assignment is model-unreliable; sighting 2 is that unreliability
published to a buyer. Fix shape = audit-and-propose (must spare quoted DVSA/MOT
text per the 12 Jun exemption; options: banned-term detect → substitute
'damaged-side' / fail-and-reroll / flag).
