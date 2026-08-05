// Unit tests for lib/partsSourcing.mjs — deterministic, no network.
// Run: node scripts/validate-parts-sourcing.mjs
import { buildPartsSourcing, PARTS_SOURCING_DISCLOSURE } from '../lib/partsSourcing.mjs';

let passed = 0, failed = 0;
function eq(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); console.error(`        expected: ${JSON.stringify(expected)}`); console.error(`        got:      ${JSON.stringify(got)}`); failed++; }
}
function ok(label, cond) { eq(label, !!cond, true); }

const vehicle = { make: 'BMW', model: '320d', year: 2018 };
const EPN = { campaignId: '5338888888', customId: 'salvage' };

// A representative reconciled basket (gatedParts shape): name, action, used/oem cost.
const basket = [
  { name: 'Front bumper',      action: 'replace', used: 120, oem: 300, panelId: 'FRONT_BUMPER' },
  { name: 'Bonnet',            action: 'replace', used: 180, oem: 450, panelId: 'BONNET' },
  { name: 'Labour & paint',    action: 'replace', used: 600, oem: 600 },              // service — must be skipped
  { name: 'Prep and blend',    action: 'repair',  used: 90,  oem: 90 },               // service — must be skipped
  { name: 'Headlamp',          action: 'replace', used: 350, oem: 350, panelId: 'HEADLAMP' },
  { name: 'Front bumper',      action: 'replace', used: 120, oem: 300 },              // duplicate name → deduped
];

console.log('\n=== Structure & disclosure ===\n');
const r = buildPartsSourcing({ parts: basket, vehicle, epn: EPN });
eq('disclosure present + exact', r.disclosure, PARTS_SOURCING_DISCLOSURE);
ok('disclosure mentions commission', /commission/i.test(r.disclosure));
ok('disclosure states independence', /independent/i.test(r.disclosure));

console.log('\n=== Filtering: labour/paint/prep skipped, dedup ===\n');
eq('link count (6 rows → 3 unique shoppable)', r.links.length, 3);
ok('no labour/paint/prep in links', !r.links.some(l => /labour|paint|prep/i.test(l.part)));
eq('Front bumper appears once', r.links.filter(l => l.part === 'Front bumper').length, 1);

console.log('\n=== Single feed: eBay UK only (Amazon NOT wired) ===\n');
ok('every link feed = ebay', r.links.every(l => l.feed === 'ebay'));
ok('every url is ebay.co.uk', r.links.every(l => l.url.startsWith('https://www.ebay.co.uk/sch/i.html')));
ok('no amazon urls anywhere', !r.links.some(l => /amazon/i.test(l.url)));
ok('feedLabel is eBay used/breakers', r.links.every(l => /eBay UK/.test(l.feedLabel)));

console.log('\n=== Cost carried (used ?? oem), never mutated ===\n');
const byPart = Object.fromEntries(r.links.map(l => [l.part, l]));
eq('Front bumper cost = used', byPart['Front bumper'].cost, 120);
eq('Bonnet cost = used',       byPart['Bonnet'].cost, 180);

console.log('\n=== URL: vehicle + part in query, correct category ===\n');
ok('ebay parts category 6030', byPart['Bonnet'].url.includes('_sacat=6030'));
ok('ebay query has vehicle+part', byPart['Bonnet'].url.includes(encodeURIComponent('BMW 320d 2018 Bonnet')));

console.log('\n=== EPN params applied ONLY when campaign ID present ===\n');
ok('campid present when configured', byPart['Bonnet'].url.includes('campid=5338888888'));
ok('mkcid=1 (affiliate)', byPart['Bonnet'].url.includes('mkcid=1'));
ok('siteid=3 (UK)', byPart['Bonnet'].url.includes('siteid=3'));
ok('customid passed through', byPart['Bonnet'].url.includes('customid=salvage'));
ok('tracked flag true', byPart['Bonnet'].tracked === true);

console.log('\n=== Honest fallback: NO campaign ID → plain search, tracked=false ===\n');
const rNo = buildPartsSourcing({ parts: basket, vehicle, epn: null });
const noBy = Object.fromEntries(rNo.links.map(l => [l.part, l]));
ok('NO campid without ID', !noBy['Bonnet'].url.includes('campid='));
ok('NO mkcid without ID', !noBy['Bonnet'].url.includes('mkcid='));
ok('still a valid ebay search', noBy['Bonnet'].url.startsWith('https://www.ebay.co.uk/sch/i.html') && noBy['Bonnet'].url.includes('_nkw='));
ok('tracked=false without ID', noBy['Bonnet'].tracked === false);
ok('links still present without ID', rNo.links.length === 3);

console.log('\n=== Empty-string campaign ID behaves as unset (no broken campid) ===\n');
const rEmpty = buildPartsSourcing({ parts: basket, vehicle, epn: { campaignId: '', customId: '' } });
ok('empty campaignId → no campid= param', !rEmpty.links[0].url.includes('campid='));
ok('empty campaignId → tracked false', rEmpty.links[0].tracked === false);

console.log('\n=== customId optional: campid without customId ===\n');
const rNoCustom = buildPartsSourcing({ parts: basket, vehicle, epn: { campaignId: '999' } });
ok('campid present', rNoCustom.links[0].url.includes('campid=999'));
ok('no customid param when unset', !rNoCustom.links[0].url.includes('customid='));

console.log('\n=== Long DVLA model trimmed to family (first 2 tokens) ===\n');
const rLong = buildPartsSourcing({ parts: [{ name: 'Front bumper', used: 300 }], vehicle: { make: 'MERCEDES-BENZ', model: 'A 180 AMG LNE EXECUTIVE MHEV A', year: 2025 }, epn: EPN });
ok('query keeps make + A 180 + year + part', rLong.links[0].url.includes(encodeURIComponent('MERCEDES-BENZ A 180 2025 Front bumper')));
ok('query drops trailing spec noise (no EXECUTIVE)', !/EXECUTIVE/i.test(decodeURIComponent(rLong.links[0].url)));
ok('two-token model preserved whole (SANTA FE)', buildPartsSourcing({ parts: [{ name: 'Bonnet', used: 180 }], vehicle: { make: 'HYUNDAI', model: 'SANTA FE', year: 2017 }, epn: EPN }).links[0].url.includes(encodeURIComponent('HYUNDAI SANTA FE 2017 Bonnet')));

console.log('\n=== Degradation & guards ===\n');
eq('empty parts → empty links, disclosure intact', buildPartsSourcing({ parts: [], vehicle, epn: EPN }), { disclosure: PARTS_SOURCING_DISCLOSURE, links: [] });
eq('undefined input → empty links', buildPartsSourcing({}).links, []);
eq('null-safe on missing name rows', buildPartsSourcing({ parts: [{ used: 10 }, { name: '', used: 5 }], epn: EPN }).links, []);
const rNoVeh = buildPartsSourcing({ parts: [{ name: 'Bonnet', used: 180 }], epn: EPN });
ok('no vehicle → part-only query', rNoVeh.links[0].url.includes(encodeURIComponent('Bonnet')) && !rNoVeh.links[0].url.includes('undefined'));
eq('zero/negative cost → null (not 0)', buildPartsSourcing({ parts: [{ name: 'Trim clip', used: 0, oem: 0 }], epn: EPN }).links[0].cost, null);

console.log(`\n${failed === 0 ? '✅' : '❌'} parts-sourcing: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
