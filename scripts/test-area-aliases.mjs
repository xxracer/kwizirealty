#!/usr/bin/env node
/**
 * Smoke test for src/lib/areaAliases.ts. Verifies that known user inputs
 * resolve to the expected ZIP codes and that fuzzy matches work for the
 * variants called out in the bug report.
 *
 * Run with: `node --experimental-strip-types scripts/test-area-aliases.js`
 * (or `npm run test:aliases`).
 */

import {
  normalizeQuery,
  resolveAlias,
  resolveQueriesToZips,
  findAreaForZip,
  AREA_ALIASES,
} from '../src/lib/areaAliases.ts';

let passed = 0;
let failed = 0;
const failures = [];

function expect(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push({ label, actual, expected });
  }
}

function zipSetEqual(actualZips, expectedZips) {
  const a = [...actualZips].sort();
  const e = [...expectedZips].sort();
  return a.length === e.length && a.every((v, i) => v === e[i]);
}

// ---------- normalizeQuery ----------
console.log('# normalizeQuery');
expect('lowercase + trim', normalizeQuery('  Katy  '), 'katy');
expect('strips tx', normalizeQuery('Katy TX'), 'katy');
expect('strips comma tx', normalizeQuery('Katy, TX'), 'katy');
expect('strips the', normalizeQuery('The Woodlands'), 'woodlands');
expect('strips texas', normalizeQuery('Sugar Land Texas'), 'sugar land');

// ---------- resolveAlias (single) ----------
console.log('\n# resolveAlias (single)');

const cases = [
  { q: 'Katy', zipCount: 6, display: 'Katy' },
  { q: 'katy', zipCount: 6, display: 'Katy' },
  { q: 'Katy TX', zipCount: 6, display: 'Katy' },
  { q: 'Katy, TX', zipCount: 6, display: 'Katy' },
  { q: 'Tomball', zipCount: 2, display: 'Tomball' },
  { q: 'tomball tx', zipCount: 2, display: 'Tomball' },
  { q: 'Sugar Land', zipCount: 5, display: 'Sugar Land' },
  { q: 'sugarland', zipCount: 5, display: 'Sugar Land' },
  { q: 'The Woodlands', zipCount: 6, display: 'The Woodlands' },
  { q: 'Woodlands', zipCount: 6, display: 'The Woodlands' },
  { q: 'woodlands tx', zipCount: 6, display: 'The Woodlands' },
  { q: 'woodlands, tx', zipCount: 6, display: 'The Woodlands' },
  { q: 'Spring', zipCount: 4, display: 'Spring' },
  { q: 'Cypress', zipCount: 3, display: 'Cypress' },
  { q: 'Pearland', zipCount: 3, display: 'Pearland' },
  { q: 'Missouri City', zipCount: 2, display: 'Missouri City' },
  { q: 'Stafford', zipCount: 1, display: 'Stafford' },
  { q: 'Friendswood', zipCount: 1, display: 'Friendswood' },
  { q: 'Clear Lake', zipCount: 4, display: 'Clear Lake' },
  { q: 'League City', zipCount: 1, display: 'League City' },
  { q: 'Pasadena', zipCount: 6, display: 'Pasadena' },
  { q: 'Humble', zipCount: 3, display: 'Humble' },
  { q: 'Kingwood', zipCount: 2, display: 'Kingwood' },
  { q: 'Conroe', zipCount: 7, display: 'Conroe' },
  { q: 'Magnolia', zipCount: 2, display: 'Magnolia' },
  { q: 'Baytown', zipCount: 2, display: 'Baytown' },
  { q: 'Channelview', zipCount: 1, display: 'Channelview' },
  { q: 'Crosby', zipCount: 1, display: 'Crosby' },
  { q: 'Atascocita', zipCount: 2, display: 'Atascocita' },
  { q: 'Heights', zipCount: 3, display: 'Houston Heights' },
  { q: 'Houston Heights', zipCount: 3, display: 'Houston Heights' },
  { q: 'The Heights', zipCount: 3, display: 'Houston Heights' },
  { q: 'Midtown', zipCount: 2, display: 'Midtown' },
  { q: 'Montrose', zipCount: 3, display: 'Montrose' },
  { q: 'Bellaire', zipCount: 1, display: 'Bellaire' },
  { q: 'Westchase', zipCount: 2, display: 'Westchase' },
  { q: 'Memorial', zipCount: 2, display: 'Memorial' },
  { q: 'River Oaks', zipCount: 2, display: 'River Oaks' },
  { q: 'Tanglewood', zipCount: 1, display: 'Tanglewood' },
  { q: 'Galleria', zipCount: 2, display: 'Galleria / Uptown' },
  { q: 'Uptown', zipCount: 2, display: 'Galleria / Uptown' },
  { q: 'Energy Corridor', zipCount: 3, display: 'Energy Corridor' },
  { q: 'EaDo', zipCount: 2, display: 'EaDo' },
  { q: 'East End', zipCount: 2, display: 'EaDo' },
  { q: 'Third Ward', zipCount: 2, display: 'Third Ward' },
  { q: 'Gulfton', zipCount: 1, display: 'Gulfton' },
  { q: 'Meyerland', zipCount: 1, display: 'Meyerland' },
  { q: 'Sharpstown', zipCount: 2, display: 'Sharpstown' },
  { q: 'Greenspoint', zipCount: 3, display: 'Greenspoint' },
  { q: 'Spring Branch', zipCount: 2, display: 'Spring Branch' },
  { q: 'Alief', zipCount: 3, display: 'Alief' },
];

for (const c of cases) {
  const area = resolveAlias(c.q);
  if (!area) {
    failed++;
    failures.push({ label: `resolveAlias(${c.q})`, actual: null, expected: c.display });
    console.log(`  x ${c.q.padEnd(20)} -> null (expected ${c.display})`);
    continue;
  }
  if (area.displayName !== c.display) {
    failed++;
    failures.push({ label: `resolveAlias(${c.q}).displayName`, actual: area.displayName, expected: c.display });
    console.log(`  x ${c.q.padEnd(20)} -> ${area.displayName} (expected ${c.display})`);
    continue;
  }
  if (area.zips.length !== c.zipCount) {
    failed++;
    failures.push({ label: `resolveAlias(${c.q}).zipCount`, actual: area.zips.length, expected: c.zipCount });
    console.log(`  x ${c.q.padEnd(20)} -> ${area.zips.length} zips (expected ${c.zipCount})`);
    continue;
  }
  passed++;
  console.log(`  + ${c.q.padEnd(20)} -> ${area.displayName} (${area.zips.length} ZIPs)`);
}

// ---------- negative cases ----------
console.log('\n# negative cases');
const unknown = ['Tokyo', 'Mars', 'Fake Place TX'];
for (const q of unknown) {
  const area = resolveAlias(q);
  if (area) {
    failed++;
    failures.push({ label: `resolveAlias(${q}) should be null`, actual: area.displayName, expected: null });
    console.log(`  x ${q.padEnd(20)} -> ${area.displayName} (expected null)`);
  } else {
    passed++;
    console.log(`  + ${q.padEnd(20)} -> null`);
  }
}

// ---------- resolveQueriesToZips ----------
console.log('\n# resolveQueriesToZips (split)');
const multi = resolveQueriesToZips('Tomball, Sugar Land and Katy'.split(/[,;]\s*|\s+and\s+/i));
const expectedMultiZips = [
  '77449', '77450', '77493', '77494', '77084', '77094', // Katy
  '77375', '77377',                                     // Tomball
  '77478', '77479', '77487', '77496', '77498',         // Sugar Land
];
if (!zipSetEqual(multi.zips, expectedMultiZips)) {
  failed++;
  failures.push({ label: 'multi zips', actual: multi.zips, expected: expectedMultiZips });
  console.log('  x multi zips mismatch', multi.zips);
} else {
  passed++;
  console.log(`  + multi: ${multi.matched.map(a => a.displayName).join(', ')} -> ${multi.zips.length} ZIPs`);
}
expect('multi matched has 3 areas', multi.matched.map((a) => a.displayName).sort(), ['Katy', 'Sugar Land', 'Tomball']);

// ---------- findAreaForZip ----------
console.log('\n# findAreaForZip');
const katyZip = findAreaForZip('77494');
expect('77494 -> Katy', katyZip ? katyZip.displayName : null, 'Katy');
const unknownZip = findAreaForZip('99999');
expect('unknown zip returns null', unknownZip, null);

// ---------- summary ----------
console.log(`\n${AREA_ALIASES.length} areas in map`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.label}`);
    console.log(`    actual:   ${JSON.stringify(f.actual)}`);
    console.log(`    expected: ${JSON.stringify(f.expected)}`);
  }
  process.exit(1);
}
console.log('\nAll tests passed.');