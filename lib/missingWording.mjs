// batch 247 B3 (Vincent, 16 Nov) — the ONE owner of the "missing part" wording.
//
// A single iv:missing vote outranks every other vote for the money (route.js amalgamation: "missing
// dominates" → replace). That rule is unchanged, and so is every figure. What changes is the WORDS: on
// RV26YLN one photo voted the door mirror missing while another voted it damaged, and the report said
// "Not present in the listing photos" about a mirror hanging off by its wiring. The buyer can see it in
// the photos, so the claim was false.
//
// Rule: "Not present in the listing photos" is printed only when NO view voted the part damaged. When
// any view did, the part is "Damaged or torn off". The votes come from assessment._pvVotes (the per-panel
// split stored on every run). A G-split panel is stored under PANEL, PANEL#2, … — the count is POOLED
// across those keys, because the wording is about the panel the buyer looks at.
//
// Unchanged on purpose:
//   • a code-inserted row (gp._inserted — the lamp mandate) keeps "Not present" exactly as before;
//   • with no vote record at all (older stored shapes, unit callers that pass none) the wording is as before.

export const NOT_PRESENT_LEAD = 'Not present in the listing photos';
export const TORN_OFF_LEAD    = 'Damaged or torn off';

// Pooled damaged-vote count for a panel, or null when the votes are not known.
export function damagedVotesFor(pvVotes, panelId) {
  if (!pvVotes || typeof pvVotes !== 'object' || panelId == null) return null;
  let found = false, n = 0;
  for (const [k, v] of Object.entries(pvVotes)) {
    if (k !== panelId && !k.startsWith(`${panelId}#`)) continue;
    found = true;
    n += Number(v?.damaged) || 0;
  }
  return found ? n : null;
}

// Which lead a missing-marked row carries. Call only for a row that would have said "Not present".
export function missingLead({ inserted = false, amalgMissing = false, panelId = null, pvVotes = null } = {}) {
  if (inserted && !amalgMissing) return NOT_PRESENT_LEAD;          // lamp-mandate insert — behaviour as before
  const d = damagedVotesFor(pvVotes, panelId);
  return d != null && d > 0 ? TORN_OFF_LEAD : NOT_PRESENT_LEAD;
}

// The Visible Damage Summary parts line.
export function missingVdsProse(lead, figure) {
  return figure ? `${lead} — replace, ${figure}.` : `${lead} — replace.`;
}

// The damage-card note.
export function missingCardNote(lead) {
  return `${lead} — replacement costed.`;
}
