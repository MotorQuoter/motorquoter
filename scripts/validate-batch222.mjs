// Validator — batch 222: the frame-zone and photo-odometer Haiku calls alert on failure; the odometer reads the
// TEXT block. £0: global fetch is stubbed — no Anthropic, Brevo or Supabase call leaves the process.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch222.mjs   (expect "N passed, 0 failed")
// The two 529-exhausted cases sit through the real with529Retry backoff (~7-10s each).

// sendOpsAlert's throttle store needs Supabase; with no URL its createClient throws, it logs "sending anyway" and sends.
// So every alert reaches the (stubbed) Brevo endpoint and can be counted. Brevo config is stubbed so it does not bail.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
process.env.BREVO_API_KEY = 'stub-key';
process.env.ALERT_EMAIL = 'stub@example.invalid';

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }

const subjects = [];      // one entry per Brevo send = one sendOpsAlert that reached the mailer
let anthropic = null;     // the current scenario: () => Response | throws
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.brevo.com/')) { subjects.push(JSON.parse(init.body).subject); return new Response('{}', { status: 201 }); }
  if (u.startsWith('https://api.anthropic.com/')) return anthropic();
  throw new Error(`validate-batch222: unexpected network call ${u}`);
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reply = (content, stop_reason = 'end_turn') => () => json(200, { model: 'claude-haiku-4-5-20251001', content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } });

const { runFrameZoneId, readPhotoOdometer } = await import('@/app/api/salvage/assess/route.js');
const IMAGES = ['data:image/jpeg;base64,AAAA'];   // undecodable on purpose: resizeToHaikuSafe passes it through unchanged

const FZ = 'MotorQuoter: frame-zone (Haiku) call failing';
const ODO = 'MotorQuoter: photo-odometer (Haiku) call failing';
const failures = {
  'HTTP 500': () => json(500, { type: 'error', error: { type: 'api_error', message: 'stub 500' } }),
  'HTTP 404 (retired model)': () => json(404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-haiku-4-5' } }),
  '529 exhausted': () => json(529, { type: 'error', error: { type: 'overloaded_error', message: 'stub 529' } }),
  'fetch throws (network)': () => { throw new Error('stub network down'); },
};

async function drive(label, scenario, fn) {
  anthropic = scenario;
  const before = subjects.length;
  const out = await fn();
  return { out, alerts: subjects.slice(before) };
}

console.log('\n§1. frame zone — one alert per failure path, failed state unchanged');
const fzFailures = {
  ...failures,
  'stop_reason max_tokens': reply([{ type: 'text', text: '{"frames":[' }], 'max_tokens'),
  'stop_reason refusal': reply([{ type: 'text', text: '' }], 'refusal'),
  'no JSON object': reply([{ type: 'text', text: 'no json here' }]),
  'no frames array': reply([{ type: 'text', text: '{"x":1}' }]),
  'malformed JSON (throws in parse)': reply([{ type: 'text', text: '{ "frames": [ bad ] }' }]),
};
for (const [label, scenario] of Object.entries(fzFailures)) {
  let exhausted = 0;
  const { out, alerts } = await drive(label, scenario, () => runFrameZoneId(IMAGES, () => { exhausted++; }));
  ok(`frame zone · ${label}: exactly one alert, subject "${FZ}"`, alerts.length === 1 && alerts[0] === FZ);
  ok(`frame zone · ${label}: still returns the failed state { ok:false, frames:[] }`, out && out.ok === false && Array.isArray(out.frames) && out.frames.length === 0);
  if (label === '529 exhausted') ok('frame zone · 529 exhausted: onExhaust still called once', exhausted === 1);
}
{
  const { out, alerts } = await drive('success', reply([{ type: 'text', text: '{"frames":[{"i":0,"zones":["front"],"windscreenLabel":false}]}' }]), () => runFrameZoneId(IMAGES));
  ok('frame zone · success reply: NO alert', alerts.length === 0);
  ok('frame zone · success reply: ok:true, frame 0 = ["front"]', out.ok === true && out.frames.length === 1 && out.frames[0].zones[0] === 'front');
}

console.log('\n§2. photo odometer — one alert per failure path, photoOdometer stays null');
const odoFailures = {
  ...failures,
  'thrown error (unreadable reply body)': () => new Response('not json', { status: 200 }),
};
for (const [label, scenario] of Object.entries(odoFailures)) {
  const vd = {};
  const { out, alerts } = await drive(label, scenario, () => readPhotoOdometer(IMAGES, vd));
  ok(`odometer · ${label}: exactly one alert, subject "${ODO}"`, alerts.length === 1 && alerts[0] === ODO);
  ok(`odometer · ${label}: photoOdometer null, raw null`, out.photoOdometer === null && out.raw === null);
}

console.log('\n§3. photo odometer — reads the TEXT block; success never alerts');
const oldRead = (data) => (data.content?.[0]?.text || '').trim();   // the pre-batch-222 read, for the like-for-like check
{
  const content = [{ type: 'text', text: '21448' }];
  const { out, alerts } = await drive('text only', reply(content), () => readPhotoOdometer(IMAGES, {}));
  ok('odometer · text-only reply "21448": photoOdometer 21448, raw "21448"', out.photoOdometer === 21448 && out.raw === '21448');
  ok('odometer · text-only reply: same raw as the old content[0].text read', out.raw === oldRead({ content }));
  ok('odometer · text-only reply: NO alert', alerts.length === 0);
}
{
  const content = [{ type: 'thinking', thinking: 'The cluster shows 21,448 miles.', signature: 'stub' }, { type: 'text', text: '21448' }];
  const { out, alerts } = await drive('thinking first', reply(content), () => readPhotoOdometer(IMAGES, {}));
  ok('odometer · thinking block FIRST, text second: photoOdometer 21448', out.photoOdometer === 21448 && out.raw === '21448');
  ok('odometer · the old content[0].text read would have given "" on that reply (the defect)', oldRead({ content }) === '');
  ok('odometer · thinking-first reply: NO alert', alerts.length === 0);
}
{
  const { out, alerts } = await drive('null', reply([{ type: 'text', text: 'null' }]), () => readPhotoOdometer(IMAGES, {}));
  ok('odometer · "null" (no odometer visible) is a success: photoOdometer null, raw "null", NO alert', out.photoOdometer === null && out.raw === 'null' && alerts.length === 0);
}
{
  const vd = { copartListedMileage: '50000' };
  const { out, alerts } = await drive('divergence', reply([{ type: 'text', text: '12345 67890' }]), () => readPhotoOdometer(IMAGES, vd));
  ok('odometer · multi-number, none ≈ listing: divergence flag set on enrichedVd, photoOdometer null, NO alert (unchanged behaviour)',
    out.photoOdometer === null && typeof vd.photoMileageFlag === 'string' && /12,345 \/ 67,890/.test(vd.photoMileageFlag) && alerts.length === 0);
}

globalThis.fetch = realFetch;
console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
