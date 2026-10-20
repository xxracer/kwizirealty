import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolyIndex, assignPoly, indexPolygonCount } from './polyMatch';
import { cleanBoundaryName } from './engineCore';

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