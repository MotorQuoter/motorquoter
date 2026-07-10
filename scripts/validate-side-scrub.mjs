// Unit tests for scrubSideWords (lib/sideScrub.mjs) — Option A residual set.
// Run: node scripts/validate-side-scrub.mjs   (expect "N passed, 0 failed")
import { scrubSideWords } from '../lib/sideScrub.mjs';

let pass = 0, fail = 0;

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

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
