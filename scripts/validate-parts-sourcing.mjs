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
const AFF = { epnCampaignId: '5338888888', epnRotationId: '711-53200-19255-0', amazonTag: 'motorquoter-21' };

// A representative reconciled basket (gatedParts shape): name, action, used/oem cost.
const basket = [
  { name: 'Front bumper',      action: 'replace', used: 120, oem: 300, panelId: 'FRONT_BUMPER' },
  { name: 'Bonnet',            action: 'replace', used: 180, oem: 450, panelId: 'BONNET' },
  { name: 'Labour & paint',    action: 'replace', used: 600, oem: 600 },              // service — must be skipped
  { name: 'Prep and blend',    action: 'repair',  used: 90,  oem: 90 },               // service — must be skipped
  { name: 'Battery',           action: 'replace', used: 95,  oem: 95 },               // consumable → Amazon
  { name: 'Headlamp bulb',     action: 'replace', used: 20,  oem: 40 },               // consumable → Amazon
  { name: 'Front bumper',      action: 'replace', used: 120, oem: 300 },              // duplicate name → deduped
];

console.log('\n=== Structure & disclosure ===\n');
const r = buildPartsSourcing({ parts: basket, vehicle, affiliate: AFF });
eq('disclosure present + exact', r.disclosure, PARTS_SOURCING_DISCLOSURE);
ok('disclosure mentions commission', /commission/i.test(r.disclosure));

console.log('\n=== Filtering: labour/paint/prep skipped, dedup ===\n');
eq('link count (7 rows → 4 unique shoppable)', r.links.length, 4);
ok('no labour/paint/prep in links', !r.links.some(l => /labour|paint|prep/i.test(l.part)));
eq('Front bumper appears once', r.links.filter(l => l.part === 'Front bumper').length, 1);

console.log('\n=== Feed routing (eBay used vs Amazon new) ===\n');
const byPart = Object.fromEntries(r.links.map(l => [l.part, l]));
eq('Front bumper → ebay', byPart['Front bumper'].feed, 'ebay');
eq('Bonnet → ebay',       byPart['Bonnet'].feed, 'ebay');
eq('Battery → amazon',    byPart['Battery'].feed, 'amazon');
eq('Headlamp bulb → amazon (bulb consumable)', byPart['Headlamp bulb'].feed, 'amazon');

console.log('\n=== Cost carried (used ?? oem), never mutated ===\n');
eq('Front bumper cost = used', byPart['Front bumper'].cost, 120);
eq('Bonnet cost = used',       byPart['Bonnet'].cost, 180);

console.log('\n=== URL: vehicle + part in query, correct host, category ===\n');
ok('ebay host', byPart['Bonnet'].url.startsWith('https://www.ebay.co.uk/sch/i.html'));
ok('ebay parts category 6030', byPart['Bonnet'].url.includes('_sacat=6030'));
ok('ebay query has vehicle+part', byPart['Bonnet'].url.includes(encodeURIComponent('BMW 320d 2018 Bonnet')));
ok('amazon host', byPart['Battery'].url.startsWith('https://www.amazon.co.uk/s?k='));
ok('amazon query has vehicle+part', byPart['Battery'].url.includes(encodeURIComponent('BMW 320d 2018 Battery')));

console.log('\n=== Affiliate applied ONLY when config present ===\n');
ok('ebay carries campid when configured', byPart['Bonnet'].url.includes('campid=5338888888'));
ok('ebay carries rotation (mkrid)', byPart['Bonnet'].url.includes(`mkrid=${encodeURIComponent('711-53200-19255-0')}`));
ok('ebay siteid 3 (UK)', byPart['Bonnet'].url.includes('siteid=3'));
ok('amazon carries tag when configured', byPart['Battery'].url.includes('tag=motorquoter-21'));
ok('ebay tracked flag true', byPart['Bonnet'].tracked === true);
ok('amazon tracked flag true', byPart['Battery'].tracked === true);

console.log('\n=== Honest fallback: NO affiliate config → plain search, tracked=false ===\n');
const rNo = buildPartsSourcing({ parts: basket, vehicle, affiliate: null });
const noBy = Object.fromEntries(rNo.links.map(l => [l.part, l]));
ok('ebay has NO campid without config', !noBy['Bonnet'].url.includes('campid='));
ok('amazon has NO tag without config', !noBy['Battery'].url.includes('tag='));
ok('ebay tracked=false without config', noBy['Bonnet'].tracked === false);
ok('amazon tracked=false without config', noBy['Battery'].tracked === false);
ok('links still present without config', rNo.links.length === 4);

console.log('\n=== Partial config: eBay IDs but no Amazon tag ===\n');
const rPartial = buildPartsSourcing({ parts: basket, vehicle, affiliate: { epnCampaignId: 'X', epnRotationId: 'Y', amazonTag: null } });
const pBy = Object.fromEntries(rPartial.links.map(l => [l.part, l]));
ok('ebay tracked with eBay IDs', pBy['Bonnet'].tracked === true);
ok('amazon NOT tracked (no tag)', pBy['Battery'].tracked === false);

console.log('\n=== Long DVLA model trimmed to family (first 2 tokens) ===\n');
const rLong = buildPartsSourcing({ parts: [{ name: 'Front bumper', used: 300 }], vehicle: { make: 'MERCEDES-BENZ', model: 'A 180 AMG LNE EXECUTIVE MHEV A', year: 2025 }, affiliate: AFF });
ok('query keeps make + A 180 + year + part', rLong.links[0].url.includes(encodeURIComponent('MERCEDES-BENZ A 180 2025 Front bumper')));
ok('query drops trailing spec noise (no EXECUTIVE)', !/EXECUTIVE/i.test(decodeURIComponent(rLong.links[0].url)));
ok('two-token model preserved whole (SANTA FE)', buildPartsSourcing({ parts: [{ name: 'Bonnet', used: 180 }], vehicle: { make: 'HYUNDAI', model: 'SANTA FE', year: 2017 }, affiliate: AFF }).links[0].url.includes(encodeURIComponent('HYUNDAI SANTA FE 2017 Bonnet')));

console.log('\n=== Degradation & guards ===\n');
eq('empty parts → empty links, disclosure intact', buildPartsSourcing({ parts: [], vehicle, affiliate: AFF }), { disclosure: PARTS_SOURCING_DISCLOSURE, links: [] });
eq('undefined input → empty links', buildPartsSourcing({}).links, []);
eq('null-safe on missing name rows', buildPartsSourcing({ parts: [{ used: 10 }, { name: '', used: 5 }], affiliate: AFF }).links, []);
const rNoVeh = buildPartsSourcing({ parts: [{ name: 'Bonnet', used: 180 }], affiliate: AFF });
ok('no vehicle → part-only query', rNoVeh.links[0].url.includes(encodeURIComponent('Bonnet')) && !rNoVeh.links[0].url.includes('undefined'));
eq('zero/negative cost → null (not 0)', buildPartsSourcing({ parts: [{ name: 'Trim clip', used: 0, oem: 0 }], affiliate: AFF }).links[0].cost, null);

console.log(`\n${failed === 0 ? '✅' : '❌'} parts-sourcing: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
