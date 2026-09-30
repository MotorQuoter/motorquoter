// batch 199 — Copart-declared faults: FLAG, NEVER COST (Vincent, 30 Sep 2026).
//
// Copart's "View Notes" lines sit BELOW the "VAT to be added to final price:" line of the paste, which the normaliser
// throws away (truncateAtVAT). Some of those lines are faults the seller declares — "TRANSMISSION FAULT",
// "UNDIAGNOSED NOISE FROM ENGINE BAY". The ruling: the buyer sees every one, none is costed, and the repair figure says
// it excludes them. Airbags are NOT here: "AIRBAGS DEPLOYED" keeps its own £500 floor (route.js analyseAirbagPaste).
//
// ONE owner: this file is the fixed list (phrase → buyer wording) and the only reader of the below-VAT text.
// ⛔ NEVER pass a raw below-VAT line to the buyer or to a prompt. That section also carries page chrome and, on some
// pastes, the account holder's name and email. Only the FIXED wording of a matched phrase leaves this file.
//
// Matching: phrase-anywhere, case-SENSITIVE upper case. Copart glues the first note onto page text
// ("Vehicle reportNUMBER OF KEYS 1", "View NotesWINDSCREEN DAMAGED"), so a line-start anchor misses most rows; the
// notes are always upper case and the page chrome, names and emails are not.
import { belowVatLine } from './normaliseLot.js';

// key · phrases (any one matches) · label (short, for the "Excludes …" line) · fault (reads after "Copart declare")
// · dedupe (a MODEL Red Flags line on the same fault — dropped so the buyer reads it once, in the code-owned words)
// · panelId (a ledger panel the photos can cost — see declaredFaultsFor).
//
// Dedupe is deliberately narrow: a model line is dropped only when the fault is its SUBJECT (the regex is anchored to
// the start of the line, bullet stripped) and it does not deny the fault ("no glass fracture" stays — the buyer should
// see the photos disagree). The £0 replay showed why: a free-text match dropped an airbag-collateral line that only
// mentioned the windscreen (SD75YGC), and a 12V/HV state-of-charge line (DL72FVX). Exceptions:
//   anywhere: true  — the transmission family. The model's line on an engine-start-only lot is an INFERENCE of the
//                     same fault (config/assessmentEngine.js:150/:453) and rarely leads with the word.
//   negationOk: true — the fault's own words are a negative ("will not start"), so a negative is not a denial.
export const DECLARED_FAULTS = [
  { key: 'TRANSMISSION_FAULT', phrases: ['TRANSMISSION FAULT'],
    label: 'transmission fault', fault: 'a transmission fault',
    dedupe: /transmission|gearbox|drivetrain/i, anywhere: true },
  { key: 'SELECTOR_STUCK_P', phrases: ['UNABLE TO MOVE TRANSMISSION IN P TO START ENGINE'],
    label: 'gear selector will not move in P', fault: 'that the gear selector cannot be moved in P to start the engine',
    dedupe: /transmission|gearbox|drivetrain|gear selector/i, anywhere: true },
  { key: 'ENGINE_BAY_NOISE', phrases: ['UNDIAGNOSED NOISE FROM ENGINE BAY'],
    label: 'undiagnosed engine-bay noise', fault: 'an undiagnosed noise from the engine bay',
    dedupe: /^(an? |the )?(undiagnosed )?(engine[- ]bay |engine )?noise\b/i },
  { key: 'ENGINE_NO_START', phrases: ['ENGINE WILL NOT START'],
    label: 'engine will not start', fault: 'that the engine will not start',
    dedupe: /^(the )?engine (will not|won'?t|does not|doesn'?t|fails? to|cannot|can'?t) start\b|^non-?start/i, negationOk: true },
  { key: 'EML_ON', phrases: ['ENGINE MANAGEMENT LIGHT ILLUMINATED', 'ENGINE MANAGEMENT LIGHT IS ON'],
    label: 'engine management light on', fault: 'that the engine management light is on',
    dedupe: /^(an? |the )?(engine management|EML\b|check[- ]engine)/i },
  { key: 'DASH_WARNING', phrases: ['DASHBOARD WARNING LIGHT ILLUMINATED'],
    label: 'dashboard warning light on', fault: 'that a dashboard warning light is on',
    dedupe: /^(an? |the )?dashboard warning light/i },
  { key: 'UNDERCARRIAGE', phrases: ['UNDERCARRIAGE DAMAGE'],
    label: 'undercarriage damage', fault: 'undercarriage damage',
    dedupe: /^(the )?undercarriage\b/i },
  { key: 'WINDSCREEN', phrases: ['WINDSCREEN DAMAGED'],
    label: 'damaged windscreen', fault: 'a damaged windscreen',
    dedupe: /^(the )?windscreen\b/i, panelId: 'WINDSCREEN' },
  { key: 'IGNITION', phrases: ['IGNITION DAMAGED'],
    label: 'damaged ignition', fault: 'a damaged ignition',
    dedupe: /^(the )?ignition\b/i },
  { key: 'LOW_BATTERY', phrases: ['LOW BATTERY'],
    label: 'low battery', fault: 'a low battery',
    dedupe: /^(an? |the )?(low|flat) (12v |12-volt )?battery\b/i },
  { key: 'BOOT_WONT_OPEN', phrases: ['UNABLE TO OPEN THE BOOT', 'UNABLE TO OPEN BOOT'],
    label: 'boot will not open', fault: 'that the boot will not open',
    dedupe: /^(the )?boot (will not|won'?t|cannot|can'?t|could not|does not) (be )?open/i, negationOk: true },
  { key: 'BONNET_WONT_OPEN', phrases: ['UNABLE TO OPEN BONNET', 'UNABLE TO OPEN THE BONNET'],
    label: 'bonnet will not open', fault: 'that the bonnet will not open',
    dedupe: /^(the )?bonnet (will not|won'?t|cannot|can'?t|could not|does not) (be )?open/i, negationOk: true },
  { key: 'STOLEN_RECOVERED', phrases: ['STOLEN RECOVERED VEHICLE'],
    label: 'stolen and recovered', fault: 'the vehicle stolen and recovered',
    dedupe: /^(the vehicle (is|was) )?(a )?stolen\b/i },
];

// A model Red Flags line that is about this fault (see the dedupe note above).
const _DENIES = /\b(no|not|without|none)\b/i;
export function modelLineIsSameFault(f, line) {
  const body = String(line).replace(/^[\s\-•*]+/, '');
  if (!f.dedupe.test(body)) return false;
  if (f.anywhere || f.negationOk) return true;
  return !_DENIES.test(body);
}

// Lines that are known and deliberately NOT faults: equipment, keys (read below), admin, and the airbag line (costed
// elsewhere). They are not logged as unmatched. HPI CHECK lines are never shown — the captures are often cut off.
const KNOWN_NOT_FAULTS = [
  /^NUMBER OF KEYS/, /^2ND SET OF KEYS/, /^HPI CHECK/, /^AIRBAGS DEPLOYED$/, /^VIEW FULL VEHICLE/,
  /^PLEASE SEE IMAGES FOR TRANSMISSION TYPE$/,
  /^(TYRE KIT|FLOOR MATS|DAB RADIO|ELECTRONIC HANDBRAKE|HANDS FREE BOOT RELEASE|USB CONNECTIONS|AIR CONDITIONING|BLUETOOTH PHONE|CLIMATE CONTROL|CRUISE CONTROL|ISOFIX CHILD SEAT SYSTEM|ISO FIX SYSTEM|KEYLESS ENTRY( AND START)?|LEATHER STEERING WHEEL|LEATHER INTERIOR|PARKING SENSORS? (FRONT|REAR)|REVERSING CAMERA|TOUCH SCREEN MONITOR|SPARE WHEEL|CENTRE ARMREST BETWEEN (FRONT|REAR) SEATS|GEAR SHIFT PADDLE CONTROLS|MIRRORS ELECTRIC FOLDING EXTERIOR|NAVIGATION SYSTEM|POWERED (HOOD|BOOT)|STEERING WHEEL MOUNTED REMOTE AUDIO CONTROLS|VIRTUAL COCKPIT|AUTOMATIC GEARBOX|CHARGING CABLES|ELECTRIC VEHICLE CHARGING CABLE|RETRACTABLE PARCEL SHELF|SEATS FRONT HEATED|SOS BUTTON|VOICE ACTIVATED CONTROLS|ADAPTIVE HEADLIGHTS|ALLOY WHEEL SIZE .*)$/,
];

// The upper-case tail of each below-VAT line (the part after any glued-on page text). Log use only — never shown.
function upperCaseTails(below) {
  const out = [];
  for (const line of below.split('\n')) {
    const m = line.trim().match(/[A-Z0-9][A-Z0-9 \-\/"'.,&()]*$/);
    const t = m ? m[0].trim() : '';
    if (t.length >= 4 && /[A-Z]{3,}/.test(t) && /\s/.test(t) && !/@/.test(t)) out.push(t);
  }
  return out;
}

// Read the paste. Returns { faults: [<DECLARED_FAULTS entry>...] (each once, list order), keys: { count, secondSet } }.
// Logs every upper-case line it neither matched nor knows, so new vocabulary shows up in the Vercel logs.
export function readDeclaredNotes(rawCopartPaste, log = console.log) {
  const below = belowVatLine(rawCopartPaste);
  const faults = DECLARED_FAULTS.filter(f => f.phrases.some(p => below.includes(p)));
  const kc = below.match(/NUMBER OF KEYS(?: WITH VEHICLE)? (\d+)/);
  const keys = { count: kc ? Number(kc[1]) : null, secondSet: below.includes('2ND SET OF KEYS AVAILABLE') };
  if (below) {
    for (const t of upperCaseTails(below)) {
      if (DECLARED_FAULTS.some(f => f.phrases.some(p => t.includes(p)))) continue;
      if (KNOWN_NOT_FAULTS.some(rx => rx.test(t))) continue;
      log(`[DECLARED] unmatched note line (not shown): ${JSON.stringify(t)}`);
    }
  }
  return { faults, keys };
}

// The buyer-facing sentences — ONE owner of each. The Red Flags line is Vincent's wording (30 Sep).
export const declaredFaultRedFlag = f =>
  `Copart declare ${f.fault}. Not costed — the repair figure excludes it. Get it diagnosed or price it yourself before bidding.`;
export const declaredFaultChecklistItem = f =>
  `Copart declare ${f.fault} — ask the handler what they know about it, and get it diagnosed or priced before bidding.`;
export const DECLARED_FAULTS_HEADING = 'Copart-declared faults — not costed';
export const declaredFaultsExclusionLine = labels =>
  labels.length ? `Excludes Copart-declared faults: ${labels.join(', ')}.` : '';

// Which declared faults the report may call "not costed". A fault whose panel the photos already cost (a charged row in
// the finished ledger — isChargedRow, CLAUDE.md rule 7) is NOT excluded from the figure, so the report must not say it
// is: it is returned in `costed` instead and gets no "not costed" line. HV25ODX: Copart declare WINDSCREEN DAMAGED and
// the ledger charges the windscreen.
export function declaredFaultsFor(faults, ledger, isChargedRow) {
  const notCosted = [], costed = [];
  for (const f of faults) {
    const row = f.panelId ? (ledger || []).find(r => r.panelId === f.panelId && isChargedRow(r)) : null;
    (row ? costed : notCosted).push(f);
  }
  return { notCosted, costed };
}

// The stored stamp — plain data, fixed wording only. Screen and PDF read this; they never re-read the paste.
export function declaredFaultsStamp(notCosted, costed, keys) {
  return {
    faults:  notCosted.map(f => ({ key: f.key, label: f.label, line: declaredFaultRedFlag(f) })),
    costed:  costed.map(f => ({ key: f.key, label: f.label })),
    exclusion: declaredFaultsExclusionLine(notCosted.map(f => f.label)),
    keys,
  };
}

// Vehicle details "Keys" value: the listing's Has key value plus what the notes say about keys (count, second set).
export function keysDetailText(hasKey, keys) {
  const bits = [];
  if (keys?.count != null) bits.push(`${keys.count} key${keys.count === 1 ? '' : 's'}`);
  if (keys?.secondSet) bits.push('second set available');
  return [hasKey, bits.join(', ')].filter(v => v && String(v).trim()).join(' - ') || null;
}

// Red Flags: drop MODEL lines on a declared fault (the buyer reads it once, in the code-owned words), then put one line
// per declared fault at the top — after a Cat A/B stop line, which always stays first. Returns { text, dropped }.
export function injectDeclaredRedFlags(redFlags, notCosted, catABStopLine = null) {
  // Our own lines from an earlier pass are removed first (never counted as a model line), so the step is idempotent.
  const ownLines = new Set(DECLARED_FAULTS.map(f => `- ${declaredFaultRedFlag(f)}`));
  const lines = (redFlags || '').split('\n').filter(l => l.trim() && !ownLines.has(l.trim()));
  const dropped = [];
  const kept = lines.filter(l => {
    if (catABStopLine && l.includes(catABStopLine)) return true;
    const hit = notCosted.find(f => modelLineIsSameFault(f, l));
    if (hit) { dropped.push({ key: hit.key, line: l }); return false; }
    return true;
  });
  const ours = notCosted.map(f => `- ${declaredFaultRedFlag(f)}`);
  const stopIdx = catABStopLine ? kept.findIndex(l => l.includes(catABStopLine)) : -1;
  const out = stopIdx >= 0 ? [...kept.slice(0, stopIdx + 1), ...ours, ...kept.slice(stopIdx + 1)] : [...ours, ...kept];
  return { text: out.join('\n'), dropped };
}

// The whole step, as the assess route runs it (after both model calls, after the provenance line). ONE function so the
// £0 proof on stored rows runs exactly this. Mutates `assessment`: _declaredFaults stamp, Red Flags, checklist. The
// ledger (_reconciledParts / _partsReconciliation) is read, never written.
export function applyDeclaredFaults(assessment, rawCopartPaste, { isChargedRow, catABStopLine = null, log = console.log } = {}) {
  const declared = readDeclaredNotes(rawCopartPaste, log);
  const { notCosted, costed } = declaredFaultsFor(declared.faults, assessment._reconciledParts, isChargedRow);
  assessment._declaredFaults = declaredFaultsStamp(notCosted, costed, declared.keys);
  for (const f of costed) log(`[DECLARED] ${f.key} — the ledger already charges ${f.panelId}; not called "not costed"`);
  if (notCosted.length) {
    const rf = injectDeclaredRedFlags(assessment['Red Flags'], notCosted, catABStopLine);
    assessment['Red Flags'] = rf.text;
    for (const d of rf.dropped) log(`[DECLARED] model Red Flags line dropped (same fault ${d.key}): ${JSON.stringify(d.line.slice(0, 120))}`);
    assessment['WhatsApp Inspection Checklist'] = appendDeclaredChecklist(assessment['WhatsApp Inspection Checklist'], notCosted);
  }
  log(`[DECLARED] faults=[${notCosted.map(f => f.key).join(',')}] costed-on-photos=[${costed.map(f => f.key).join(',')}] keys=${JSON.stringify(declared.keys)} — flag only, parts_sum untouched`);
  return assessment._declaredFaults;
}

// Checklist: one numbered item per declared fault, appended; an item already present is not added twice.
export function appendDeclaredChecklist(checklist, notCosted) {
  let text = (checklist || '').trim();
  let next = (text.match(/^\d+[.)]/mg) || []).length + 1;
  for (const f of notCosted) {
    const item = declaredFaultChecklistItem(f);
    if (text.includes(item)) continue;
    text += `${text ? '\n' : ''}${next}. ${item}`;
    next++;
  }
  return text;
}
