// MOT-status presentation — the ONE place the 40-year MOT-exemption tone is decided (batch 47).
// Reuses historicEligibility from roadTax.mjs, the single age test in the codebase. Do NOT add a
// second age test here: two definitions of one truth is the defect this project keeps paying for.
//
// THE TRAP (batch 47 §2): an age-eligible vehicle is NOT automatically MOT-exempt. Two conditions we
// cannot see — the keeper must declare it (V112), and it must not have been "substantially changed"
// (a modified classic is not exempt) — and an exempt vehicle can still be unroadworthy (exemption
// removes the test, not the obligation). So the answer is NEUTRAL:
//   • never GREEN — that reads as "passed" a test that never happened (rule 10 in the green direction,
//     the same class as printing a green all-clear on a check that never ran), and
//   • never RED — absence of a current MOT on an age-eligible classic is not neglect.
// Both facts, no verdict.
import { historicEligibility } from './roadTax.mjs';

export const MOT_EXEMPT_NOTE =
  'No current MOT. Vehicles over 40 years old can be exempt from MOT testing — this one qualifies on age. ' +
  'Exemption is not automatic and does not apply to substantially modified vehicles. An exempt vehicle must still be roadworthy.';

/**
 * The MOT-status row's presentation. `tone` is SEMANTIC — each surface maps it to its own vocabulary
 * (PDF good/bad/neutral · web good/warn/neutral) so the ok/alert paths stay byte-identical to today:
 *   'ok'     — MOT Valid                                  → unchanged (green everywhere)
 *   'exempt' — age-eligible AND not currently Valid       → NEUTRAL + MOT_EXEMPT_NOTE
 *              (includes an absent/null status — an age-eligible car must SAY something, not vanish)
 *   'alert'  — not Valid and not age-eligible             → unchanged (PDF red / web amber, as today)
 * IE (NCT) never takes the exempt branch — the 40-year UK MOT exemption is UK law only.
 * @param {{ motStatus?:string|null, yearOfManufacture?:number|string, firstRegistration?:string,
 *           market?:'GB'|'IE', nowMs?:number }} input
 */
export function motStatusPresentation({ motStatus, yearOfManufacture, firstRegistration, market = 'GB', nowMs } = {}) {
  if (motStatus === 'Valid') return { tone: 'ok', exempt: false, label: motStatus, note: null };
  const ageEligible = market !== 'IE'
    && historicEligibility({ yearOfManufacture, firstRegistration, nowMs }).eligible;
  if (ageEligible) {
    // Every non-Valid shape handled without inferring which it is: null/'' → a spoken label so the
    // row is never silently hidden; 'Not valid'/'Expired'/other → shown as-is, neutral, with the note.
    return { tone: 'exempt', exempt: true, label: motStatus || 'No current MOT', note: MOT_EXEMPT_NOTE };
  }
  return { tone: 'alert', exempt: false, label: motStatus, note: null };
}
