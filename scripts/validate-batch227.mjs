// batch 227 — /salvage links to /salvage/free-report from directly under the price badge, hidden while a free report is
// held or on a re-run. Source checks on the page + the string, then the earlier free-report validators still pass. £0.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch227.mjs
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } };

const { FREE_REPORT_STRINGS } = await import('../config/freeReport.mjs');
const ps = readFileSync('app/salvage/page.js', 'utf8');

console.log('── string ──');
check('freeLinkOnSalvage verbatim', FREE_REPORT_STRINGS.freeLinkOnSalvage === 'First report free — get your free link');

console.log('\n── the link on /salvage ──');
const uses = ps.match(/FREE_REPORT_STRINGS\.freeLinkOnSalvage/g) || [];
check(`rendered once (${uses.length})`, uses.length === 1);
const LINK = /\{!freeReportToken && !isRerun && \(\s*<a href="\/salvage\/free-report"[^>]*>\s*\{FREE_REPORT_STRINGS\.freeLinkOnSalvage\}\s*<\/a>\s*\)\}/;
check('targets /salvage/free-report and is gated on !freeReportToken && !isRerun', LINK.test(ps));
check('orange, like the page\'s other links', /<a href="\/salvage\/free-report" style=\{\{[^}]*color: 'var\(--orange\)'/.test(ps.slice(ps.indexOf('{!freeReportToken && !isRerun'))));
{
  const badgeEnd = ps.indexOf('<span className="price-badge-label">per assessment · no subscription</span>');
  const linkAt = ps.indexOf('{FREE_REPORT_STRINGS.freeLinkOnSalvage}');
  const between = ps.slice(badgeEnd, linkAt);
  check('directly under the price badge (only the badge\'s closing tag between them)', badgeEnd > 0 && linkAt > badgeEnd
    && /^<span className="price-badge-label">[^<]*<\/span>\s*<\/div>\s*\{!freeReportToken && !isRerun && \(\s*<a [^>]*>\s*$/.test(between));
  check('badge + link share a centred column wrapper', /<div style=\{\{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center' \}\}>\s*<div className="price-badge">/.test(ps));
}

console.log('\n── the gate, evaluated ──');
// The same expression the page uses, over every combination: shown only with no token and no re-run.
const shown = (freeReportToken, isRerun) => !!(!freeReportToken && !isRerun);
check('no token, not a re-run → shown', shown('', false) === true);
check('token held → hidden', shown('11111111-1111-4111-8111-111111111111', false) === false);
check('re-run → hidden', shown('', true) === false);
check('both → hidden', shown('t', true) === false);
check('a cleared token (batch 225 used/unknown) → shown again', shown('', false) === true);

console.log('\n── earlier validators ──');
const run = (f, loader) => spawnSync(process.execPath, [...(loader ? ['--loader', './scripts/lib/alias-loader.mjs'] : []), f], { encoding: 'utf8' }).stdout;
for (const [f, loader, want] of [['scripts/validate-batch224.mjs', true, '33'], ['scripts/validate-batch225.mjs', true, '43'], ['scripts/validate-free-report.mjs', false, '20']]) {
  const m = run(f, loader).match(/Result: (\d+) passed, (\d+) failed/);
  check(`${f.replace('scripts/', '')} ${want}/0 (got ${m?.[1]}/${m?.[2]})`, m?.[1] === want && m?.[2] === '0');
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail) process.exit(1);
