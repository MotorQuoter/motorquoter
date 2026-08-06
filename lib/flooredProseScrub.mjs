// flooredProseScrub — deterministic post-processor that stops model-authored prose from asserting
// confirmed severe damage on a panel the pipeline FLOORED (graded-to-floor, not costed). The model
// authors Key Cost Drivers + the Visible Damage Summary standfirst from its visual read; "FLOORED"
// is a downstream code decision, so the two diverge and no prompt clause reliably closes it (proven
// on the harness: a vocab ban left KCD/VDS at 7/10). This uses the FINAL ledger as ground truth:
//   - KCD: drop any cost-driver line whose lead panel is FLOORED (a floored panel is not a costed
//     driver, by definition) — but KEEP the line if it also names a COSTED panel (no over-scrub).
//   - VDS: strip a severe/confirmed-damage adjective only where it directly qualifies a FLOORED
//     panel; costed panels and non-adjacent text are left exactly as written.
// Pure, no I/O. (Cowork §12/§13.)

// Confirmed severe-damage words that must not qualify a floored panel — STEMMED, so both adjective
// and noun forms match (deformed/deformation, crushed/crushing, crease/creased, folded/folding).
const SEVERE_RE = '(?:crush|crumpl|buckl|creas|mangl|shred|deform|collaps|shatter|destr|fold|obliterat|stov|caved)\\w*';

// Position/qualifier words that don't distinguish a panel, plus generic nouns shared across panels.
const QUALIFIERS = new Set(['front', 'rear', 'near', 'off', 'nearside', 'offside', 'left', 'right',
  'side', 'upper', 'lower', 'outer', 'inner', 'structural', 'the', 'and', 'a', 'of', 'both', 'twin']);
const GENERIC = new Set(['panel', 'pack', 'assembly', 'area', 'section', 'unit', 'srs']);

// Reduce a panel display name to its distinctive keyword(s) for matching against free prose.
export function panelKeywords(name) {
  return String(name || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')            // drop parentheticals e.g. "(deployed)"
    .replace(/[^a-z\s/]/g, ' ')
    .split(/[\s/]+/)
    .filter(w => w.length > 2 && !QUALIFIERS.has(w) && !GENERIC.has(w));
}

const wordIn = (text, word) => new RegExp(`\\b${word}s?\\b`, 'i').test(text);  // tolerate plurals ("doors"→"door")
const refs = (text, panels) => panels.some(p => panelKeywords(p).some(k => wordIn(text, k)));

// Drop KCD cost-driver lines whose LEAD panel (phrase before the first colon) is floored and which
// do NOT also name a costed panel. Non-driver lines (headers, format notes) pass through untouched.
export function scrubKCD(kcdText, flooredNames, costedNames) {
  if (!kcdText) return { text: kcdText, dropped: [], changes: [] };
  const dropped = [];
  const kept = kcdText.split('\n').filter(line => {
    const trimmed = line.trim();
    if (!/^[-*]/.test(trimmed)) return true;               // only touch bulleted driver lines
    const lead = (trimmed.split(':')[0] || '');            // panel phrase before the reason
    const refsFloored = refs(lead, flooredNames);
    const refsCosted = refs(lead, costedNames);
    if (refsFloored && !refsCosted) { dropped.push(trimmed); return false; }  // floored-only → drop
    return true;
  });
  // Kept lines can still name a floored panel in their reason text (multi-panel lines, or a floored
  // panel referenced mid-reason) — neutralise severe adjectives on floored panels there too.
  const neut = neutraliseVDS(kept.join('\n'), flooredNames, costedNames);
  return { text: neut.text, dropped, changes: neut.changes };
}

// Strip a severe adjective only where it directly qualifies a FLOORED panel keyword (adjective
// within two words either side of the keyword). Costed-panel keywords are never targeted.
export function neutraliseVDS(vdsText, flooredNames, costedNames) {
  if (!vdsText) return { text: vdsText, changes: [] };
  const changes = [];
  // Keywords that belong to a floored panel and NOT to any costed panel (avoid collateral edits).
  const costedKw = new Set(costedNames.flatMap(panelKeywords));
  const flooredKw = [...new Set(flooredNames.flatMap(panelKeywords))].filter(k => !costedKw.has(k));
  if (!flooredKw.length) return { text: vdsText, changes: [] };
  const kwRe = flooredKw.join('|');
  let out = vdsText;

  // "<severe> [word] <flooredKeyword>"  e.g. "crushed outer sill" → "outer sill"
  const before = new RegExp(`\\b(${SEVERE_RE})\\s+((?:\\w+\\s+){0,2}?)(${kwRe})\\b`, 'gi');
  out = out.replace(before, (m, sev, mid, kw) => { changes.push(`${sev}→∅ before "${kw}"`); return `${mid}${kw}`; });

  // "<flooredKeyword> [word] <severe>"  e.g. "front wing crushed back" → "front wing back"
  const after = new RegExp(`\\b(${kwRe})(\\s+(?:\\w+\\s+){0,2}?)(${SEVERE_RE})\\b`, 'gi');
  out = out.replace(after, (m, kw, mid, sev) => { changes.push(`${sev}→∅ after "${kw}"`); return `${kw}${mid.replace(/\s+$/, '')}`; });

  // Tidy any double spaces the removals leave behind.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;])/g, '$1');
  return { text: out, changes };
}

// Derive floored vs costed panel-name sets from the finalised _damageCards, then scrub both fields.
// Floored = inspection-only cards (action 'inspect' / £0); costed = real repair/replace lines.
export function scrubFlooredProse(assessment) {
  const cards = Array.isArray(assessment?._damageCards) ? assessment._damageCards : [];
  const floored = cards.filter(c => String(c.action).toLowerCase() === 'inspect' || (c.cost ?? 0) === 0).map(c => c.part).filter(Boolean);
  const costed = cards.filter(c => (c.cost ?? 0) > 0 && String(c.action).toLowerCase() !== 'inspect').map(c => c.part).filter(Boolean);
  if (!floored.length) return { kcdDropped: [], vdsChanges: [] };

  const kcd = scrubKCD(assessment['Key Cost Drivers'], floored, costed);
  const vds = neutraliseVDS(assessment['Visible Damage Summary'], floored, costed);
  assessment['Key Cost Drivers'] = kcd.text;
  assessment['Visible Damage Summary'] = vds.text;
  return { kcdDropped: kcd.dropped, kcdChanges: kcd.changes, vdsChanges: vds.changes };
}
