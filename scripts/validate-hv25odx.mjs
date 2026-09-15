// validate-hv25odx — batch 136. Locks the HV25ODX failure shapes (15 Sep preview run, 1e8a730) so none can regress.
// Every input is the REAL stored shape from fixtures/HV25ODX/stored-shapes.json (extracted read-only, batch 135/136).
// HV25ODX has no model cassette, so this is not a replay: each section runs the real code on the real stored shapes.
//
// £0 — no network, no provider, no model. Run:
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-hv25odx.mjs
import { readFileSync } from 'node:fs';
import { selectProbeFramesForPanel } from '../app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want));
const H = JSON.parse(readFileSync('fixtures/HV25ODX/stored-shapes.json', 'utf8'));
const A = H.assessment;
const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');

console.log('\nA. batch 136 task A — the probe never chooses photos by left/right (the side ban)');
{
  const fz = A._frameZones;
  const lampObs = A._lampObs;
  const storedWing = A._attributionProbe.panels.find((p) => p.panelId === 'FRONT_WING');
  ok('STORED SHAPE: the wing was probed on [2,10] (rear three-quarter + spare wheel) and floored on cannot-determine',
     JSON.stringify(storedWing.frames) === '[2,10]' && storedWing.action === 'floored' && storedWing.verdict === 'cannot-determine');
  ok('STORED SHAPE: the log names the side filter', H.logLines.some((l) => l.includes('FRONT_WING cannot-determine floored frames=struck-side:offside:[2,10]')));
  ok('STORED SHAPE: struckSide=offside, front impact (apertureExposed)', lampObs.struckSide === 'offside' && lampObs.apertureExposed === true);
  const frontNeighbour = A._attributionProbe.panels.find((p) => p.panelId === 'BONNET');
  eq('STORED SHAPE: the front neighbours were probed on the front-tagged frames', frontNeighbour.frames, [0, 1, 8, 12]);

  // The real selector on the real stored frame tags. The wing's pooled zone on this run was flank-damaged-side (that is
  // the only zone under which the old P2 fired, and the log proves it fired).
  const wing = { panelId: 'FRONT_WING', zone: 'flank-damaged-side' };
  const got = selectProbeFramesForPanel(wing, fz, lampObs.apertureExposed === true);
  eq('NOW: the wing is probed on the SAME frames as its front neighbours', got.indices, frontNeighbour.frames);
  ok('NOW: the source says front-flank, not struck-side', got.source.startsWith('front-flank:') && !got.source.includes('struck-side'));
  ok('NOW: never frame 2 (rear three-quarter) or frame 10 (spare wheel)', !got.indices.includes(2) && !got.indices.includes(10));
  const door = selectProbeFramesForPanel({ panelId: 'FRONT_DOOR', zone: 'flank-damaged-side' }, fz, true);
  eq('a front door on the same impact gets the same front set', door.indices, frontNeighbour.frames);
  ok('the selector cannot take a side: arity 3, and the route passes no struckSide', selectProbeFramesForPanel.length === 3
     && route.includes('selectProbeFramesForPanel(cp, _frameZones, lampObs?.apertureExposed === true)')
     && !/struck-side:\$\{struckSide\}/.test(route));
  const notFront = selectProbeFramesForPanel(wing, fz, false);
  ok('not a front impact → the unchanged zone map (both sides + flank, never one side)', notFront.source.startsWith('frame-zone:') && notFront.indices.includes(2) && notFront.indices.includes(3));
}

console.log('\nB. batch 136 task B — "cannot determine" never deletes money (permanent ruling, 1 Sep)');
{
  const { probeVerdictAction, attribUnconfirmedWording, PROBE_CONTRADICTS } = await import('../app/api/salvage/assess/route.js');
  // Every verdict the probe can return, both branches: [verdict, missing, BEFORE (batch 135 behaviour), AFTER].
  const table = [
    ['consistent-with-claim', false, 'kept', 'kept'],
    ['no-damage-visible', false, 'floored', 'floored'],
    ['minor-cosmetic', false, 'floored', 'floored'],
    ['cannot-determine', false, 'floored', 'unconfirmed-kept'],
    ['something-off-enum', false, 'floored', 'unconfirmed-kept'],   // coerced to cannot-determine by runAttributionProbe
    ['absent', true, 'kept', 'kept'],
    ['area-destroyed', true, 'kept', 'kept'],
    ['present-and-intact', true, 'floored', 'floored'],
    ['minor-cosmetic-only', true, 'floored', 'floored'],
    ['cannot-determine', true, 'floored', 'unconfirmed-kept'],
  ];
  for (const [v, missing, before, after] of table) {
    eq(`verdict ${v} (${missing ? 'missing' : 'damaged'} branch): was ${before} → now`, probeVerdictAction(v, missing), after);
  }
  ok('only POSITIVE contradictions may floor', JSON.stringify(PROBE_CONTRADICTS) === JSON.stringify({ damaged: ['no-damage-visible', 'minor-cosmetic'], missing: ['present-and-intact', 'minor-cosmetic-only'] }));

  const storedWing = A._attributionProbe.panels.find((p) => p.panelId === 'FRONT_WING');
  eq('HV25ODX: the stored wing verdict (cannot-determine) now KEEPS the wing costed', probeVerdictAction(storedWing.verdict, false), 'unconfirmed-kept');
  const modelRow = A._preGateParts.find((p) => p.panelId === 'FRONT_WING');
  ok('HV25ODX: the wing the probe would have deleted is the model\'s £110 replace row', modelRow?.action === 'replace' && modelRow.used === 110);
  const note = attribUnconfirmedWording('Front wing', false);
  eq('buyer note, verbatim', note, 'A second photo check could not confirm the damage to the Front wing - it is included in the repair total. Inspect it, and strike the line if it proves sound.');
  ok('the note says it is IN the total and that the buyer can strike it', /included in the repair total/.test(note) && /strike the line/.test(note));
  ok('the note is Latin-1 with no dash (PDF flag reasons skip the dash mapping)', !/[^\x00-\xFF]/.test(note) && !/[—–]/.test(note) && !/[^\x00-\xFF]/.test(attribUnconfirmedWording('Grille', true)));
  ok('route: the probe loop decides through the one owner', route.includes('probeVerdictAction(r.verdict, missing)'));
  ok('route: an unconfirmed-kept panel stays independently visible and gets the note flag', route.includes('_attribUnconfirmed: true') && route.includes('reason:   attribUnconfirmedWording(PANEL_DISPLAY[cp.panelId], missing)'));
  ok('route: the old "a reached verdict floors" rule is gone from the comment', !route.includes('cannot-determine is shared with the damaged enum and floors in both'));
}

console.log('\nC. batch 136 task C — the buyer never sees raw model text, and a checker never blanks a section');
{
  const { bindClaimClasses } = await import('../lib/parts.mjs');
  const rows = A._reconciledParts.filter((r) => !/labour|paint|prep/i.test(r.name));
  const ctx = {
    lampType: A._lampResult?.lampType ?? null,
    allowedFigures: [...rows.map((r) => r.used ?? r.oem), A._partsReconciliation.parts_sum].filter((v) => v != null).map(Number),
    partActions: rows.map((r) => [r.name, r.action ?? 'replace']),
    demoted: ['Wheel', 'Front wing', 'Fog lamp'],   // "Wheel" is the demoted name the stored binding names
    evVerdict: null,
  };
  const storedVdsDrop = A._narrativeBindings.find((b) => b.surface === 'Visible Damage Summary');
  ok('STORED SHAPE: the one-sentence summary was dropped because "Wheel" matched "hanging at the wheel"', storedVdsDrop?.reason === '"Wheel" is demoted/uncosted in the ledger' && /hanging at the wheel/.test(storedVdsDrop.droppedSentence));
  ok('STORED SHAPE: the stored summary is an empty string', A['Visible Damage Summary'] === '');

  // C3 — the "wheel" false match.
  const vds = bindClaimClasses(storedVdsDrop.droppedSentence, ctx, 'redflags');
  // (a single contradicted sentence would now be KEPT WHOLE by C2, so each check below also asserts !keptWhole or uses a
  // second, uncontradicted sentence — otherwise a pass would prove nothing.)
  ok('C3: the summary sentence now SURVIVES on its own merits ("at the wheel" is the steering wheel, not the WHEEL panel)', vds.dropped.length === 0 && !vds.keptWhole && vds.text === storedVdsDrop.droppedSentence.trim());
  const steer = bindClaimClasses('The bonnet is crumpled. The airbag hanging at the steering wheel is a structural cost driver.', ctx, 'redflags');
  ok('C3: "steering wheel" does not match the WHEEL panel either', steer.dropped.length === 0 && !steer.keptWhole);
  // NB (reported, not changed — outside batch 136): the class-4 status regex (`\b(damag|…|replac|…)\b`) only matches
  // the bare stems, so "damaged" / "replacing" never trip it; "structural", "expensive", "costly", "repair" … do.
  const road = bindClaimClasses('The bonnet is crumpled. The front wheel is an expensive structural casualty.', ctx, 'redflags');
  ok('C3: a sentence that really names the road WHEEL as a cost driver is still bound (and only that sentence goes)', road.dropped.some((d) => d.class === 'part-status' && /front wheel/.test(d.sentence)) && road.text === 'The bonnet is crumpled.');

  // C4 — no orphan: the VAT bullet goes whole.
  const rawRF = A._raw.slice(A._raw.indexOf('Red Flags:') + 'Red Flags:'.length, A._raw.indexOf('Alternative Damage Scenario:')).trim();
  const rf = bindClaimClasses(rawRF, ctx, 'redflags');
  const rfLines = rf.text.split('\n').map((l) => l.trim());
  ok('C4: no bare "- Factor this into the bid ceiling." line survives', !rfLines.includes('- Factor this into the bid ceiling.') && !rf.text.includes('Factor this into the bid ceiling'));
  ok('C4: the VAT bullet is dropped whole (its £ sentence + its tail recorded)', rf.dropped.some((d) => d.class === 'figure' && /£3,600/.test(d.sentence)) && rf.dropped.some((d) => d.class === 'bullet-orphan' && /Factor this into the bid ceiling/.test(d.sentence)));
  ok('C4: bullets with no contradicted sentence are untouched', rfLines.some((l) => l.startsWith('- Front structural integrity:')) && rfLines.some((l) => l.startsWith('- Windscreen starred/cracked')));
  ok('C4: plain (non-bullet) prose still loses only the contradicting sentence', bindClaimClasses('The bonnet is crumpled. Budget £9,999 for it.', ctx, 'redflags').text === 'The bonnet is crumpled.');

  // C2 — never blank.
  const all = bindClaimClasses('- Budget £4,000+ for the airbag system.', ctx, 'redflags');
  ok('C2: when EVERY sentence would be dropped the field is KEPT WHOLE, not blanked', all.text === '- Budget £4,000+ for the airbag system.' && all.dropped.length === 0 && all.keptWhole?.length === 1);
  ok('C2: route records keptToAvoidBlank and logs it loudly', route.includes('keptToAvoidBlank: true') && route.includes('field KEPT WHOLE, not blanked'));

  // C1 + C5 — no raw text on either surface; screen and PDF agree.
  const page = readFileSync('app/salvage/success/page.js', 'utf8');
  const pdf = readFileSync('app/api/salvage/pdf/route.js', 'utf8');
  ok('C1: the screen has no raw-response render', !page.includes('{assessment._raw}') && !page.includes("!assessment['Visible Damage Summary'] && assessment._raw"));
  const pdfCode = pdf.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');   // comments may name what was removed
  ok('C5: the PDF no longer refills any field from _raw', !pdfCode.includes('parseFromRaw') && !pdfCode.includes('assessment._raw') && pdfCode.includes('function resolveFields(assessment) {\n  return assessment;\n}'));
  const zlib = (await import('node:zlib')).default;
  const { buildAssessmentPdf } = await import('../app/api/salvage/pdf/route.js');
  const bs = String.fromCharCode(92);
  const pdfText = (bytes) => { const buf = Buffer.from(bytes); const o = []; let i = 0; while (true) { const s0 = buf.indexOf('stream', i); if (s0 < 0) break; const e = buf.indexOf('endstream', s0); if (e < 0) break; let st = s0 + 6; if (buf[st] === 13) st++; if (buf[st] === 10) st++; let t; try { t = zlib.inflateSync(buf.subarray(st, e)).toString('latin1'); } catch { t = buf.subarray(st, e).toString('latin1'); } let d = 0, cur = '', esc = false; for (const ch of t) { if (d === 0) { if (ch === '(') { d = 1; cur = ''; } continue; } if (esc) { cur += ch; esc = false; continue; } if (ch === bs) { esc = true; continue; } if (ch === '(') { d++; cur += ch; continue; } if (ch === ')') { d--; if (d === 0) o.push(cur); else cur += ch; continue; } cur += ch; } i = e + 9; } return o.join(' '); };
  const log = console.log; console.log = () => {}; console.warn = () => {};
  const txt = pdfText(buildAssessmentPdf(A, H.vehicle_details, 'GB', 'HV25ODX', '15/09/2026', null, null));
  console.log = log;
  ok('C5: the STORED HV25ODX report\'s PDF no longer reprints the dropped summary sentence', !txt.includes('A 2025-plate, near-new Hyundai i20'));
  ok('C5: …and prints no model working (Part Verdicts / PART: lines / "Option B")', !/Part Verdicts|PART: FRONT_WING|Option B/.test(txt));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} hv25odx: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
