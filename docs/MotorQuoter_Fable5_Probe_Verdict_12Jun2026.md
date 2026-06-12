# MotorQuoter — Fable 5 Probe Verdict
*12 June 2026 — adjudicated against the pre-committed criteria of the Fable 5 Comparison Protocol (§5 verdict criteria, §6 decision rules). PROVENANCE: the protocol was composed 10 Jun in the chat record and presented for download but never committed to the repo — discovered 12 Jun when the docs/ glob came back empty. The criteria text (§0–§7) was retrieved verbatim from the chat record on 12 Jun, BEFORE this verdict was drafted, and is committed alongside this verdict as `docs/MotorQuoter_Fable5_Comparison_Protocol_10Jun2026.md` with its own provenance note. The verdict was written only after the full matrix closed (commit 846b549). Evidence base: `test-results/probe/VERDICT-NOTES.md`, `CARRY-BACK.md`, and the 13 run exports (12 counted + 1 excluded-retained). Raw arrays only, per protocol §2/§4.*

---

## VERDICT: **MIXED — headline UNCHANGED, with one WORSE-class finding against Fable 5**

## DECISION (per §6): **STAY ON OPUS 4.8.**
Decision rules 2 (UNCHANGED) and 3 (WORSE) converge on the same outcome, so the mixed verdict is decision-stable: Opus 4.8 remains the production model, the two-pass build keeps its banked-last slot (strengthened — see below), the finding is logged, the branch is deleted, and the question is revisited at the next model generation. Per rule 4, Phase 3 remains the gate to production and was never blocked by this probe.

---

## AMENDMENT 12 Jun (same day, post-publication)
*Ground-truth correction — the slam panel is intact; the §2.3 WORSE trigger ('genuine part dropped: slam panel') was built on a session-level misattribution of Vincent's 11 Jun ruling and is WITHDRAWN. The verdict re-adjudicates MIXED → UNCHANGED under the same pre-committed §5 criteria. THE DECISION IS UNCHANGED: §6 rule 2 (UNCHANGED) directs STAY ON OPUS 4.8, identically to rule 3. The §3 scoreboard's slam-panel row inverts (Opus 7/7 phantom; Fable 0/8 correct); the error-direction asymmetry is smaller than stated. Full corrected analysis in VERDICT-NOTES, 'RE-ADJUDICATION 12 Jun'. The original text below is preserved unedited for the record.*

---

## 1. THE MATRIX (complete)

| Lot | Model | Valid runs | Other |
|---|---|---|---|
| SF69YBB | claude-fable-5 | 3/3 (r3, r4, r5) | r1 discarded (truncation), r2 excluded-retained (incomplete paste) |
| SF69YBB | claude-opus-4-8 (State B, e1fa14a) | 3/3 (S1–S3) — all CB7-distorted | — |
| BL75JAU | claude-fable-5 | 3/3 (F1–F3) | — |
| BL75JAU | claude-opus-4-8 (State B, e1fa14a) | 3/3 (O1–O3; O2 CB7-distorted) | O0 excluded-retained (CB7-distorted; credit-screen resubmission) |

SF69YBB Fable repair totals (from the session rows' engine-persisted `_partsReconciliation.parts_sum`, corroborated by `_marginScenarios[].repair` — the run exports carry only pre-gate raw arrays, no computed total; see §8): r3 £4,500 / r4 £3,975 / r5 £4,195; exit mid-low £6,941 all three.

One variable changed by choice (model string ×2); one changed by API construction (Fable's always-on thinking, which cannot be disabled). Both models received identical image bytes by construction (client-side 1568px/0.82 cap, verified Step Zero). All comparison repair figures below are **CB7-corrected** where the watch fired — the displayed Opus totals were distorted in 5 of 7 instrumented observations and are not usable raw.

## 2. §5 ADJUDICATION, CRITERION BY CRITERION

### 2.1 BETTER — "SF69 rear quarter fabrication gone or reduced in frequency, AND no regressions on BL75, AND substrate compatibility clean"
**FAILS on the first conjunct.** The rear quarter was costed `iv=true` in 3/3 valid Fable runs — identical signature, identical frequency to Opus (3/3 on the instrumented State B baselines, §6.2 closed as expected). Not gone, not reduced. The remaining conjuncts are moot for BETTER but are adjudicated below because they carry the WORSE finding.

### 2.2 UNCHANGED — "same fabrication at similar frequency, similar variance bands"
**HOLDS for the headline binary.** Rear quarter: Fable 3/3, Opus 3/3, same `iv=true` self-report, same mislocated attribution (mechanism section, VERDICT-NOTES). The residual is architectural, present across two model generations, and exactly the class the visibility gate cannot touch by design. The two-pass build keeps its priority — and leaves this probe **stronger than it entered**: one suspected instance has become a named mechanism (adjacency misattribution / exposed-substrate false positive) with four ground-truthed instances across both models and both lots, plus a widened challenge question banked as two-pass design input.

### 2.3 WORSE — "any new fabrication, any genuine part dropped, substrate breakage, or wider cost variance"
**ONE TRIGGER FIRES: a genuine part dropped.**

- **Genuine part dropped — SLAM PANEL: Fable 0/8, never costed, never flagged, both lots.** Ground truth (Vincent, 11 Jun): on SF69YBB the real front damage is the slam-panel zone — the narrow panel ahead of the clean bonnet. Opus carries it (2/3 pre-probe controls; 3/3 on the instrumented SF69 baselines at £350/£160/£260; 4/4 on BL75JAU). Fable never puts it in either array on any run on either lot — run F1 (BL75) even names "the front carrier/slam panel area" in prose and still drops it from both arrays. **On the ground-truthed lot, Fable's repair figure omits the genuinely damaged part on every run.** This is the §5 WORSE clause verbatim.
- New fabrications: none unique to Fable. The BL75 opposite-corner fabrication (Fable 2/3) is the same adjacency mechanism Opus exhibits 4/4 — cross-model, not a Fable regression.
- Substrate breakage: none at the schema level — `stop_reason=tool_use` obeyed on every valid run, arrays populated, gate arithmetic correct. One sub-schema discipline break, template-consistent: the prose-discipline letter-break ("not included in repair total" cost-status claim in checklist prose, 2/2 then recurring). Logged as confirmation that rule obedience does not transfer between models; not breakage under §5's definition.
- Wider cost variance: BL75 repair spread Fable £1,015 (£2,460–£3,475) vs Opus corrected £550 (£3,045–£3,595). Wider, but the spread is composition churn — a cross-model behaviour (totals move less than composition, observed both sides) — and on its own would not have carried a WORSE verdict. It does not need to: the dropped slam panel already does.

### 2.4 Mixed handling
Per §5: "Mixed results get written up honestly as mixed. No averaging a fabrication fix against a regression." There is no fabrication fix to average — the headline is UNCHANGED and the regression stands beside it. **Verdict: MIXED (UNCHANGED + WORSE), decision-stable on STAY.**

## 3. THE SHAPE FINDING — error direction (beyond the §5 axes, decisive context)

Front-zone scoreboard, all observations, both lots:

| Part (truth) | Opus | Fable 5 |
|---|---|---|
| Slam panel (REAL, SF69 ground-truthed) | costed 7/7 instrumented+controls | **0/8 — absent** |
| Bonnet (CLEAN, both lots) | phantom in prose every observation; costed 3/3 SF69 (escalating £280→£260→£510 REPLACE) + 2/4 BL75 | 1/3 costed, 2/3 hedged (SF69); honest 3/3 (BL75) |
| Rear quarter (CLEAN above bumper line, SF69) | fabricated 3/3 | fabricated 3/3 |
| Opposite front corner (CLEAN, BL75) | fabricated 4/4, escalating to explicit pre-argument | fabricated 2/3 |

**Opus over-includes: real parts + phantom neighbours — a conservative, bid-suppressing error. Fable under-includes: cleaner on phantoms but drops real parts — an anti-conservative, margin-inflating error.** On a bid tool whose product promise is the certain-visible floor, the anti-conservative direction is the worse one: an omitted real part understates repair, inflates apparent margin, and pushes the buyer toward overbidding. This is a product-grade argument for STAY that is independent of, and concordant with, the §5 adjudication. Neither model is right on the front zone; Opus is wrong in the survivable direction.

Exit-side corroboration: Fable read SF69 at mid-low £6,941 (3/3, stable) against the Opus anchor mid £7,181 (3/3) — a one-step band shift down, consistent per-lot but a cross-model disagreement. On BL75, Fable's fabricating runs landed mid £14,682 vs the honest run's mid-high £15,171 — the first measured case of a perception fabrication propagating into the exit number.

## 4. OPERATIONAL FINDINGS AGAINST A FUTURE SWAP (logged for the next generation's probe)

- **Cost:** nominal 2× per token; effective ~3–4× per assessment, because Fable's non-disableable thinking is ~60–70% of output tokens. Valid Fable runs $1.31–$2.23 vs Opus est. $0.35–0.70.
- **Latency:** Fable wall time ~3 min makes the client ~180s fetch-timeout race RESONANT, not occasional (run-4 race, 409 five seconds before the original wrote). Any future swap phase must fix the timeout/retry UX before Fable serves a customer, plus the stale-lock recovery gap.
- **Refusal shape:** `stop_reason:"refusal"` arrives as HTTP 200; the fail-loud (main) / soft-fail-with-persisted-status (lamp) handling built for this probe is the required substrate for any Fable-generation model.
- Prose-discipline rules require fresh per-model validation; obedience demonstrably does not transfer.

## 5. WHAT THE PROBE BOUGHT (largely independent of the verdict)

1. **The mechanism.** Adjacency misattribution, ground-truthed ×4, cross-model: exposure created by component removal — torn off by impact OR stripped for assessment — is read as impact, and damage is attributed to the nearest large nameable panel. The model mislocates damage; it does not invent it. Any gate must challenge the ATTRIBUTION, not the perception — and in-pass counter-evidence does not gate the misread (BL75 F1 noticed the clean fastener points and fabricated anyway). The widened challenge question is banked as two-pass design input only.
2. **Stability ≠ truth, proven.** Opus's bonnet phantom was costed 3/3 on the instrumented substrate, escalating in action and cost (£280 repair → £510 REPLACE). A stable hallucination is invisible to variance checks. Frequency measures stability; only ground truth measures truth.
3. **CB7 fired live, 5/7 instrumented Opus observations** (~£350 silent understatement each, all caught by the watch rule, all line-sum verified). On an exposed front — the common case worth assessing — the lamp order-dependence hazard is the MAJORITY outcome, not an edge case. MERGE BLOCKER status confirmed; fix (iv-aware keep-selection or gate-aware allowance merge, + dead `_allowance` pass-through removal) is the first carry-back applied to core-slots.
4. **Both Phase 2 null paths proven in the wild** (labour-null deliberate-pass via `_labourSafe:true` on S2; no-verdict-match pass on S1/S3), plus the full carry-back ledger (8 items) and the MOT-advisory correlation firing in-probe — the buyer-invisible value class working on a live run.
5. **A complete, disposition-disciplined 13-run baseline set** with raw arrays on disk — the Phase 2 retention gap does not happen again.

## 6. CONDITIONS THAT WOULD REOPEN THE QUESTION

- Next model generation (per decision rule 3), probed under this same protocol shape — with the slam-panel recall and error-direction shape added as first-class §4 axes alongside the rear-quarter binary.
- Any future probe inherits: refusal handling, CB7 fix in place, timeout/retry UX fixed, corrected-figure discipline, and ground truth established BEFORE runs where possible.

## 7. UNCHANGED BY THIS VERDICT (protocol §7)
Resolution re-tuning (was contingent on a swap; dead with STAY), lamp wording toggle (OFF permanently), Haiku odometer model (untouched), all merge and production questions. The image headroom probe raised 11 Jun stays parked, post-verdict timing now satisfied — it is a separate experiment against Opus, not a reopening of this one.

## 8. ONE GAP, EXPLICITLY MARKED
Gap filled 12 Jun (CC, docs-copy paste): totals appended to §1 from the Supabase session rows' `_partsReconciliation.parts_sum` — the run exports turned out to carry only pre-gate raw arrays, not the engine-computed displayed total, so the engine's persisted figure was used instead (disclosed deviation, better provenance than a line-sum reconstruction).

See also: `docs/VERDICT-NOTES.md` ADDENDUM 12 Jun (post-verdict, during CB7 fix design) — CB7 also fired on the Fable side; the Fable totals in §1/§2.3 above are archived uncorrected, corrected figures in the CB7 fixture table (`scripts/replay-lamp-fix.mjs`).

---
*MotorQuoter — Confidential — © Vincent Marmion 2026*
