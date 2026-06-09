# Phase 1 Part 2 — Separate-Block Verdict Carriage
## Final Approved Design
*core-slots · 09 June 2026 · build-to-keep*

---

## Why this exists

Call-2 (Haiku) was re-transcribing the full Parts Breakdown table to attach per-part verdict
fields (`independentlyVisible`, `partHeight`, `zone`). For any lot with 10+ parts plus
verbose `severityNote` strings in `perZone`, the 1024-token ceiling was hit before
`costedParts`/`flaggedParts` could begin — both arrays came back empty. The root fix moves
per-part verdict carriage into the Call-1 prose (a separate, clearly-labelled block), parsed
by deterministic code. Call-2 reduces to the five language-understanding fields it was built
for; no fixed token ceiling can be overrun by a heavy lot.

**Architecture decision:** verdicts are emitted in a *separate named block* after the Parts
Breakdown — NOT as a 5th column inside the buyer-facing table. Buyer-facing cleanliness must
not depend on a conditional overwrite (`renderParts`) firing. The separate block means machine
tags are never in the buyer section to begin with.

---

## 1. New output field: `Part Verdicts:`

**Position in `ASSESSMENT_FIELDS`** (`assess/route.js`): inserted after `'Parts Breakdown'`,
before `'Key Cost Drivers'`.

```js
const ASSESSMENT_FIELDS = [
  'Visible Damage Summary',
  'Parts Breakdown',
  'Part Verdicts',         // NEW — machine-read only; never referenced in pdf/route.js
  'Key Cost Drivers',
  // ... rest unchanged
];
```

**parseAssessment boundary:** existing slicing mechanism finds `Part Verdicts:` label in the
prose and slices from that label to the start of the next field label (`Key Cost Drivers:`).
Identical mechanism to every other field. Parts Breakdown ends when `Part Verdicts:` is found;
`Part Verdicts` ends when `Key Cost Drivers:` is found. No bleed in either direction.

**PDF route:** `pdf/route.js` references each field by explicit key name. `assessment['Part
Verdicts']` does not appear anywhere in that file. Adding `'Part Verdicts'` to the
`assess/route.js` `ASSESSMENT_FIELDS` populates the key in the `assessment` object; the PDF
renderer never reads it. Clean by the PDF renderer's own structure — zero dependency on a
conditional path firing.

---

## 2. Line formats inside `Part Verdicts:`

### Costed part lines

```
PART: {Part name} | iv:{true|false|na} | z:{zone} | ph:{low|mid|high}
```

- `iv:` — `true` = damage visibly confirmed on this part's own photos; `false` = not
  independently visible; `na` = not applicable (labour, paint, materials)
- `z:` — zone from the six-value enum:
  `front | rear | flank-damaged-side | roof | underside | interior`
- `ph:` — part's own vertical position: `low | mid | high`.
  **OPTIONAL** — omit entirely when not clearly stated in the assessment prose. Do not
  fabricate. `parsePartVerdicts` yields `null` when absent. Gate-inert on null.

### Flagged part lines

```
FLAG: {Part name} | z:{zone} | weight:{low|medium|high} :: {reason — any text to end of line}
```

- `::` is the terminator before free-text reason. Everything after `::` (trimmed) is the
  reason. No characters are reserved inside the reason — pipe, colon, `z:`, `iv:` all
  survive intact.
- `weight:` — `high` = inspect before bidding; `medium` = worth checking; `low` = minor
  concern.

### Full example block

```
Part Verdicts:
PART: Front bumper | iv:true | z:front | ph:low
PART: Front grille | iv:true | z:front | ph:mid
PART: Front headlamp (OS) | iv:false | z:front
PART: Labour & paint | iv:na | z:front
FLAG: Rear quarter | z:rear | weight:low :: not independently confirmed on its own shots; verify on inspection
```

---

## 3. FLAG line: pipe-proof reason — proof

**Regex:**
```js
new RegExp(
  `^FLAG:\\s+(.+?)\\s*\\|\\s*z:(${ZONES})\\s*\\|\\s*weight:(low|medium|high)\\s*::(.+)$`,
  'i'
)
```

**Worked parse — reason containing a literal `|` and the substrings `z:` and `iv:`:**

Input line:
```
FLAG: B-pillar inner | z:flank-damaged-side | weight:high :: Cat S structural — gap iv:2mm | z:3mm across seam; iv:unclear from photos
```

Trace:
- `^FLAG:\s+` → `FLAG: `
- `(.+?)` (lazy) → `B-pillar inner` (stops at first `|`)
- `\s*\|\s*` → ` | `
- `z:(ZONES)` → `flank-damaged-side`
- `\s*\|\s*` → ` | `
- `weight:(...)` → `high`
- `\s*::` → ` ::`
- `(.+)$` (greedy) → ` Cat S structural — gap iv:2mm | z:3mm across seam; iv:unclear from photos`

After `.trim()`: `Cat S structural — gap iv:2mm | z:3mm across seam; iv:unclear from photos`

The embedded `|`, `z:`, and `iv:` survive intact. ✓

Line-type matching is prefix-anchored (`^PART:` vs `^FLAG:`) — a reason can never start a
new line, so substrings inside it cannot confuse type detection. ✓

---

## 4. `parsePartVerdicts(blockText)` — full function

```js
function parsePartVerdicts(blockText) {
  const costedParts  = [];
  const flaggedParts = [];
  if (!blockText) return { costedParts, flaggedParts };

  const ZONES = 'front|rear|flank-damaged-side|roof|underside|interior';

  for (const line of blockText.split('\n')) {
    const t = line.trim();

    // PART: name | iv:X | z:Y | ph:Z  (ph optional)
    const pm = t.match(
      new RegExp(
        `^PART:\\s+(.+?)\\s*\\|\\s*iv:(true|false|na)\\s*\\|\\s*z:(${ZONES})(?:\\s*\\|\\s*ph:(low|mid|high))?\\s*$`,
        'i'
      )
    );
    if (pm) {
      const [, partName, ivRaw, zone, phRaw] = pm;
      costedParts.push({
        partName:             partName.trim(),
        zone,
        independentlyVisible: ivRaw === 'true' ? true : ivRaw === 'false' ? false : null,
        partHeight:           phRaw || null,
      });
      continue;
    }

    // FLAG: name | z:Y | weight:W :: reason  (reason is everything after ::, pipe-safe)
    const fm = t.match(
      new RegExp(
        `^FLAG:\\s+(.+?)\\s*\\|\\s*z:(${ZONES})\\s*\\|\\s*weight:(low|medium|high)\\s*::(.+)$`,
        'i'
      )
    );
    if (fm) {
      const [, partName, zone, weight, reason] = fm;
      flaggedParts.push({ partName: partName.trim(), zone, weight, reason: reason.trim() });
    }
    // Unmatched lines are silently skipped. Absent block → both arrays [].
  }

  return { costedParts, flaggedParts };
}
```

---

## 5. Labour-safety cross-reference — gate-inert guarantee

**Problem:** `iv:na` relies on Opus reliably tagging every labour/paint line. A mistagged
`iv:false` labour line in `costedParts` would be gate-eligible in Phase 2 (visibility gate:
`iv:false` → strip), reducing the repair total — wrong direction.

**Solution:** cross-reference against `parseParts` output. Labour/paint rows in parseParts
have `action` matching the dash pattern (`—`, `–`, `-`) — structural, not model-tagged.

**Approach: position-primary, normalised-name fallback.**

```js
// Build the set of parseParts indices that are labour/materials (action is a dash)
const dashIndices = rawParts.reduce((acc, rp, i) => {
  if (/^[-–—]+$/.test(rp.action)) acc.add(i);
  return acc;
}, new Set());

// Normalise for name-fallback: lowercase, & ↔ and, drop parentheticals, collapse spaces
const norm = s => s.toLowerCase().trim()
  .replace(/\s*&\s*|\s+and\s+/gi, ' and ')
  .replace(/\s*\([^)]*\)/g, '')
  .replace(/\s+/g, ' ');

const labourNamesNorm = new Set(
  rawParts.filter((_, i) => dashIndices.has(i)).map(rp => norm(rp.name))
);

// Primary: positional (costedParts[i] corresponds to rawParts[i] by prompt instruction).
// Fallback: normalised name match (catches position drift within normalisation tolerance).
// Accepted residual: if names drift beyond normalisation (e.g. "Labour & paint (two-panel)")
// AND positions drifted, the entry stays gate-eligible with its iv: tag. The Phase 2
// visibility gate would then treat an iv:false labour line as strippable, reducing repair
// total by the labour amount. The geometry gate ignores labour regardless. This residual
// only occurs if Opus deviates from the prompt's "name each Part Verdicts line identically
// to its Parts Breakdown counterpart" instruction on a line that is ALSO mispositioned.
costedParts.forEach((cp, i) => {
  if (dashIndices.has(i) || labourNamesNorm.has(norm(cp.partName))) {
    cp.independentlyVisible = null; // gate-inert: cannot be stripped by visibility gate
  }
});
```

**Call order** (after `parseAssessment` makes `assessment` available):
```js
const rawParts = parseParts(assessment['Parts Breakdown'] || '');
const { costedParts, flaggedParts } = parsePartVerdicts(assessment['Part Verdicts'] || '');
// ... labour-safety pass (above) ...
coreObs.costedParts  = costedParts;
coreObs.flaggedParts = flaggedParts;
```

**`parsePartVerdicts` is a pure function** — it does not receive `rawParts`. Labour-safety is
route.js's responsibility, inline between `parseParts` and the coreObs assignment.

---

## 6. Call-2 schema removals

From `CORE_EXTRACTION_TOOL`:
- Remove `costedParts` property
- Remove `flaggedParts` property
- Remove `severityNote` from `perZone.items.properties` and `perZone.items.required`

Updated `perZone` item shape: `{ zone, eventType, heightBand }` (three fields only).

Updated top-level `required`:
```js
required: ['windscreenSticker', 'bodyStyle', 'provenanceConcernFlagged', 'salvageSelfReferenceConfirmed', 'perZone']
```

`max_tokens` for Call-2: **left at 1024** (no change — ~4× headroom after removals; no
reason to tighten a guardrail).

---

## 7. coreObs construction change

In the `if (call2ToolBlock?.input)` block: remove the `inp.costedParts` and `inp.flaggedParts`
reads (those fields no longer exist in the schema). `coreObs.costedParts` and
`coreObs.flaggedParts` are **not** set here — they remain `[]` from the floor default until
`parsePartVerdicts` runs after `parseAssessment`.

Floor default (Call-2 failure path): `costedParts: []`, `flaggedParts: []` — unchanged,
correct, they will be overwritten by `parsePartVerdicts` after `parseAssessment` regardless.

Call-2 user message: updated to reflect reduced extraction scope (no costedParts/flaggedParts
mention).

---

## 8. All six touch points — build order

| # | File | What changes |
|---|------|---|
| 1 | `config/assessmentEngine.js` | Remove `severityNote` clause from PER-ZONE; add `Part Verdicts:` field + format instruction to output format section; update PER-PART VISIBILITY STATEMENT to mention `FLAG:` line in Part Verdicts |
| 2 | `app/api/salvage/assess/route.js` — `ASSESSMENT_FIELDS` | Add `'Part Verdicts'` after `'Parts Breakdown'` |
| 3 | `app/api/salvage/assess/route.js` — new function | Add `parsePartVerdicts(blockText)` (before parseParts area) |
| 4 | `app/api/salvage/assess/route.js` — parts block | Call `parsePartVerdicts` + labour-safety pass after `parseParts`; assign to `coreObs` |
| 5 | `app/api/salvage/assess/route.js` — `CORE_EXTRACTION_TOOL` | Remove `costedParts`, `flaggedParts`; remove `severityNote` from `perZone`; update `required` |
| 6 | `app/api/salvage/assess/route.js` — Call-2 user message | Update to reflect reduced scope |

**Untouched:** `parseParts` (line 863) · `max_tokens` (1024) · `pdf/route.js` (entire file)

---

## 9. Prompt changes detail (assessmentEngine.js)

### PER-ZONE DAMAGE CLASSIFICATION — remove severityNote clause

**Remove:** "plus a one-line note on severity and lateral extent" from clause (b).

Severity detail stays in the Visible Damage Summary prose where Opus already writes it.
It is not re-transcribed anywhere.

### Output format — new Part Verdicts field

Add between `Parts Breakdown:` instruction block and `Key Cost Drivers:` line:

```
Part Verdicts:
[One PART: line per row from the Parts Breakdown (same order and same part name),
then one FLAG: line per flagged part named in the Visible Damage Summary.
This block is machine-read only — do not add prose, do not skip rows, do not reorder.
Costed parts format: PART: [Part name] | iv:[true/false/na] | z:[zone] | ph:[low/mid/high]
  iv: true = damage visibly confirmed on this part's own photos
      false = not independently visible on this part's own shots
      na = not applicable (labour, paint, materials — any non-part cost line)
  z: zone from: front | rear | flank-damaged-side | roof | underside | interior
  ph: this part's own vertical body position — OPTIONAL, omit if not clearly stated;
      low = sill/bumper/lower panel, mid = door/body-line, high = bonnet/roof/upper body
Flagged parts format: FLAG: [Part name] | z:[zone] | weight:[low/medium/high] :: [reason]
  reason is free text to end of line — may contain any characters including pipe symbols]
```

### PER-PART VISIBILITY STATEMENT — add FLAG: line instruction

After the flag prose examples, add: "Also add a corresponding FLAG: line in the Part Verdicts
block for every part flagged here."

---

*End of design document.*
