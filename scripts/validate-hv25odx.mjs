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

console.log('\nD1. batch 136 task D1 — every One Auto call is recorded; a failed Brego is retried and logged as a failure');
{
  const { oneAutoFetch, finaliseOneAutoRec, redactOneAutoBody } = await import('../app/api/salvage/assess/route.js');
  ok('STORED SHAPE: HV25ODX had no valuation', H.bregoValuation === null);
  ok('STORED SHAPE: its log carried ONLY "MISS->fetch" for Brego — no status, no body, no reason', H.logLines.filter((l) => l.includes('BREGO_GB')).length === 1 && H.logLines.some((l) => l.includes('BREGO_GB:HV25ODX:7bcff6f2336f MISS->fetch')));

  const noSleep = { sleep: async () => {} };
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
  const seq = (...rs) => { let i = 0; return async () => { const r = rs[Math.min(i++, rs.length - 1)]; if (r instanceof Error) throw r; return r; }; };
  const pick = (raw) => { const result = raw?.result ?? raw; return (result && !result.error) ? result : null; };

  let rec = {};
  let out = await oneAutoFetch(rec, 'u', {}, pick, { retries: 2, ...noSleep, fetchImpl: seq(resp(503, 'Service Unavailable'), resp(200, '{"result":{"trade_low_valuation":9000}}')) });
  ok('503 then 200 → retried, value returned, 2 attempts recorded, status 200', out?.trade_low_valuation === 9000 && rec.attempts === 2 && rec.httpStatus === 200 && rec.outcome === 'ok');
  rec = {};
  out = await oneAutoFetch(rec, 'u', {}, pick, { retries: 2, ...noSleep, fetchImpl: seq(resp(404, '{"error":"VRM not found"}')) });
  ok('404 → NOT retried (deterministic), status + body recorded', out === null && rec.attempts === 1 && rec.httpStatus === 404 && rec.outcome === 'http-error' && rec.errorBody === '{"error":"VRM not found"}');
  rec = {};
  out = await oneAutoFetch(rec, 'u', {}, pick, { retries: 2, ...noSleep, fetchImpl: seq(new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET')) });
  ok('network throw ×3 → 3 attempts, outcome threw, message recorded', out === null && rec.attempts === 3 && rec.outcome === 'threw' && /ECONNRESET/.test(rec.errorBody));
  rec = {};
  out = await oneAutoFetch(rec, 'u', {}, pick, { retries: 2, ...noSleep, fetchImpl: seq(resp(429, 'slow down'), resp(502, 'Bad Gateway'), resp(200, '{"result":{"x":1}}')) });
  ok('429 and 5xx are transient → retried until the value comes back (3 attempts)', out?.x === 1 && rec.attempts === 3);
  // D1 note: "record 204 explicitly as no-data (distinct from an error). Retry only on network errors / 5xx / 429,
  // never on 204." HV25ODX's real answer (Vincent's One Auto audit export): brego/valuationfromvrm status 204.
  rec = {};
  let calls = 0;
  out = await oneAutoFetch(rec, 'u', {}, pick, { retries: 2, ...noSleep, fetchImpl: async () => { calls++; return calls === 1 ? resp(204, '') : resp(200, '{"result":{"x":1}}'); } });
  ok('HV25ODX shape — 204 No Content → outcome "no-data", NOT retried (1 call, 1 attempt), status 204 kept, no error body', out === null && calls === 1 && rec.attempts === 1 && rec.outcome === 'no-data' && rec.httpStatus === 204 && rec.errorBody === null);
  ok('"no-data" is distinct from an error outcome', rec.outcome !== 'http-error' && rec.outcome !== 'threw');
  rec = {}; calls = 0;
  out = await oneAutoFetch(rec, 'u', {}, pick, { retries: 2, ...noSleep, fetchImpl: async () => { calls++; return calls === 1 ? resp(200, '') : resp(200, '{"result":{"x":1}}'); } });
  ok('an empty 200 body is recorded ("empty") and NOT retried', out === null && calls === 1 && rec.outcome === 'empty');
  rec = {}; calls = 0;
  out = await oneAutoFetch(rec, 'u', {}, pick, { retries: 2, ...noSleep, fetchImpl: async () => { calls++; return calls === 1 ? resp(200, '<html>') : resp(200, '{"result":{"x":1}}'); } });
  ok('a non-JSON 200 body is recorded ("unparseable") and NOT retried', out === null && calls === 1 && rec.outcome === 'unparseable' && rec.errorBody === '<html>');
  ok('route: no retry path treats an empty / non-JSON 2xx as transient', !/rec\.outcome = raw === undefined \? 'unparseable' : 'empty';\s*\n\s*transient = true;/.test(route));
  rec = {};
  out = await oneAutoFetch(rec, 'u', {}, pick, { retries: 2, ...noSleep, fetchImpl: seq(resp(200, '{"success":false,"error":"no valuation available"}'), resp(200, '{"result":{"x":1}}')) });
  ok('a well-formed "no result" answer is NOT retried (another paid call would give the same answer)', out === null && rec.attempts === 1 && rec.outcome === 'no-result' && /no valuation available/.test(rec.errorBody));
  rec = {};
  out = await oneAutoFetch(rec, 'u', {}, pick, { fetchImpl: seq(resp(500, 'boom')) });
  ok('non-Brego calls (retries 0) are recorded but not retried', out === null && rec.attempts === 1 && rec.httpStatus === 500);
  ok('error bodies never carry a key', !/sk-|abc123/.test(redactOneAutoBody('{"x-api-key":"abc123","authorization":"Bearer sk-live-999"}')) && redactOneAutoBody('x'.repeat(900)).length === 300);
  const hit = finaliseOneAutoRec({ label: 'SALVAGEHISTORY', httpStatus: 200, attempts: 1 }, { cache: 'hit', cacheKey: 'SALVAGEHISTORY:HV25ODX' }, { ok: 1 });
  ok('a cache HIT is recorded as a hit, with NO http status (none was made)', hit.outcome === 'cache-hit' && hit.httpStatus === null && hit.attempts === 0 && hit.cacheKey === 'SALVAGEHISTORY:HV25ODX');

  const { withOneAutoCache, __setOneAutoReplayProvider } = await import('../lib/oneautoCache.js');
  __setOneAutoReplayProvider(() => null);
  const meta = {};
  await withOneAutoCache('BREGO_GB', 'HV25ODX', { current_mileage: 53544 }, async () => null, meta);
  __setOneAutoReplayProvider(null);
  ok('withOneAutoCache fills the meta object (param shape, slot 5)', meta.cache === 'replay');
  const meta2 = {};
  __setOneAutoReplayProvider(() => null);
  await withOneAutoCache('SALVAGEHISTORY', 'HV25ODX', async () => null, meta2);
  __setOneAutoReplayProvider(null);
  ok('…and on the legacy shape (slot 4)', meta2.cache === 'replay');

  ok('route: no One Auto fetch still throws away status and body (`r.ok ? JSON.parse`)', !/const raw = r\.ok \? JSON\.parse\(await r\.text\(\) \|\| 'null'\) : null;/.test(route));
  ok('route: GB Brego and ROI Brego are both retried (retries: 2)', (route.match(/\{ retries: 2 \}/g) || []).length === 2);
  ok('route: a failed Brego is logged loudly as [BREGO FAILED]', (route.match(/\[BREGO FAILED\]/g) || []).length >= 2);
  ok('route: the call records are stored on the session (vehicle_details) and on the assessment', route.includes('(enrichedVd._oneAutoCalls ||= []).push(') && route.includes('assessment._oneAutoCalls = enrichedVd._oneAutoCalls ?? [];'));
}

console.log('\nD3. batch 136 task D3 — a missing valuation is said plainly, screen AND PDF');
{
  const { NO_VALUATION_NOTE } = await import('../config/booking.mjs');
  eq('the sentence, verbatim as the brief gives it', NO_VALUATION_NOTE, 'No market valuation was returned for this vehicle, so the after-repair value, bid ladder and rebuild ceiling are not shown. The repair estimate above is complete.');
  const page = readFileSync('app/salvage/success/page.js', 'utf8');
  const pdf = readFileSync('app/api/salvage/pdf/route.js', 'utf8');
  ok('screen: the false "engine used wider confidence range" line is gone', !page.includes('engine used wider confidence range'));
  ok('screen: the no-valuation branch renders the one-owner sentence', page.includes('{NO_VALUATION_NOTE}') && page.includes("NO_VALUATION_NOTE") && /import \{[^}]*NO_VALUATION_NOTE[^}]*\} from '@\/config\/booking\.mjs'/.test(page));
  ok('PDF: the valuation section has an else branch using the same sentence', pdf.includes('str(NO_VALUATION_NOTE)') && /import \{[^}]*NO_VALUATION_NOTE[^}]*\} from '@\/config\/booking\.mjs'/.test(pdf));
  const zlib = (await import('node:zlib')).default;
  const { buildAssessmentPdf } = await import('../app/api/salvage/pdf/route.js');
  const bs = String.fromCharCode(92);
  const chunks = (bytes) => { const buf = Buffer.from(bytes); const o = []; let i = 0; while (true) { const s0 = buf.indexOf('stream', i); if (s0 < 0) break; const e = buf.indexOf('endstream', s0); if (e < 0) break; let st = s0 + 6; if (buf[st] === 13) st++; if (buf[st] === 10) st++; let t; try { t = zlib.inflateSync(buf.subarray(st, e)).toString('latin1'); } catch { t = buf.subarray(st, e).toString('latin1'); } let d = 0, cur = '', esc = false; for (const ch of t) { if (d === 0) { if (ch === '(') { d = 1; cur = ''; } continue; } if (esc) { cur += ch; esc = false; continue; } if (ch === bs) { esc = true; continue; } if (ch === '(') { d++; cur += ch; continue; } if (ch === ')') { d--; if (d === 0) o.push(cur); else cur += ch; continue; } cur += ch; } i = e + 9; } return o.join(' ').replace(/\s+/g, ' '); };
  const log = console.log; console.log = () => {}; console.warn = () => {};
  const noVal = chunks(buildAssessmentPdf(A, H.vehicle_details, 'GB', 'HV25ODX', '15/09/2026', H.bregoValuation, null));
  const withVal = chunks(buildAssessmentPdf(A, H.vehicle_details, 'GB', 'HV25ODX', '15/09/2026', { retail_low_valuation: 9000, retail_average_valuation: 9500, retail_high_valuation: 10000, trade_low_valuation: 7000, trade_average_valuation: 7500, trade_high_valuation: 8000, _mileageSource: 'copart_listed', _mileageUsed: 53544 }, null));
  console.log = log;
  ok('PDF (stored HV25ODX, no valuation): the sentence is printed under LIVE MARKET VALUATION', noVal.includes('LIVE MARKET VALUATION') && noVal.includes('No market valuation was returned for this vehicle'));
  ok('PDF with a valuation: the sentence is NOT printed (the table is)', !withVal.includes('No market valuation was returned') && /Retail/.test(withVal));
}

console.log('\nE. batch 136 task E — the final assessment save and the re-run save are checked; an unstored report is never shown');
{
  const { saveAssessedSession } = await import('../app/api/salvage/assess/route.js');
  const { startRerunUpdate } = await import('../app/api/salvage/rerun/route.js');
  // A fake Supabase client with the exact chain the two saves use: from().update().eq().select().
  const fakeDb = (result, seen = {}) => ({ from: (t) => { seen.table = t; return { update: (row) => { seen.row = row; return { eq: (k, v) => { seen.eq = [k, v]; return { select: async (cols) => { seen.select = cols; if (result instanceof Error) throw result; return result; } }; } }; } }; } });
  const row = { status: 'assessed', assessment: A, vehicle_details: H.vehicle_details };
  let seen = {};
  let r = await saveAssessedSession(fakeDb({ data: [{ id: 's1' }], error: null }, seen), 's1', row);
  ok('final save: a stored HV25ODX report → ok (table salvage_sessions, keyed by id, the full assessment written)', r.ok === true && seen.table === 'salvage_sessions' && seen.eq[0] === 'id' && seen.eq[1] === 's1' && seen.row.assessment === A && seen.select === 'id');
  r = await saveAssessedSession(fakeDb({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }), 's1', row);
  ok('final save: a database error → NOT ok, error kept for the log', r.ok === false && r.error?.code === '57014');
  r = await saveAssessedSession(fakeDb({ data: [], error: null }), 's1', row);
  ok('final save: an update that matched no row → NOT ok (not silently "saved")', r.ok === false && r.rows === 0);
  r = await saveAssessedSession(fakeDb(new Error('fetch failed')), 's1', row);
  ok('final save: a network throw → NOT ok, message kept', r.ok === false && /fetch failed/.test(r.error?.message));
  r = await startRerunUpdate(fakeDb({ data: [{ id: 's1' }], error: null }), 's1', { assessment: null, status: 'pending', rerun_count: 1, prior_assessment: A });
  ok('re-run save: stored → ok', r.ok === true);
  r = await startRerunUpdate(fakeDb({ data: null, error: { message: 'permission denied' } }), 's1', {});
  ok('re-run save: a database error → NOT ok', r.ok === false);
  r = await startRerunUpdate(fakeDb({ data: [], error: null }), 's1', {});
  ok('re-run save: no row matched → NOT ok', r.ok === false);

  // Handler wiring (source): the failure branch sits BEFORE the success response, and neither response is reachable on failure.
  const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const rt = strip(route);
  const iSave = rt.indexOf('const saved = await saveAssessedSession(supabase, salvageId, {');
  const iLoud = rt.indexOf('[ASSESSMENT SAVE FAILED]', iSave);
  const iThrow = rt.indexOf("throw new Error('Assessment failed');", iSave);
  const iReturn = rt.indexOf('return NextResponse.json({ assessment, vehicleDetails: enrichedVd,', iSave);
  ok('assess: the final save goes through the checked helper', iSave > 0);
  ok('assess: a failed save logs [ASSESSMENT SAVE FAILED] and throws before the report is returned', iLoud > iSave && iThrow > iLoud && iReturn > iThrow);
  ok('assess: no unchecked `await supabase.from(\'salvage_sessions\').update({ status: \'assessed\'` remains', !/await supabase\s*\.from\('salvage_sessions'\)\s*\.update\(\{ status: 'assessed'/.test(rt));
  const iCatch = rt.indexOf('} catch (err) {', iThrow);
  const catchBody = rt.slice(iCatch, rt.indexOf("return NextResponse.json({ error: err.message || 'Assessment failed' }, { status: 500 });", iCatch) + 90);
  ok('assess: the throw lands in the existing catch — status reset (promo → promo_redeemed, else failed) and a 500, no report', iCatch > iThrow && catchBody.includes("status: 'promo_redeemed'") && catchBody.includes("status: 'failed'") && catchBody.includes('{ status: 500 }'));
  const rerun = strip(readFileSync('app/api/salvage/rerun/route.js', 'utf8'));
  const jFail = rerun.indexOf('[RERUN SAVE FAILED]');
  const j500 = rerun.indexOf("return NextResponse.json({ error: 'Re-run failed' }, { status: 500 });");
  const jOk = rerun.indexOf('return NextResponse.json({ success: true });');
  ok('re-run: a failed save logs [RERUN SAVE FAILED] and answers 500 before { success: true }', jFail > 0 && j500 > jFail && jOk > j500);
  ok('re-run: prior_assessment is still preserved in the same write (batch 103)', rerun.includes('if (data.assessment != null) update.prior_assessment = data.assessment;') && rerun.includes('startRerunUpdate(supabase, salvage_id, update)'));
  const page = readFileSync('app/salvage/success/page.js', 'utf8');
  ok('client: a non-OK assess answer throws before any report state is set', /if \(!res\.ok\) \{\s*throw new Error\(data\?\.error \|\| `Assessment failed \(\$\{res\.status\}\)`\);\s*\}\s*setAssessment\(data\.assessment\);/.test(page));
  ok('client: a non-OK re-run answer shows the error and does not navigate to the re-run form', /throw new Error\(body\.error \|\| 'Re-run failed'\);\s*\}[\s\S]{0,400}router\.push\(`\/salvage\?rerun=/.test(page));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} hv25odx: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
