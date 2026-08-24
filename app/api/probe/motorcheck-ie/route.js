import { NextResponse } from 'next/server';
import { getMotorcheckIeToken, createProvenanceReport, showProvenanceReportJson } from '@/lib/motorcheckIe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// TASK-0 probe (batch 49/50) — ONE funded MotorCheck IE `full` call on 231T1905, raw JSON to the Vercel
// runtime logs. NOT a product surface. Deliberately fragile-safe:
//   • refuses on PRODUCTION (VERCEL_ENV === 'production') — a funded call must never fire on prod;
//   • requires ?confirm=fire so a crawler / accidental hit on the SSO-gated preview cannot spend €9.84;
//   • one create only; the created report persists, so re-fetching its JSON later costs nothing.
// It returns a TINY ack to the browser — the RAW substrate goes to the LOGS (standing rule 1: read the
// raw response from `vercel logs`, never a rendered report). Delete this route once the JSON is read.

const TEST_VRM = '231T1905'; // known-good ROI reg — tests the Irish Full Check (batch 48/49)

// Walk the report and collect every object carrying a `flag`, with its sibling `message` — batch 49 §5.1:
// `flag: true` means "issue" OR "not checked" (three states), so the discriminator is `message`, not
// `flag`. TASK-0 must SEE every flag/message pair before any mapping is written.
function collectFlags(node, path = '$', out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((v, i) => collectFlags(v, `${path}[${i}]`, out)); return out; }
  if ('flag' in node) out.push({ path, flag: node.flag, message: node.message ?? node.msg ?? null });
  for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') collectFlags(v, `${path}.${k}`, out);
  return out;
}

// Finance is NOT top-level (batch 56 correction). It lives in two places, split BY JURISDICTION:
//   data.issues.finance = { ie:{flag,message}, uk:{flag,message}, rechecked, lastChecked }
//   data.report.finance = the full section ({ financeOutstanding, items:[…] })
// The docs' "split vs flat" question has a third answer: split by jurisdiction (ie/uk), not by
// provider system. Report both locations so the shape check cannot say "absent" when it is present.
function describeFinance(report) {
  const iss = report?.issues?.finance;
  const rep = report?.report?.finance;
  if (iss == null && rep == null) return 'absent';
  const jur = (iss && typeof iss === 'object') ? Object.keys(iss).filter(k => k === 'ie' || k === 'uk') : [];
  const parts = [];
  if (iss != null) parts.push(jur.length ? `issues.finance SPLIT BY JURISDICTION (${jur.join(', ')})` : 'issues.finance present');
  if (rep != null) parts.push(`report.finance section (${typeof rep === 'object' ? Object.keys(rep).join('/') : typeof rep})`);
  return parts.join(' + ');
}

export async function GET(request) {
  if (process.env.VERCEL_ENV === 'production') {
    return NextResponse.json({ error: 'probe disabled on production' }, { status: 403 });
  }
  if (request.nextUrl.searchParams.get('confirm') !== 'fire') {
    return NextResponse.json({ error: 'add ?confirm=fire to fire ONE funded (~€9.84) MotorCheck IE full call on ' + TEST_VRM }, { status: 400 });
  }
  const tag = '[MOTORCHECK-IE-PROBE]';
  try {
    const token = await getMotorcheckIeToken();
    console.log(`${tag} token acquired (len ${token?.length ?? 0})`);

    const created = await createProvenanceReport(token, { vrm: TEST_VRM, reportType: 'full' });
    console.log(`${tag} CREATE status=${created.status} ok=${created.ok}`);
    console.log(`${tag} CREATE RAW: ${JSON.stringify(created.json ?? created.text)}`);

    // A reference to fetch the JSON by — try the common shapes without assuming which.
    const c = created.json || {};
    const reference = c.id ?? c.reportId ?? c.reference ?? c.report_id ?? c.data?.id ?? c.data?.reference ?? null;
    console.log(`${tag} reference candidate: ${JSON.stringify(reference)}`);

    // Fetch the JSON, retrying 417 "still generating" for up to ~30s (batch 49 §5.3).
    let shown = null;
    for (let i = 0; i < 8; i++) {
      shown = await showProvenanceReportJson(token, { vrm: TEST_VRM, reference });
      console.log(`${tag} SHOW-JSON attempt ${i} status=${shown.status} path=${shown.path ?? '-'} attempts=${JSON.stringify(shown.attempts)}`);
      if (shown.ok || !shown.generating) break;
      await new Promise(r => setTimeout(r, 4000));
    }

    const report = (shown?.ok && shown.json) ? (shown.json.data ?? shown.json.report ?? shown.json) : null;
    if (report && typeof report === 'object') {
      console.log(`${tag} SHOW-JSON RAW: ${JSON.stringify(shown.json)}`);
      console.log(`${tag} TOP-LEVEL KEYS: ${Object.keys(report).join(', ')}`);
      console.log(`${tag} FINANCE SHAPE: ${describeFinance(report)}`);
      console.log(`${tag} FLAGS: ${JSON.stringify(collectFlags(report))}`);
    } else {
      console.log(`${tag} SHOW-JSON did not return a usable report — see CREATE RAW above (it may carry the report inline).`);
      console.log(`${tag} SHOW-JSON RAW: ${JSON.stringify(shown?.json ?? shown?.text ?? null)}`);
    }

    return NextResponse.json({
      ok: true,
      note: 'raw JSON is in the Vercel runtime logs — grep [MOTORCHECK-IE-PROBE]',
      createStatus: created.status,
      showJsonStatus: shown?.status ?? null,
      topLevelKeys: report ? Object.keys(report) : null,
      financeShape: report ? describeFinance(report) : null,
    });
  } catch (err) {
    console.error(`${tag} FAILED: ${err?.message || err}`);
    return NextResponse.json({ error: 'probe failed', detail: String(err?.message || err) }, { status: 500 });
  }
}
