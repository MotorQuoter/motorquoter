# fable5-probe — verdict notes (accumulating)

*Raw findings for the §5/§6 verdict write-up. Updated per run. 2026-06-10.*

## Deployment-honest comparison framing
The swap changed two variables by API construction, not by choice: model AND thinking-enabled.
Fable 5 cannot run thinking-free (always-on, cannot be disabled — docs adaptive-thinking.md);
Opus 4.8 runs thinking-free when `thinking` is omitted. We compare what each model does when
MotorQuoter calls it. Thinking is ~60-70% of Fable output tokens (chars÷4 attribution) and the
dominant cost driver: valid Fable runs $1.31–$2.23 vs Opus est. ~$0.35–0.70.

## Swap-phase implications (operational, from run-4 race)
- Client fetch timeout ~180s hypothesis: original GET 16:01:00 local aborted client-side at
  +2m58s (duration 3m4s, Status 0, request bzs4h-1781103660706); re-fire GET 16:03:59 got 409
  in 738ms (request p8zkx-1781103839042) — five seconds before the original completed and wrote.
- Fable wall-time ~3m makes the race RESONANT, not occasional. Any swap phase must fix the
  client timeout/retry UX before Fable serves real customers. Observation only — no probe fix.
- Related stale-lock gap: maxDuration=300s kill leaves status='processing' wedged (no timeout
  recovery on the lock; catch never runs on a hard kill). Recovery: manual status reset.
- Run disposition drill when failure screen appears near ~3min: wait → confirm assessed in DB →
  Retry (idempotent fetch of stored report). NEVER resubmit.

## §4a — rear quarter (headline binary)
Costed iv=true in 3/3 observed Fable runs (run-2 excluded-retained, run-3 valid, run-4 valid).
Same signature as the Opus fabrication. Two-pass justification holding so far.

## §4b — stability axes
- Bonnet, CATEGORY variance (new axis distinction): run-2 costed £200, run-3 costed £220,
  run-4 NOT costed — flagged medium (iv-disciplined read). Fable varies the bonnet across the
  costed/flagged BOUNDARY; Opus varied cost only (£220–260 band). Verdict must distinguish
  cost-variance from category-variance.
- Exit band: STABLE — mid-low £6,941 on both valid runs (3, 4).
- Lamp-detect: run-3 no_json (parse bug, fixed 1bee99b), run-4 ok — both corners present,
  halogen, coherent evidence; tool path agreed (full_width, 2 lamps, £150 band ×2).
  Axis measurable from run-4 onward.

## §4c — substrate & discipline compatibility
- stop_reason=tool_use obeyed on both valid runs (tool_use → end_turn); schema followed.
- Prose-discipline letter-break is TEMPLATE-CONSISTENT Fable behaviour (reclassified from
  one-off): "not included in repair total" in the lamp checklist item, 2/2 valid runs, same
  wording. Cost-status claim in prose; no table contradiction observed. Rule obedience does
  not transfer between models — confirmed.
- Cache: two lineages per model (front-struck with LAMP_OBS_TOOL in prefix = 31,208; without
  = 30,484). Run-3 final-call 38,317 cache_creation did NOT reproduce on run-4 (creation=0) —
  one-off cost, entry not reusable across runs; watch downgraded.

## Run ledger (SF69YBB, claude-fable-5)
| Run | Session | Disposition | Cost |
|---|---|---|---|
| 1 | fcdd34ec | DISCARDED — max_tokens truncation (pre-fix) | ~$1.35 est |
| 2 | 8ddb3cd6 | EXCLUDED — incomplete paste, lamp path dead; retained for findings | $0.875 |
| 3 | 7ef4f79d | VALID | $1.94–2.23 |
| 4 | 946d5828 | VALID | ~$1.31 |
| 5 | 1a307a3a | VALID — closed 11 Jun; SF69YBB Fable complete 3/3 | — |

## Run ledger (SF69YBB, claude-opus-4-8 — State B, e1fa14a)
| Run | Session | Disposition |
|---|---|---|
| 1 | aa244b5c | VALID + MANDATORY DISTORTION NOTE — servedModels opus-4-8 both calls, stops tool_use→end_turn, lampDetect ok. DISTORTION NOTE: "CB7 fired: gate stripped the reconcile-kept lamp (Front headlamp corner 1); displayed repair £4,120 contains ZERO priced front lamp money (verified by line-summing). Corrected comparison figure ~£4,470 (+£350 lamp band)." |
| 2 | 73f8dcc6 | VALID + MANDATORY DISTORTION NOTE — servedModels opus-4-8 both calls, stops tool_use→end_turn, lampDetect ok. DISTORTION NOTE: "CB7 fired: gate stripped the reconcile-kept lamp (Front headlamp one side); displayed repair £3,200 contains ZERO priced front lamp money (verified by line-summing). Corrected comparison figure ~£3,550 (+£350 lamp band)." |
| 3 | 7d7d639d | VALID + MANDATORY DISTORTION NOTE — servedModels opus-4-8 both calls, stops tool_use→end_turn, lampDetect ok. DISTORTION NOTE: "CB7 fired: gate stripped the reconcile-kept lamp (Front headlamp struck corner 1); displayed repair £3,730 contains ZERO priced front lamp money (verified by line-summing). Corrected comparison figure ~£4,080 (+£350 lamp band)." |

**SF69YBB Opus block CLOSED: 3 valid (all CB7-distorted). FULL PROBE MATRIX COMPLETE: SF69YBB Fable 3/3 + Opus 3/3; BL75JAU Fable 3/3 + Opus 3/3 + 1 excluded-retained. CB7 final tally: fired 5/7 instrumented Opus observations.**

## Run ledger (BL75JAU, claude-fable-5)
| Run | Session | Disposition |
|---|---|---|
| — | bcacd0d7 | NOT A PROBE RUN — went to production main (dpl_5btxH1wUgcAN7DVmkvKhhdrgSuXV, opus strings, no _probe); inadmissible per §2 |
| 1 | 3c824e21 | VALID |
| 2 | c30e687d | VALID — zero [GATE] lines explained (gate-bypass diagnosis below) |
| 3 | 4f370863 | VALID |

## Run ledger (BL75JAU, claude-opus-4-8 — State B, e1fa14a)
| Run | Session | Disposition |
|---|---|---|
| 0 | af8d3b10 | EXCLUDED — retained for findings. Assess executed fully server-side 12:48:51→12:50:01 UTC on opus-4-8 (single 200, no abort/409) but client never loaded /salvage/success — error screen perceived as run-not-executing; resubmitted 12:53 = run 1. CARRY-BACK-7 WATCH HIT: [GATE] stripped "Front headlamp (corner A)" while lamps=2 → repair £3,170 carries ZERO priced lamps, understated ~£350. Export: run-0-excluded.json |
| 1 | 7b24a321 | VALID — servedModels opus-4-8 both calls, stops tool_use→end_turn, lampDetect ok; both lamps iv=true, no gate strip, repair £3,145 includes one priced lamp |
| 2 | c6567f26 | VALID + MANDATORY DISTORTION NOTE — servedModels opus-4-8 both calls, stops tool_use→end_turn, lampDetect ok. DISTORTION NOTE: "CB7 fired: gate stripped the reconcile-kept lamp; displayed repair £3,245 contains ZERO priced lamp money (verified by line-summing). Corrected comparison figure ~£3,595 (+£350 lamp band). Use the corrected figure for any cross-run repair comparison." |
| 3 | def6f287 | VALID — servedModels opus-4-8 both calls, stops tool_use→end_turn, lampDetect ok. Lamp watch did not fire. £3,045 sum verified clean, includes one priced lamp |

**BL75JAU Opus block CLOSED (11 Jun runs, ledgered 12 Jun): 3 valid (runs 1, 2, 3), 1 excluded-retained (run 0). BL75JAU matrix complete on both sides — Fable 3/3 VALID, Opus 3/3 VALID + 1 excluded-retained.**

### af8d3b10 forensics (11 Jun, closed)
- Token-log timeline: request start 12:48:51.391Z (log entry r4w24-1781182131391,
  branch-alias host, dpl_AHJTh96uY7YwC7vTU3TnGUqHWwQz). TOKEN LOG iter=0
  in=22068/out=142 tool_use; lamp-detect in=21390/out=245 end_turn; iter=1
  in=121/out=3762 end_turn — Model: claude-opus-4-8 on all. _probe capture
  12:50:01.266Z → ~70s wall (Opus; no client-timeout exposure).
- Cache: iter=0 write=31,208 read=0 — first Opus call paid the full prefix
  write (cache is model-keyed; Fable entries don't serve Opus). Run 1 then
  read 31,208. One lineage write per model per TTL, expected.
- Promo redemptions 12:40–12:55 UTC: exactly 2 (promo-checkout 200s at
  12:48:50 and 12:53:20; sessions af8d3b10 + 7b24a321, both promoToken
  present; no other sessions any status in window). MQDEAL01 now 16/50.
- Visibility resolution: BOTH submissions completed server-side. af8d3b10's
  flow has NO GET /salvage/success — the failure was client-side navigation/
  render before the success page; the "credit-exhaustion" screen left no
  server-side trace and cannot be attributed from these logs. 7b24a321's
  flow shows the normal checkout → success → assess sequence.

## MECHANISM — Adjacency misattribution / exposed-substrate false positive
*Ground-truthed by Vincent 11 Jun 2026 from lot photos 53003666_Image_4 (rear three-quarter) and 53003666_Image_7 (bonnet open). Unifies the SF69YBB rear-quarter fabrication and the bonnet costing variance as ONE failure class present on BOTH model generations.*

### The mechanism
When a bumper or trim piece is torn away, it exposes structure that is normally
concealed: the rough under-bumper section of the adjacent panel, mounting points
and brackets (often hanging/fragmented), and the bumper-locating edge — which
reads as a thin seam when the bumper is intact but presents as a raw pressed
edge when it is gone. The model resolves "torn material + raw edges in this
zone" to damage on the nearest large nameable panel. The torn material is real;
the attribution is wrong.

### Instances
- **Rear quarter (SF69YBB):** rear bumper ripped off offside → exposed
  under-bumper quarter section + locating edge + hanging mounts → model costs
  "quarter panel", `independentlyVisible=true`, on Opus AND Fable, every run.
  The painted visible quarter above the bumper line is straight.
- **Bonnet (SF69YBB):** damage is on the narrow panel ahead of the bonnet
  (slam panel / front upper panel zone, clearest in the bonnet-open photo);
  bonnet leading edge is clean. Opus costed "bonnet" 3/3 (stable soft
  fabrication); Fable costed 1/3, flagged-not-costed 2/3.

### Why this explains the stability
The fabrication is consistent across runs and across two model generations
because the stimulus is genuinely present and genuinely ambiguous — this is a
systematic misread, not noise. It also explains why self-attestation fails:
the model sincerely sees torn material (run-5: "torn metal is visible and
real" — pre-arguing against correction). It is mislocating damage, not
inventing it. Any gate must challenge the ATTRIBUTION, not the perception.

### Verdict-note consequences
- Bonnet branch resolved: BOTH models mislocalise the front-panel damage.
  Opus = stable phantom-part costing 3/3; Fable = 1/3 fabrication, 2/3 honest
  hedge. Fable's distribution leans correct; neither model is right.
- Stable run-to-run consistency is evidence of stability, NOT truth — Opus's
  3/3 bonnet costing would never have been caught by variance checks.
- Pending grep (all 8 runs, costedParts + flaggedParts, raw JSON):
  bonnet / slam / front panel / crossmember / grille — to confirm whether
  EITHER model ever costed the genuinely damaged slam-panel zone. If absent
  everywhere: both repair figures are missing the real part, AND the zone is
  flagged as frontal-module territory.

### Candidate two-pass challenge question (DESIGN INPUT — not for the single-pass prompt)
> "Where a bumper or trim piece is detached or missing, the newly exposed
> substrate, mounting points, and locating edges are not evidence of damage to
> the adjacent panel. Does this panel show deformation independent of exposed
> mounting structure?"

Routing rationale, recorded so it is not relitigated later:
- This wording must NOT go into the single-pass prompt. It is a wording fix
  aimed at a perception-class fabrication; self-policing by the same forward
  pass is already proven not to work (self-attestation, run-5 pre-argument).
- Worse, in single-pass it risks over-gating REAL adjacent-panel damage on
  lots where the bumper is off and the quarter genuinely is struck — common
  on rear-corner hits. Same lesson as the killed geometry gate.
- It is class-level and lot-agnostic (passes the orientation-anchor ban), and
  belongs as the adversarial question carried by the SECOND pass of the
  decorrelated two-pass build, whose job is to challenge attributions.
- Status: hypothesis. Even inside two-pass it requires its own validation —
  Edit A discipline applies.

### Grep result (8 runs)
*11 Jun 2026. Source: raw pre-gate arrays only. Fable rows from disk exports
(`_probe.costedParts`/`flaggedParts`; costs from `_probe.rawParts`). NO disk
exports exist for Opus runs — rows O1–O3 read from Supabase `_preGateParts`
of the three pre-probe SF69YBB sessions of 9 Jun (16:27/17:24/18:26 UTC),
identified as the Opus controls by their bonnet costs matching the recorded
£220–260 band. Terms: bonnet, hood, slam, front panel, upper panel,
crossmember, cross member, grille, lock platform, radiator support.*

| Run | Model | Disposition | Bonnet entry (array, action, cost) | Slam-panel-zone entry (term, array, action, cost) |
|---|---|---|---|---|
| F1 fcdd34ec | claude-fable-5 | DISCARDED (truncation — no parts data at all) | absent | absent |
| F2 8ddb3cd6 | claude-fable-5 | EXCLUDED-retained | costedParts iv=true; rawParts repair £200 OEM | absent |
| F3 7ef4f79d | claude-fable-5 | VALID | costedParts iv=true; rawParts repair £220 OEM | absent |
| F4 946d5828 | claude-fable-5 | VALID | flaggedParts weight=medium — NOT costed | absent |
| F5 1a307a3a | claude-fable-5 | pending | flaggedParts weight=low — NOT costed | absent |
| O1 4434c409 | claude-opus-4-8 (pre-probe) | control | _preGateParts "Bonnet" repair £220 | "slam" — _preGateParts "Slam panel/front upper tie bar" repair £260 (used £120) |
| O2 55185779 | claude-opus-4-8 (pre-probe) | control | _preGateParts "Bonnet" repair £260 | "slam" — _preGateParts "Slam panel / upper tie bar" repair £300 |
| O3 d481910f | claude-opus-4-8 (pre-probe) | control | _preGateParts "Bonnet" repair £260 | absent (incl. its _flaggedParts) |

- Bonnet named: 5 of 8 runs costed (F2 £200, F3 £220, O1 £220, O2 £260, O3 £260) / 2 of 8 flagged-not-costed (F4 medium, F5 low) / 1 absent (F1 — truncation, no parts data).
- Slam-panel zone named: 2 of 8 costed (O1 £260 repair, O2 £300 repair — both Opus) / 0 of 8 flagged / 6 absent (all 5 Fable runs + O3).

Outside the 8-run scope, for completeness: five earlier Opus-era SF69YBB
sessions exist in Supabase (8–9 Jun, engine still evolving; `_reconciledParts`
only, no `_preGateParts`); 4 of those 5 also name the slam-panel zone
(repair £280–380).

### Hash ledger closes — 11 Jun
- Lamp-parse fix commit: `1bee99b9241aba514278b6e4241cde65fefc8d6a`
  "probe: lamp-detect parse — read text blocks, not content[0]" — identified
  from the diff itself (removes positional `data.content?.[0]?.text`, adds
  `type === 'text'` filter+join).
- Run-4 deployment `dpl_2Hjp7hMTqT3CmnghGCEi46RPXYw3` (built
  2026-06-10T14:58:41Z, alias motorquoter-git-fable5-probe-*): build log via
  `vercel inspect --logs` reads "Cloning github.com/MotorQuoter/motorquoter
  (Branch: fable5-probe, Commit: 1bee99b)" — matches the lamp-fix commit.
- Run-5 export: `test-results/probe/SF69YBB/claude-fable-5/run-5.json`
  (session `1a307a3a-7b52-4034-bb9c-ece6fd2c2b63`, created
  2026-06-10T15:32:16Z); servedModels `["claude-fable-5","claude-fable-5"]`,
  stopReasons `["tool_use","end_turn"]`, lampDetect `ok`; JSON parse
  verified. Data commit: the commit carrying this block
  ("docs(probe): grep result bonnet/slam-panel zone…").
- Runs 1–4 data commit `fd59d88b56a456078a943e7a9db0b2782d1b306f` — closed
  and verified previously (preview alias served fd59d88); included for
  completeness.

## BL75JAU — FABLE SIDE COMPLETE (3/3 VALID, 11 Jun)

### Headline: second perception fabrication, ground-truthed
**Opposite front corner: CLEAN** (Vincent, 11 Jun — single-corner strike;
front end likely garage-stripped for inspection pre-write-off). Runs 1 and 2
fabricated damage to it: "visibly unseated and sitting proud of its mounting,
with brackets exposed" (r1), "disturbed with wiring exposed" (r2). Run 3 read
it honestly ("intact and seated", damageSpan=single_corner, lamps=1).
**Fable perception-fabrication tally: SF69YBB rear quarter 3/3; BL75JAU
opposite front corner 2/3.**

### Third instance of the adjacency-misattribution mechanism — new variant
Full-width bumper STRIPPING (by assessor/garage) exposes beam, slam area and
both lamp recesses across the car's width. The model reads full-width
EXPOSURE as full-width IMPACT — stripping misread as strike. Same root as the
SF69YBB rear quarter: normally-concealed structure presented without the
trade prior "assessors strip bumpers; exposure is not damage."
Damning detail: run 1's own prose noticed the clean fastener points and
attributed the strip "partly by the assessor" — then fabricated the
opposite-corner lamp damage anyway. In-pass self-correction failed WITH the
counter-evidence already in the model's own output.
Structured channel inherited the misread: recordLampObservation damageSpan
flickered with the prose (full_width ×2 → single_corner ×1) — "reliable
input does not imply a valid rule," again.

### Candidate two-pass challenge question — WIDENED (supersedes earlier wording)
> "Exposure created by component removal — whether torn off by impact or
> stripped for assessment — is not evidence of damage to the parts now
> visible. Newly exposed substrate, mounting points, brackets, recesses and
> locating edges are the normal appearance of a stripped or opened zone.
> Does this part show deformation or damage independent of the fact that it
> is now visible?"
Status unchanged: two-pass design input ONLY. Not for the single-pass prompt
(run 1 proves in-pass counter-evidence doesn't gate the misread).

### First measured fabrication → exit propagation
The fabricated both-corners read coincided with the lower band: mid 75%
£14,682 on the two fabricating runs vs mid-high 77.5% £15,171 on the honest
run. Modest in money; first observed case of a perception fabrication moving
the exit number. Exit-stability note QUALIFIED: "Fable's most stable output"
held per-lot on SF69YBB (3/3 identical) but is 2-and-1 on BL75JAU.

### Slam panel: 0/3 on BL75JAU — 0/8 Fable overall, two lots
Run 1 prose names "the front carrier/slam panel area" as exposed; no run
carries the zone into either array, costed or flagged. Pattern closed for
the Fable side. State B baselines to answer the Opus side under probe
conditions.

### Flag-vs-cost boundary churn (repair composition)
Repair £2,460 / £3,475 / £3,100 — spread £1,015. Suspension corner: flagged
(r1) → one line £750 (r2) → three lines totalling £800 (r3). Parking
sensors: iv=false gate-stripped (r1) → costed (r2, r3). Charge port flap:
flagged (r1) → "not damaged" (r2) → costed £110 (r3). Totals move less than
composition — consistent with the SF69YBB labour-line finding.

### Substrate notes
- Gate: 2 strips logged (r1), 0 (r2 — see gate-bypass diagnosis below),
  1 (r3). Arithmetic correct in all three.
- Lamp machinery coherent on every run incl. the single-corner read
  (tier 2, £350 LED-assumed, delta £0).
- Wheel-checklist contradiction 3/3: structured checklist renders all eight
  wheels/tyres "Not clearly visible — confirm on inspection" alongside a
  costed, prose-confirmed shredded wheel. Unconditional wheel-net append
  colliding with run-specific evidence; user-falsifiable incoherence.
  CARRY-BACK item.
- CALL2 salvageSelfReferenceConfirmed flipped false (r1) → true (r2, r3);
  perZone 5 → 2 → 2. Checklist rendered "Verified clear" all three runs —
  conservative-union absorbing an unstable model boolean, as designed.

### Gate-bypass diagnosis (run 2, closed)
Run 2's iv=false lamp produced no [GATE] line because reconcileParts'
lamp-allowance extraction removed it BEFORE the gate ran (route.js:976–982,
silent, selects lampIndices[0] without consulting iv). Money correct;
observability absent. Conclusion (b): second exclusion path, pre-gate.
Run-1 vs run-2 difference was pure array position. Full diagnosis in chat
record 11 Jun. Two CARRY-BACK items below. Incidental: gate's _allowance
pass-through (route.js:1970) is dead code on the current flow.

## SF69YBB — OPUS SIDE COMPLETE (3/3 VALID + CB7-DISTORTED, 12 Jun)

- "Rear quarter fabrication: Opus 3/3 on instrumented substrate (iv=true, costed £900/£620/£620). §6.2 closes: fabrication confirmed cross-model, expectation met."
- "Bonnet phantom: Opus 3/3 COSTED on SF69YBB instrumented substrate (£280 repair / £260 repair / £510 REPLACE) — escalating in action and cost across runs. Stronger than BL75JAU's 2/4. Slam panel recalled 3/3 (£350 structural / £160 trim / £260 tie bar — identity churns, presence stable). Real-part-plus-phantom-neighbour signature confirmed 3/3 on clean provenance; pre-probe O1–O3 circumstantial controls fully superseded."
- "MOT advisory correlation fired (S3): 2024 skirt advisory correlated to current struck-flank damage, 2025 non-repeat noted — first in-probe firing of the buyer-invisible value class."
- "RULING (Vincent, 12 Jun): verbatim quoted DVSA/MOT record text is EXEMPT from the left/right prose ban — the ban governs the model's own damage descriptions only; quoted source records render as-is."
- "Run-2 substrate note: Labour & paint emitted in costedParts with iv=null + _labourSafe:true — labour-null deliberate-pass path exercised correctly for the first time. Runs 1 & 3 passed labour via no-verdict-match. Both Phase 2 null paths now proven in the wild."
- "Run-2 rendering question (NOT adjudicated): 'Front tyres (pair)' was gate-stripped (iv=false) but no 'excluded from repair total' row appeared in rendered Inspection Flags — unlike the headlamp strip rows. No money distortion (no tyre line in parts table). Open question whether dedup absorbed it or the strip row dropped. Flag for carry-back review, do not investigate now."
