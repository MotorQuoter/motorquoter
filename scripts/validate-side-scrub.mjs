// Unit tests for scrubSideWords (lib/sideScrub.mjs) — Option A residual set.
// Run: node scripts/validate-side-scrub.mjs   (expect "N passed, 0 failed")
import { scrubSideWords } from '../lib/sideScrub.mjs';
import { sanitizeSideTerms } from '../lib/sanitizeProse.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function prose_ok(label, cond) {
  if (cond) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}`); fail++; }
}

// Assert the scrubbed cell + the changed/guarded flags.
function check(label, input, expectName, expectChanged, expectGuarded) {
  const r = scrubSideWords(input);
  const ok = r.name === expectName
    && r.changed === expectChanged
    && r.guarded === expectGuarded;
  if (ok) { console.log(`  PASS — ${label}`); pass++; }
  else {
    console.log(`  FAIL — ${label}`);
    console.log(`         input="${input}"`);
    console.log(`         got   name="${r.name}" changed=${r.changed} guarded=${r.guarded}`);
    console.log(`         want  name="${expectName}" changed=${expectChanged} guarded=${expectGuarded}`);
    fail++;
  }
}

console.log('── scrubSideWords — reachable residual set (left/right/n/s/o/s), removal semantics ──');

// Ratified reachable cases
check('bare-left + dangling hyphen',  'Front-left tyre (shredded)',        'Front tyre (shredded)',        true,  false);
check('bare-left inside parens',      'Driveshaft (front-left, suspected)', 'Driveshaft (front, suspected)', true,  false);
check('n/s abbreviation',             'N/S wing',                          'wing',                          true,  false);
check('o/s abbreviation',             'O/S mirror',                        'mirror',                        true,  false);

// Passthrough — no residual token present
check('passthrough (no token)',       'Front bumper',                      'Front bumper',                  false, false);

// Guard — cell is ONLY a residual token: keep original, never blank
check('guard (only a side token)',    'Left',                              'Left',                          false, true);
check('guard (only n/s)',             'N/S',                               'N/S',                           false, true);

// Boundary — must NOT touch Item 15's substitution output ("damaged-side"/"opposite-side")
check('boundary vs Item 15 output',   'Front headlamp (damaged-side)',     'Front headlamp (damaged-side)', false, false);

// Boundary — must NOT touch words merely CONTAINING a token
check('word containing "left"',       'Cleft pillar trim',                 'Cleft pillar trim',             false, false);
check('word containing "right"',      'Upright support bracket',           'Upright support bracket',       false, false);

// bare-right coverage
check('bare-right',                   'Front right wing',                  'Front wing',                    true,  false);

// sanitizeSideTerms (lib/sanitizeProse.js) - batch 141 item 6a
// The prose layer SUBSTITUTES an absolute side label for a relative one. A substituted phrase
// that ends the clause ("cracked through on the opposite-side") names no part and tells the
// buyer nothing, so it is dropped; used as an adjective it must survive untouched.
console.log('\n-- sanitizeSideTerms - dangling substituted side phrase --');
function prose(label, input, expected) {
  const got = sanitizeSideTerms(input);
  if (got === expected) { console.log(`  PASS — ${label}`); pass++; }
  else {
    console.log(`  FAIL — ${label}`);
    console.log(`         input="${input}"`);
    console.log(`         got  ="${got}"`);
    console.log(`         want ="${expected}"`);
    fail++;
  }
}

// The shipped HV25ODX defect, and the same shape with each punctuation terminator.
prose('HV25ODX windscreen line',        'Windscreen: cracked through on the nearside - full replacement.',
                                        'Windscreen: cracked through - full replacement.');
prose('terminal before a full stop',    'Windscreen: cracked through on the passenger side. Next.',
                                        'Windscreen: cracked through. Next.');
prose('terminal before a semicolon',    'Impact on the offside;',            'Impact;');
prose('terminal before an em dash',     'cracked on the nearside — replace', 'cracked — replace');
prose('terminal at end of string',      'Glass cracked through on the offside', 'Glass cracked through');

// Adjectival use - a noun follows, the phrase carries information, KEEP.
prose('adjective: opposite front wing', 'Replace the nearside front wing.',  'Replace the opposite front wing.');
prose('adjective: damaged front wing',  'Damage on the offside front wing and door.',
                                        'Damage on the damaged front wing and door.');
prose('adjective: damaged front wheel', 'Check the offside front wheel (bent).',
                                        'Check the damaged front wheel (bent).');
prose('subject, not a locative',        'The nearside is undamaged.',        'The opposite-side is undamaged.');
prose('compound noun survives',         'Right hand drive car with nearside damage',
                                        'Right hand drive car with opposite-side damage');

// Vehicle spec must still survive the whole pass verbatim.
prose('RHD spec untouched',             'Right hand drive, LHD conversion', 'Right hand drive, LHD conversion');

// Idempotent - the chokepoint may run more than once.
prose('idempotent',                     sanitizeSideTerms('Windscreen: cracked through on the nearside - full replacement.'),
                                        'Windscreen: cracked through - full replacement.');

// -- batch 143 T3: no internal language in a buyer-facing amalgamate reason ---------------------
// Batch 141 item 5 took "per-view read" out of AMALG_REASON_NOT_VISIBLE; T3 takes "per-view
// disagreement" out of AMALG_REASON_DISAGREE. Read from the SHIPPED route.js source, so the whole
// family is swept and a new one cannot reintroduce the vocabulary.
console.log('\n-- amalgamate reasons: plain buyer words only --');
{
  const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  const reasons = [...src.matchAll(/^const (AMALG_REASON_[A-Z_]+)\s*=\s*'([^']+)';/gm)];
  prose_ok(`the reason constants were read from route.js (got ${reasons.length})`, reasons.length >= 8);
  const BANNED = /per[-\s]?view|probe|amalgam|\biv:|_[a-zA-Z]+[A-Z]/;
  for (const [, name, body] of reasons) {
    prose_ok(`${name} carries no internal vocabulary`, !BANNED.test(body));
  }
  const dis = reasons.find(([, n]) => n === 'AMALG_REASON_DISAGREE');
  prose_ok('AMALG_REASON_DISAGREE opens with the buyer wording', !!dis && dis[2].startsWith('the listing photographs disagree on this part'));
  prose_ok('and still says WHAT the disagreement is', !!dis && /undamaged in at least one photo and damaged in another/.test(dis[2]));
  prose_ok('and still routes to the WhatsApp inspection', !!dis && /WhatsApp inspection before bidding/.test(dis[2]));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
