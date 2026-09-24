// flooredProseScrub — deterministic post-processor that keeps the model-authored Key Cost Drivers bound to the
// ledger (batch 158 A4). The model writes the drivers from its visual read; whether a panel is charged is a
// downstream code decision, so the two diverge. Using the FINAL ledger as ground truth, it drops a cost-driver
// bullet whose LEAD panel is FLOORED (not charged) — but KEEPS the bullet if it also names a COSTED panel (no
// over-scrub). Kept bullets, and the Visible Damage Summary, are left exactly as the model wrote them.
// batch 188 (Vincent, 24 Sep): the second half — the "neutraliser" that deleted severe-damage words (crushed,
// creased, …) next to an uncharged panel's keyword in the VDS and in kept bullets — is REMOVED. On the 14-lot corpus
// it made 2 edits and both were wrong (EN23NJX "scuffing and the sill"; DMZ4614 deleted "crushed" from the flank).
// Uncharged panels reach the buyer through Inspection Flags, the checklist and the batch 175 line; missed damage is
// the worse error, so the observation stays as written.
// Pure, no I/O. (Cowork §12/§13; DMZ4614 correction A2, 5 Aug.)
import { PANEL_DISPLAY, PANEL_BEHAVIOUR, PANEL_CLASS } from './panelEnum.mjs';
import { isChargedRow } from './ledgerEdits.mjs';   // batch 163 T2 — the one "is this panel charged?" check

// Position/qualifier words that don't distinguish a panel, plus generic nouns shared across panels.
const QUALIFIERS = new Set(['front', 'rear', 'near', 'off', 'nearside', 'offside', 'left', 'right',
  'side', 'upper', 'lower', 'outer', 'inner', 'structural', 'the', 'and', 'a', 'of', 'both', 'twin']);
const GENERIC = new Set(['panel', 'pack', 'assembly', 'area', 'section', 'unit', 'srs']);

// Common prose synonyms the model uses for a panel — so a "Rocker: …" driver bullet is matched to SILL.
const SYNONYMS = { sill: ['rocker'], wing: ['fender'], bonnet: ['hood'], bumper: ['fascia'], windscreen: ['windshield'] };

// Reduce a panel display name to its distinctive keyword(s) for matching against free prose,
// expanded with common prose synonyms.
// batch 186 (Vincent, 24 Sep) — A HYPHENATED WORD STAYS WHOLE. "Body-side glazing" used to split on the hyphen and lose
// "side" as a qualifier, leaving "body" standing alone as a keyword for the glazing — so "creased and scuffed body panel"
// (EN23NJX) matched a floored BODY_SIDE_GLAZING and lost "creased". Now the keyword is "body-side"; kwPattern matches it
// in prose with or without the hyphen ("body-side", "body side").
export function panelKeywords(name) {
  const base = String(name || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')            // drop parentheticals e.g. "(deployed)"
    .replace(/[^a-z\s/-]/g, ' ')
    .split(/[\s/]+/)
    .map(w => w.replace(/^-+|-+$/g, ''))
    .filter(w => w.length > 2 && !QUALIFIERS.has(w) && !GENERIC.has(w));
  return [...new Set(base.flatMap(w => [w, ...(SYNONYMS[w] || [])]))];
}

// A keyword as a regex source: a hyphen in the keyword matches a hyphen or whitespace in prose.
const kwPattern = (word) => word.split('-').join('[-\\s]');
const wordIn = (text, word) => new RegExp(`\\b${kwPattern(word)}s?\\b`, 'i').test(text);  // tolerate plurals ("doors"→"door")
const refs = (text, panels) => panels.some(p => panelKeywords(p).some(k => wordIn(text, k)));

// batch 158 A4 — THE FULL NAME DECIDES WHEN THE KEYWORDS CANNOT.
// panelKeywords deliberately strips "front"/"rear" as qualifiers, so FRONT_BUMPER and REAR_BUMPER both
// reduce to ["bumper"] — the matcher cannot tell them apart, and the same is true of the two doors and
// of side/rear glass. That is exactly the CK75ONW case: drivers claiming the FRONT bumper while only the
// REAR one is costed. So the panel's full display name is tried first as a phrase; when one side names a
// panel outright, that is decisive and the ambiguous keyword pass is not consulted. Nothing else changes:
// with no phrase hit on either side, the original keyword behaviour runs untouched.
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseIn = (text, name) => {
  const n = String(name || '').toLowerCase().replace(/\(.*?\)/g, '').trim();
  return n.length > 3 && new RegExp(`\\b${esc(n)}s?\\b`, 'i').test(text);
};
const namesIn = (text, panels) => (panels || []).some(p => phraseIn(text, p));

// Drop KCD cost-driver lines whose LEAD panel (phrase before the first colon) is floored and which
// do NOT also name a costed panel. Non-driver lines (headers, format notes) pass through untouched.
export function scrubKCD(kcdText, flooredNames, costedNames) {
  if (!kcdText) return { text: kcdText, dropped: [] };
  const dropped = [];
  const kept = kcdText.split('\n').filter(line => {
    const trimmed = line.trim();
    if (!/^[-*]/.test(trimmed)) return true;               // only touch bulleted driver lines
    const lead = (trimmed.split(':')[0] || '');            // panel phrase before the reason
    // batch 158 A4: a full-name hit on either side settles it; only when neither names a panel outright
    // do we fall back to the (qualifier-blind) keyword match.
    const namedFloored = namesIn(lead, flooredNames);
    const namedCosted = namesIn(lead, costedNames);
    if (namedFloored || namedCosted) {
      if (namedFloored && !namedCosted) { dropped.push(trimmed); return false; }
      return true;
    }
    const refsFloored = refs(lead, flooredNames);
    const refsCosted = refs(lead, costedNames);
    if (refsFloored && !refsCosted) { dropped.push(trimmed); return false; }  // floored-only → drop
    return true;
  });
  // batch 188: a kept bullet is returned exactly as written (the neutraliser that edited its words is removed).
  return { text: kept.join('\n'), dropped };
}

// Derive floored vs costed panel-name sets from the finalised _damageCards and the ledger, then drop the Key Cost
// Drivers bullets led by a floored panel. The Visible Damage Summary is not touched (batch 188).
// Floored = inspection-only cards (action 'inspect' / £0); costed = real repair/replace lines.
//
// batch 158 A4 (Vincent, 18 Sep: Key Cost Drivers must be built only from costed ledger rows) — TWO
// widenings, because the cards alone were not the ledger:
//   1. A panel with NO card at all was in neither set, so a driver line naming a panel the ledger never
//      costs was never dropped. The uncosted set is now derived from the LEDGER (_reconciledParts):
//      every COST-class panel that carries no money is a panel the drivers may not claim.
//   2. `if (!floored.length) return` skipped the whole scrub on a lot with no inspection-only card, so
//      the model's free text was never checked there at all. It now runs whenever a ledger exists.
// The no-over-scrub rule is unchanged and does the safety work: a line is dropped only if it names an
// uncosted panel AND names no costed one, so a shared keyword ("door") can only under-scrub, never over.
// Panels with no distinctive keyword (REAR_PANEL → []) match nothing either way, as before.
export function scrubFlooredProse(assessment) {
  const cards = Array.isArray(assessment?._damageCards) ? assessment._damageCards : [];
  const ledger = Array.isArray(assessment?._reconciledParts) ? assessment._reconciledParts : [];
  const cardFloored = cards.filter(c => String(c.action).toLowerCase() === 'inspect' || (c.cost ?? 0) === 0).map(c => c.part).filter(Boolean);
  const cardCosted = cards.filter(c => (c.cost ?? 0) > 0 && String(c.action).toLowerCase() !== 'inspect').map(c => c.part).filter(Boolean);

  const costedIds = new Set(ledger
    .filter(isChargedRow)   // batch 163 T2 — one owner, lib/ledgerEdits.mjs
    .map(r => r.panelId).filter(Boolean));
  const uncostedNames = ledger.length
    ? Object.keys(PANEL_DISPLAY).filter(id => PANEL_BEHAVIOUR[id] === PANEL_CLASS.COST && !costedIds.has(id))
      .map(id => PANEL_DISPLAY[id]).filter(n => panelKeywords(n).length > 0)
    : [];
  const uniq = (a) => [...new Set(a)];
  const costed = uniq([...cardCosted, ...[...costedIds].map(id => PANEL_DISPLAY[id]).filter(Boolean)]);
  const floored = uniq([...cardFloored, ...uncostedNames]).filter(n => !costed.includes(n));
  if (!floored.length) return { kcdDropped: [] };

  const kcd = scrubKCD(assessment['Key Cost Drivers'], floored, costed);
  assessment['Key Cost Drivers'] = kcd.text;
  return { kcdDropped: kcd.dropped };
}
