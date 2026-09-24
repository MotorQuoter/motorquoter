// validate-batch185.mjs — batch 185 P1: the two mixed Margin shapes are replaced by rule (Vincent, 24 Sep).
// Shape A: band-position sentence + "whose cost is dominated by …" clause → head kept, closed with ".", code sentence after.
// Shape B: "The repair is a … — list — with the X swing sitting in / being Y." → code sentence + "The X swing sits in / is Y."
// Any other mixed sentence stays held. £0, pure, no model calls. (P2 and P3 are trace only: nothing built.)
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch185.mjs
import { readFileSync } from 'fs';
import { DRIVER_SENTENCE, codeOwnDriverSentence } from '@/lib/parts.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const LAB = (oem) => ({ name: 'Labour & paint (new & painted)', action: '—', used: null, oem, _codeLabour: true });
const ROWS = [
  { panelId: 'FRONT_DOOR', name: 'Front door', action: 'replace', used: 330 },
  { panelId: 'REAR_DOOR', name: 'Rear door', action: 'replace', used: 310 },
  LAB(2500),
];
const D = DRIVER_SENTENCE(ROWS);
ok('the code sentence for these rows', D === 'The repair total is made up of: the front door (replace), the rear door (replace) and labour & paint.');

console.log('\n-- shape A: band position + driver clause --');
{
  // DMZ4614, stored text verbatim
  const S = 'The band position is mid: the lot has strong desirability signals (low mileage, current-generation N Line manual, petrol) offset by a moderate-to-heavy single-flank repair whose cost is dominated by two door shells, paint labour, and the sill zone.';
  const IN = `${S} The repair is moderate in the outer-panel scope.`;
  const r = codeOwnDriverSentence(IN, ROWS);
  ok('(DMZ4614) head kept word for word, cut before "whose", closed with ".", code sentence follows',
    r.text === `The band position is mid: the lot has strong desirability signals (low mileage, current-generation N Line manual, petrol) offset by a moderate-to-heavy single-flank repair. ${D} The repair is moderate in the outer-panel scope.`);
  ok('stamp: shape A, before = the whole sentence, after = head + code sentence', r.stamp?.shape === 'A' && r.stamp.before === S && r.stamp.after.endsWith(D) && r.held.length === 0);
  ok('the dropped clause (the sill) is gone', !/sill/.test(r.text));
  for (const verb of ['driven by', 'made up of']) {
    const t = `The band position is low, offset by a heavy repair whose cost is ${verb} the bonnet.`;
    ok(`shape A also takes "whose cost is ${verb}"`, codeOwnDriverSentence(t, ROWS).text === `The band position is low, offset by a heavy repair. ${D}`);
  }
}

console.log('\n-- shape B: rebuild list + swing clause --');
{
  // EA17HDN — "sitting in"
  const EA = 'The repair is a moderate front-corner rebuild — bumper, support and mirror with paint — with the genuine cost swing sitting in the unconfirmed radiator pack and front inner structure.';
  const r = codeOwnDriverSentence(`I chose mid. ${EA} If those are clean, it stands.`, ROWS);
  ok('(EA17HDN) "with the X swing sitting in Y" → code sentence + "The X swing sits in Y."',
    r.text === `I chose mid. ${D} The genuine cost swing sits in the unconfirmed radiator pack and front inner structure. If those are clean, it stands.`);
  ok('stamp: shape B, before = the whole sentence', r.stamp?.shape === 'B' && r.stamp.before === EA);
  // SA26KVT — "being"
  const SA = 'The repair is a moderate-to-heavy front-end rebuild — radiator pack, bonnet, slam panel, wing, lamp and bumper assembly, per the Parts Breakdown — with the material swing being whether the front structure is straight.';
  const s = codeOwnDriverSentence(SA, ROWS);
  ok('(SA26KVT) "with the X swing being Y" → code sentence + "The X swing is Y."', s.text === `${D} The material swing is whether the front structure is straight.` && s.stamp?.shape === 'B');
  // any other swing wording is held
  for (const other of [
    'The repair is a moderate rebuild — bumper and mirror — with the swing depending on the radiator pack.',
    'The repair is a moderate rebuild — bumper and mirror — where the cost swing sits in the radiator pack.',
    'The repair is a moderate rebuild — bumper and mirror — with the cost swing sitting in the radiator pack, and more besides — see below.',
  ]) {
    const h = codeOwnDriverSentence(other, ROWS);
    ok(`other swing wording held, text untouched: "${other.slice(52, 100)}…"`, h.text === other && h.stamp === null && h.held.length === 1 && h.held[0] === other);
  }
  const noShape = 'The band position is mid because the swing sits in the radiator pack and the cost is driven by doors.';
  const n = codeOwnDriverSentence(noShape, ROWS);
  ok('a band-position sentence with no "whose" clause matches neither shape → held', n.text === noShape && n.stamp === null && n.held.length === 1);
}

console.log('\n-- the 183 P3 tail goes with the sentence --');
{
  const TAIL = ' Not in the repair total: the sill — check it on inspection.';
  const A = 'The band position is mid, offset by a repair whose cost is dominated by two door shells and the sill zone.';
  const ra = codeOwnDriverSentence(`${A}${TAIL} Next.`, ROWS);
  ok('shape A: tail removed with the sentence', ra.text === `The band position is mid, offset by a repair. ${D} Next.` && ra.stamp.before === `${A}${TAIL}`);
  const B = 'The repair is a rebuild — bumper and sill — with the cost swing being the sill.';
  const rb = codeOwnDriverSentence(`${B}${TAIL} Next.`, ROWS);
  ok('shape B: tail removed with the sentence', rb.text === `${D} The cost swing is the sill. Next.` && rb.stamp.before === `${B}${TAIL}`);
}

console.log('\n-- a plain driver sentence stays exactly as batch 184 wrote it --');
{
  const rows = [{ panelId: 'WHEEL_ARCH_MOULDING', name: 'Wheel arch moulding', action: 'replace', used: 50, oem: 100 }, LAB(1000)];
  const IN = 'I chose mid-high. The repair is driven by the rear quarter blend, the rear bumper replacement and the sill work. Not in the repair total: the rear bumper and the sill — check them on inspection. The margin picture depends on the sill.';
  const r = codeOwnDriverSentence(IN, rows);
  ok('(EN23NJX) text as batch 184', r.text === 'I chose mid-high. The repair total is made up of: the wheel arch moulding (replace) and labour & paint. The margin picture depends on the sill.');
  ok('plain stamp carries no shape key (batch 184 stamp shape unchanged)', r.stamp && !('shape' in r.stamp) && Object.keys(r.stamp).join(',') === 'before,after,rows');
  const held = 'The repair is a rebuild — bumper — with the swing depending on it.';
  const two = codeOwnDriverSentence(`${held} The repair is driven by the bonnet.`, rows);
  ok('a held mixed sentence before a plain driver: held, and the driver is still replaced', two.held.length === 1 && two.text.startsWith(held) && two.text.endsWith('labour & paint.'));
}

console.log('\n-- route wiring --');
{
  const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');
  ok('route: the shape is logged on the replaced stamp', route.includes("(mixed, shape ${_dr.stamp.shape})"));
  ok('route: still Margin only, same call', route.includes("if (field === 'Margin Calculation') {") && route.includes('codeOwnDriverSentence(assessment[field], _chargedRows)'));
  const parts = readFileSync(new URL('../lib/parts.mjs', import.meta.url), 'utf8');
  ok('no rule keyed on a registration', !/[A-Z]{2}\d{2}[A-Z]{3}|DMZ4614|EA17HDN|SA26KVT/.test(parts.slice(parts.indexOf('batch 185 P1'), parts.indexOf('export function bindClaimClasses'))));
}

console.log(`\nbatch185: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
