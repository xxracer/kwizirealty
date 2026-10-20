import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolyIndex, assignPoly, indexPolygonCount } from './polyMatch';
import { cleanBoundaryName, cleanSchoolName, expandBoundaryName } from './engineCore';

function square(lng0: number, lat0: number, lng1: number, lat1: number, name: string): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: { Name: name },
    geometry: {
      type: 'Polygon',
      coordinates: [[[lng0, lat0], [lng1, lat0], [lng1, lat1], [lng0, lat1], [lng0, lat0]]],
    },
  } as GeoJSON.Feature;
}

test('point inside a polygon returns its cleaned name', () => {
  const idx = buildPolyIndex([square(-95.6, 29.7, -95.5, 29.8, 'West Memorial')]);
  assert.equal(assignPoly(29.75, -95.55, idx), cleanBoundaryName('West Memorial'));
});

test('point outside all polygons returns empty string', () => {
  const idx = buildPolyIndex([square(-95.6, 29.7, -95.5, 29.8, 'West Memorial')]);
  assert.equal(assignPoly(29.0, -95.55, idx), '');
});

test('nested polygons assign the smallest', () => {
  const idx = buildPolyIndex([
    square(-96.0, 29.5, -95.0, 30.2, 'Big'),
    square(-95.7, 29.7, -95.6, 29.8, 'Inner'),
  ]);
  assert.equal(assignPoly(29.75, -95.65, idx), cleanBoundaryName('Inner'));
  // Still lands on Big when only inside the outer ring.
  assert.equal(assignPoly(29.6, -95.65, idx), cleanBoundaryName('Big'));
});

test('duplicate-named polygons share one key', () => {
  const idx = buildPolyIndex([
    square(-95.9, 29.7, -95.8, 29.8, 'Riverside Park'),
    square(-95.3, 29.7, -95.2, 29.8, 'Riverside Park'),
  ]);
  const west = assignPoly(29.75, -95.85, idx);
  const east = assignPoly(29.75, -95.25, idx);
  assert.equal(west, east);
  assert.equal(indexPolygonCount(idx), 2);
});

test('indexes stay isolated per class', () => {
  const zips = buildPolyIndex([square(-95.6, 29.7, -95.5, 29.8, '77024')]);
  const subs = buildPolyIndex([square(-95.6, 29.7, -95.5, 29.8, 'W MEMORIAL')]);
  assert.equal(assignPoly(29.75, -95.55, zips), '77024');
  assert.equal(assignPoly(29.75, -95.55, subs), 'W MEMORIAL');
});

test('NAME-only GeoJSON resolves via nameProps (highschools style)', () => {
  // Houston_ISD features carry only `NAME` — the map reads props['NAME'].
  const feature = square(-95.6, 29.7, -95.5, 29.8, 'Pearland ISD'); // Name key
  const named = { ...feature, properties: { NAME: 'Pearland ISD' } } as GeoJSON.Feature;
  const idx = buildPolyIndex([named], { nameProps: ['NAME'] });
  assert.equal(assignPoly(29.75, -95.55, idx), cleanBoundaryName('Pearland ISD'));
});

test('empty-named features fall back like the map (generic name then Area N)', () => {
  const feature: GeoJSON.Feature = {
    type: 'Feature',
    properties: {},
    geometry: square(-95.6, 29.7, -95.5, 29.8, '').geometry,
  };
  const idx = buildPolyIndex([feature], { nameProps: ['NAME'] });
  // Synthetic 'Area 1' key keeps the polygon assignable and countable.
  assert.equal(assignPoly(29.75, -95.55, idx), cleanBoundaryName('Area 1'));
});

test('school classes clean with cleanSchoolName', () => {
  const idx = buildPolyIndex([square(-95.6, 29.7, -95.5, 29.8, 'Rogers Middle School')], {
    nameProps: ['Name', 'NAME'],
    clean: cleanSchoolName,
  });
  assert.equal(assignPoly(29.75, -95.55, idx), cleanSchoolName('Rogers Middle School'));
});
// ── expandBoundaryName (display-only full names; owner 2026-10-19) ─────────

test('direction letters expand back to full words on display', () => {
  assert.equal(expandBoundaryName('W MEMORIAL'), 'WEST MEMORIAL');
  assert.equal(expandBoundaryName('N HOUSTON'), 'NORTH HOUSTON');
  assert.equal(expandBoundaryName('E 43RD'), 'EAST 43RD');
});

test('compound directions and acronyms expand', () => {
  assert.equal(expandBoundaryName('NW 07 R/P'), 'NORTHWEST 07 R/P');
  assert.equal(expandBoundaryName('MEMORIAL HTS'), 'MEMORIAL HEIGHTS');
  assert.equal(expandBoundaryName('PINE MDW'), 'PINE MEADOWS');
  assert.equal(expandBoundaryName('OAK GRV'), 'OAK GROVE');
});

test('matching-only tokens stay intact where the owner kept them (SEC, R/P)', () => {
  assert.equal(expandBoundaryName('W MEMORIAL SEC 01 R/P'), 'WEST MEMORIAL SEC 01 R/P');
  assert.equal(expandBoundaryName('ESTATES @ MONTROSE'), 'ESTATES AT MONTROSE');
});
