// MotorCheck Trade (IE) client — TASK-0 probe scaffolding only (batch 49/50).
//
// ⚠️ We have seen the RENDERED report, never the JSON. Build from the RESPONSE, not the docs — so this
// file's ONLY job for TASK-0 is to make one funded `full` call on 231T1905 and surface the raw JSON to
// the Vercel runtime logs (standing rule 1: raw substrate, never a rendered report). No parser, no
// payload mapping, no render is written until that JSON has been read and reported.
//
// Contract (batch 49 §2, read from the account's Postman docs):
//   Base  https://trade.motorcheck.ie   Auth OAuth2 client_credentials → bearer
//   POST /api/v1/oauth/token            { grant_type, client_id, client_secret, scope }
//   POST /api/v1/provenance-report/create  { vrm, reportType, currentOdometer?, currentOdometerUnit?, vin? } → 201
//   POST Provenance Report Show / Show JSON  (retrieve a created report; exact path confirmed from the create response)
//   Country is DERIVED from the reg format — one endpoint serves both markets (reportCountry is a RESPONSE field).
//
// ⚠️ Credentials are the SUFFIXED IE pair — MOTORCHECK_IE_CLIENT_ID / MOTORCHECK_IE_CLIENT_SECRET
// (batch 50: two MotorCheck systems, .ie and .co.uk; an unsuffixed name is standing rule 5). Vercel-only
// (Production + Preview) — there is NO local testing, this runs on a PREVIEW deploy.
//
// ⚠️ THE KILOMETRES TRAP (batch 49 §3): "if currentOdometer is sent and currentOdometerUnit is NOT
// specified, the value is interpreted as Kilometres." A UK car's miles sent without the unit is read as
// km — a 1.6× understatement that inflates the valuation. TASK-0 sends NO odometer (no ambiguity); any
// future build that sends one MUST send currentOdometerUnit explicitly and assert it in the validator.
//
// ⚠️ 417 = RETRY (batch 49 §5.3): the report can answer "Report is generating" for up to ~30s. Treat
// 417 as retry, never as failure or empty (the same shape that broke service history).

const MOTORCHECK_IE_BASE = process.env.MOTORCHECK_IE_BASE || 'https://trade.motorcheck.ie';
// Request only what a full provenance report needs; all nine scopes are already granted to the credential
// (batch 49 §2.9), so there is nothing to request — this is just the subset the token is asked to carry.
const IE_SCOPE = 'report-create report-json report-show';

let tokenCache = { token: null, expiresAt: 0 };

export async function getMotorcheckIeToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const id = process.env.MOTORCHECK_IE_CLIENT_ID;
  const secret = process.env.MOTORCHECK_IE_CLIENT_SECRET;
  if (!id || !secret) throw new Error('MOTORCHECK_IE_CLIENT_ID/SECRET not set (Vercel Preview/Production only)');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: IE_SCOPE });
  const res = await fetch(`${MOTORCHECK_IE_BASE}/api/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MotorCheck IE token ${res.status}: ${text.slice(0, 200)}`);
  let data; try { data = JSON.parse(text); } catch { throw new Error(`MotorCheck IE token: non-JSON body: ${text.slice(0, 200)}`); }
  const ttl = Number(data.expires_in) || 1800;
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 };
  return tokenCache.token;
}

async function mcPost(path, token, body) {
  const res = await fetch(`${MOTORCHECK_IE_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  return { status: res.status, ok: res.ok, json, text };
}

// Create a report. reportType: 'full' | 'history' | 'finance' | 'valuation'. Returns the raw create
// response verbatim — TASK-0 logs it whole to find the reference and read the shape.
export async function createProvenanceReport(token, { vrm, reportType = 'full' }) {
  return mcPost('/api/v1/provenance-report/create', token, { vrm, reportType });
}

// Retrieve a created report's JSON. The exact path is confirmed from the create response for TASK-0, so
// this attempts the naming-convention candidates and returns whichever answers (logging every attempt).
// 417 "still generating" is retried by the caller, not treated as an answer.
export async function showProvenanceReportJson(token, { vrm, reference }) {
  const bodies = [];
  if (reference != null) bodies.push({ id: reference }, { reference }, { reportId: reference });
  bodies.push({ vrm });
  const paths = ['/api/v1/provenance-report/show-json', '/api/v1/provenance-report/json', '/api/v1/provenance-report/show'];
  const attempts = [];
  for (const path of paths) {
    for (const body of bodies) {
      const r = await mcPost(path, token, body);
      attempts.push({ path, body: Object.keys(body).join(','), status: r.status });
      if (r.ok && r.json) return { ...r, path, body, attempts };
      if (r.status === 417) return { ...r, path, body, attempts, generating: true };
    }
  }
  return { status: attempts.at(-1)?.status ?? 0, ok: false, json: null, attempts };
}

export { MOTORCHECK_IE_BASE };
