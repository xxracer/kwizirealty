# Per-polygon geographic assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every polygon of every boundary class that has a GeoJSON file (subdivisions, neighborhoods, zipcodes, highschools, elementary, middle) aggregate exactly the CSV rows whose lat/lng falls inside it — instead of matching the polygon name against row text columns.

**Architecture:** Five new Postgres columns (`poly_id_subdivisions`, `poly_id_zipcodes`, `poly_id_highschools`, `poly_id_elementary`, `poly_id_middle`), filled by the same point-in-polygon util (grid index). Upload staging assigns `subdivisions` at insert time; the other classes fill right after "Add All" commits; any boundary-file re-upload auto-re-runs its own class; a manual admin button assigns/re-assigns everything with a per-polygon audit modal. `/api/query` ops swap the aggregation key CASE to these columns.

**Tech Stack:** Next.js 15 / React 19, Firebase Data Connect (`_execute` raw SQL ops), Firestore (`cms_files` boundary records), Leaflet app, esbuild + node:test for the pure-util tests, admin UI.

**Spec:** `docs/superpowers/specs/2026-10-19-polygon-point-assignment-design.md` (design incl. the 2026-10-19 scope extension + boundary re-upload policy)

## Global Constraints

- The assistant never deploys (`firebase deploy`, `dataconnect:sql:migrate`, Vercel): schema and connector deploys are the owner's manual steps (project rule, `no-git-deployments`).
- Geometry source for class C = the LATEST `cms_files` Firestore record with `name == BOUNDARY_SOURCES[C]`, `category 'boundary'`, read from `storageUrl`. NEVER the local light copies (`public/geojson/*.geojson.gz`, `kwizi-python-tools/Mapped Subdivisions.geojson`). The current Storage copies differ in size from history (e.g. Mapped Subdivisions is now 833.79 KB as of 2026-10-18) — always resolve dynamically.
- Polygon key = `cleanBoundaryName(feature.properties['Name'])` — the same function (`@/lib/engine`) the map uses for its feature keys; never invent a second normalizer.
- Rows inside two polygons of the same class: assign the **smallest containing polygon** (shoelace area). Rows without coordinates or inside no polygon of the class: column stays empty (`''`), tallied in the audit.
- Aggregation semantics stay exactly as today: `COUNT(*)` per group, `percentile_cont(0.5) FILTER (WHERE close_price > 0)` for price medians — only the key column changes.
- `areas` has no polygon file — untouched. `High School ISD.geojson` and `COH_SiteAddresses.geojson` are not referenced by `BOUNDARY_SOURCES` — untouched.
- Backfill writes ONLY the five polygon columns on `upload_session_id IS NULL` rows (never other columns, never staged rows), via `COALESCE(batch_value, existing)` per column so one class's update never nulls another's.
- Work happens in the `new kwizi` repo. Commit at the end of each task with `Co-Authored-By: Claude Code <noreply@anthropic.com>` as the last line.

## Review Focus

- **Point outside every polygon of a class** (rows at coords (0,0), metro edge): expect `''` + audit unassigned tally — never a fabricated key. → Task 2 test `point outside all polygons returns ''`; Task 4 audit field.
- **Nested / duplicate-named polygons** (99 GeoJSON names shared by >1 feature): same-name polygons share one aggregate entry (accepted decision); a point in two polygons lands on the smallest. → Task 2 tests.
- **Class isolation**: assigning `zipcodes` must not blank or alter `subdivisions` (or any other class) on the same row. → Task 2 test + Task 3 write op's COALESCE-per-column; Task 4 manual check in the verification step.
- **Non-sale and coordinate-less rows**: rent rows participate (they carry lat/lng); tax rows without coordinates stay unassigned everywhere; rows whose class file is EMPTY (e.g. current `Zip.geojson` is 42 bytes — zero features) must short-circuit to `assigned: 0` for that class, not hang. → Task 2, Task 4 route short-circuit step.
- **Staged-but-uncommitted rows**: never touched by the backfill (page ops filter `upload_session_id IS NULL`); staged rows get the subdivisions column at staging time, the rest at commit-hook time. → Tasks 3–5.

---

### Task 1: Schema — five polygon columns + indexes

**Files:**
- Modify: `dataconnect/schema/schema.gql`

**Interfaces:**
- Produces for Tasks 3–6: columns `poly_id_subdivisions`, `poly_id_zipcodes`, `poly_id_highschools`, `poly_id_elementary`, `poly_id_middle` (GraphQL fields `polyIdSubdivisions`, `polyIdZipcodes`, `polyIdHighschools`, `polyIdElementary`, `polyIdMiddle`) + indexes on each `(col, closeDateTs)`.

- [ ] **Step 1: Add the fields and indexes**

Inside the `@table` decorators, above the `@index(fields: ["closeDateTs"])` line:

```graphql
  @index(fields: ["polyIdSubdivisions", "closeDateTs"], order: [ASC, DESC])
  @index(fields: ["polyIdZipcodes", "closeDateTs"], order: [ASC, DESC])
  @index(fields: ["polyIdHighschools", "closeDateTs"], order: [ASC, DESC])
  @index(fields: ["polyIdElementary", "closeDateTs"], order: [ASC, DESC])
  @index(fields: ["polyIdMiddle", "closeDateTs"], order: [ASC, DESC])
```

After `lng: Float` (schema.gql:58), one comment + block:

```graphql
  # Subdivisions polygon this row's lat/lng falls inside, computed at CSV
  # upload time / by the admin assignment job (Point-in-Polygon, smallest
  # containing polygon wins). Empty = no usable coordinates or outside the
  # metro coverage. Subdivisions/neighborhoods aggregates group by this
  # column — NOT by the CSV "Subdivision" text. Same pattern for the other
  # boundary classes fed from BOUNDARY_SOURCES files (zip, schools).
  polyIdSubdivisions: String
  polyIdZipcodes: String
  polyIdHighschools: String
  polyIdElementary: String
  polyIdMiddle: String
```

- [ ] **Step 2: Verify**

Run: `grep -c "polyId" dataconnect/schema/schema.gql` → expect `10` (5 fields + 5 index lines).

- [ ] **Step 3: Commit**

```bash
git add dataconnect/schema/schema.gql
git commit -m "feat(schema): polygon id columns per boundary class

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: `polyMatch.ts` — grid-indexed point-in-polygon util (TDD)

**Files:**
- Create: `src/lib/polyMatch.ts`
- Test: `src/lib/polyMatch.test.ts`

**Interfaces:**
- Consumes: `cleanBoundaryName` from `@/lib/engine`.
- Produces for Tasks 4–5:
  - `export interface PolyIndex` (opaque)
  - `export function buildPolyIndex(features: GeoJSON.Feature[]): PolyIndex`
  - `export function assignPoly(lat: number, lng: number, index: PolyIndex): string` — cleaned name of the smallest containing polygon, or `''`.
  - `export function indexPolygonCount(index: PolyIndex): number`
- Polygons use the OUTER ring of `Polygon` geometries (holes ignored; Subdivisions plats don't use holes). Coordinates `[lng, lat]` GeoJSON order. Names cleaned ONCE at index build.
- Grid: fixed 0.05°×0.05° cells storing each polygon's index by bbox overlap; `assignPoly` ray-casts only the candidates of the point's cell.

- [ ] **Step 1: Write the failing test** — `src/lib/polyMatch.test.ts`, `node:test` + `assert/strict`:

`import { test } from 'node:test'; import assert from 'node:assert/strict';
import { buildPolyIndex, assignPoly, indexPolygonCount } from './polyMatch';`

Five tests, small square FeatureCollections (`properties: { Name }`):
1. `point inside a polygon returns its cleaned name` — square lng -95.6..-95.5 lat 29.7..29.8, Name `"West Memorial"`; `assignPoly(29.75, -95.55, idx) === cleanBoundaryName('West Memorial')`.
2. `point outside all polygons returns ''` — `assignPoly(29.0, -95.55, idx) === ''`.
3. `nested polygons assign the smallest` — big square + inner square `"Inner"`; point in the inner region → `"Inner"`.
4. `duplicate-named polygons share one key` — two disjoint squares both `"Riverside Park"`; assign in either → same string; `indexPolygonCount(idx) === 2`.
5. `nested classes stay isolated per index` — two indexes built from different feature sets; assignments don't leak names across indexes (no shared mutable state).

- [ ] **Step 2: Run to verify it fails**

Run: `npx esbuild src/lib/polyMatch.test.ts --bundle --platform=node --alias:@=./src --outfile=.poly-test.cjs && node .poly-test.cjs`
Expected: FAIL — `./polyMatch` module not found.

- [ ] **Step 3: Implement `src/lib/polyMatch.ts`**

`Map<string, PolyEntry[]>` keyed `"cellX:cellY"`; PolyEntry `{ name; ring: number[][]; area; bbox }`. Ray casting over the outer ring. Smallest-area-wins by comparing candidate areas.

- [ ] **Step 4: Run to verify it passes**

Run: `npx esbuild src/lib/polyMatch.test.ts --bundle --platform=node --alias:@=./src --outfile=.poly-test.cjs && node .poly-test.cjs && rm .poly-test.cjs`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/polyMatch.ts src/lib/polyMatch.test.ts
git commit -m "feat(map): point-in-polygon util with grid index for poly assignment

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Connector operations

**Files:**
- Modify: `dataconnect/connector/query.gql`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces for Tasks 4–5:
  - `stagePropertyRows` now upserts `poly_id_subdivisions` from the row JSON key `polyIdSubdivisions` (subdivisions only — assigned in-browser cheaply at staging; other classes deliberately left for the commit hook).
  - `mutation backfillPolyColumns($rows: String!) @auth(level: NO_ACCESS)` — JSON rows `{m, y, s?, z?, h?, e?, d?}` (s=subdivisions, z=zipcodes, h=highschools, e=elementary, d=middle); each column updates via `COALESCE(batch, existing)` so absent keys never null another class.
  - Five page queries `polyBackfillPageSubdivisions|Zipcodes|Highschools|Elementary|Middle($afterMls: String!, $afterYear: Int!, $limit: Int!, $onlyUnassigned: Boolean!)` — `{mlsNumber, datasetYear, lat, lng, closePrice}`.
  - `query polyAssignmentStatus @auth(level: NO_ACCESS)` — per-column `{total, withCoords, assigned, distinctPoly}`.

- [ ] **Step 1: stagePropertyRows — carry the subdivisions polygon id** (in the `batch` CTE, INSERT column list, and ON CONFLICT update): add `r->>'polyIdSubdivisions' AS poly_id_subdivisions,` / `poly_id_subdivisions,` / `poly_id_subdivisions = EXCLUDED.poly_id_subdivisions,`.

- [ ] **Step 2: append `backfillPolyColumns`** (after `stagePropertyRows`):

```graphql
# Polygon-id backfill: sets ONLY the five polygon columns for the exact
# (mls_number,dataset_year) keys the server route sends. COALESCE keeps a
# class's existing value when this batch doesn't target that class.
mutation backfillPolyColumns($rows: String!) @auth(level: NO_ACCESS) {
  _execute(sql: """
    WITH batch AS (
      SELECT
        r->>'m' AS m,
        (r->>'y')::int AS y,
        r->>'s' AS s, r->>'z' AS z, r->>'h' AS h, r->>'e' AS e, r->>'d' AS d
      FROM jsonb_array_elements($1::jsonb) AS r
    )
    UPDATE properties p2
    SET
      poly_id_subdivisions = COALESCE(b.s, p2.poly_id_subdivisions),
      poly_id_zipcodes     = COALESCE(b.z, p2.poly_id_zipcodes),
      poly_id_highschools  = COALESCE(b.h, p2.poly_id_highschools),
      poly_id_elementary   = COALESCE(b.e, p2.poly_id_elementary),
      poly_id_middle       = COALESCE(b.d, p2.poly_id_middle),
      updated_at = now()
    FROM batch b
    WHERE p2.mls_number = b.m AND p2.dataset_year = b.y
      AND p2.upload_session_id IS NULL
  """, params: [$rows])
}
```

- [ ] **Step 3: append the five page queries** (after `datasetVersion`), one per class — identical except the null-filter references that class's column:

```graphql
# Keyset-paged rows for one boundary class's polygon assignment.
# $onlyUnassigned=true limits to rows the class hasn't filled (commit hook);
# =false re-assigns ALL live rows (boundary re-upload / manual run).
query polyBackfillPageSubdivisions($afterMls: String!, $afterYear: Int!, $limit: Int!, $onlyUnassigned: Boolean!) @auth(level: NO_ACCESS) {
  rows: _select(
    sql: """
    SELECT mls_number, dataset_year, lat, lng, close_price
    FROM properties
    WHERE upload_session_id IS NULL
      AND lat IS NOT NULL AND lng IS NOT NULL
      AND (NOT $4::bool OR poly_id_subdivisions IS NULL OR poly_id_subdivisions = '')
      AND (mls_number, dataset_year) > ($1::text, $2::int)
    ORDER BY mls_number, dataset_year
    LIMIT $3::int
    """,
    params: [$afterMls, $afterYear, $limit, $onlyUnassigned]
  )
}
```

Repeat op verbatim as `polyBackfillPageZipcodes` (filter column `poly_id_zipcodes`), `polyBackfillPageHighschools` (`poly_id_highschools`), `polyBackfillPageElementary` (`poly_id_elementary`), `polyBackfillPageMiddle` (`poly_id_middle`). Op name and column must match each time.

- [ ] **Step 4: append `polyAssignmentStatus`**:

```graphql
query polyAssignmentStatus @auth(level: NO_ACCESS) {
  status: _select(
    sql: """
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int AS with_coords,
      COUNT(*) FILTER (WHERE poly_id_subdivisions IS NOT NULL AND poly_id_subdivisions <> '')::int AS assigned_subdivisions,
      COUNT(*) FILTER (WHERE poly_id_zipcodes IS NOT NULL AND poly_id_zipcodes <> '')::int AS assigned_zipcodes,
      COUNT(*) FILTER (WHERE poly_id_highschools IS NOT NULL AND poly_id_highschools <> '')::int AS assigned_highschools,
      COUNT(*) FILTER (WHERE poly_id_elementary IS NOT NULL AND poly_id_elementary <> '')::int AS assigned_elementary,
      COUNT(*) FILTER (WHERE poly_id_middle IS NOT NULL AND poly_id_middle <> '')::int AS assigned_middle
    FROM properties
    WHERE upload_session_id IS NULL
    """,
    params: []
  )
}
```

- [ ] **Step 5: Verify**

Run: `grep -c "polyBackfillPage" dataconnect/connector/query.gql` → 5; `grep -n "poly_id_subdivisions" dataconnect/connector/query.gql` → stage rows (3 lines) + backfillPolyColumns + page op.

- [ ] **Step 6: Commit**

```bash
git add dataconnect/connector/query.gql
git commit -m "feat(connector): polygon-column ops for staging, per-class page fill, status

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: `/api/sql/assign-poly` — per-class paged assignment + audit

**Files:**
- Create: `src/app/api/sql/assign-poly/route.ts`
- Create: `src/lib/boundaryFiles.ts` (moved out of MapComponent)
- Modify: `src/components/MapComponent.tsx:41-49` (import `BOUNDARY_SOURCES` from the new lib; delete the local definition)
- Create: `src/lib/polyAssignClient.ts` (browser driver for Task 5)

**Interfaces:**
- `src/lib/boundaryFiles.ts` produces:
  ```ts
  export const BOUNDARY_SOURCES: Record<BoundaryKey, string>;  // moved verbatim (BoundaryKey from '@/lib/engine')
  export const POLY_ASSIGN_CLASSES = ['subdivisions', 'zipcodes', 'highschools', 'elementary', 'middle'] as const;
  export type PolyAssignClass = (typeof POLY_ASSIGN_CLASSES)[number];
  ```
- Consumes: Task 2 `buildPolyIndex`/`assignPoly`; Task 3 ops with `getAdminDataConnect()` + `dcWithTimeout` (`@/lib/firebaseAdmin`), `getAdminFirestore()` for the cms_files lookup.
- Route contract: `POST /api/sql/assign-poly`, body `{ class: PolyAssignClass, cursor?: { m: string; y: number }, onlyUnassigned?: boolean }`. Absent cursor = start of that class. Absent class = error 400. Response per call:
  `{ pagesDone: 1, assigned: number, nextCursor: { m: string; y: number } | null, perPoly: Record<string, { count: number; prices: number[] }> }`
  — `nextCursor: null` means THE CLASS IS DONE. The route is STATELESS except a geometry disk cache. Guard: same `guardPublicRead(req)` as `delete-property-keys/route.ts` (project convention).
- `src/lib/polyAssignClient.ts` produces for Task 5:
  ```ts
  export interface PolyAssignAudit {
    classKey: PolyAssignClass; assigned: number; unassigned: number;
    distinctPoly: number; perPoly: { name: string; count: number; median: number | null }[];
  }
  export async function runPolyAssignment(
    classes: PolyAssignClass[],
    opts?: { onlyUnassigned?: boolean; onProgress?: (p: { classKey: string; assigned: number }) => void; signal?: AbortSignal }
  ): Promise<PolyAssignAudit[]>
  ```
  Drives per-class page loops until `nextCursor` null (throws "assign-poly made no progress" on cursor echo), accumulates `perPoly` (sums counts, concatenates `prices` for medians, prices filter `> 0`), audits `unassigned = rowsWithCoordsRead - assigned`... unassigned computed from `polyAssignmentStatus` at class completion (`withCoords - assigned`).

- [ ] **Step 1: implement the route**

Per call:
1. Class from body; resolve the boundary file: Firestore `cms_files` where `name == BOUNDARY_SOURCES[class]`, `category == 'boundary'`, latest `uploadedAt` → `storageUrl`.
2. Disk cache the RAW geojson text under `os.tmpdir()/kwizi-poly-geo/<class>-<uploadedAt>-<size>.json` (gzip-sniffed fetch+decompress inline, same trick as admin/page.tsx:520-543; serverless functions reuse tmp across invocations on warm containers). EMPTY feature array → respond `{ assigned: 0, nextCursor: null, perPoly: {} }`.
3. If absent cursor → start; fetch page via the class's page op (`PAGE = 5000`; `onlyUnassigned ?? true`).
4. `assignPoly(row.lat, row.lng, index)`; build batch payloads (class→json key: subdivisions→s, zipcodes→z, highschools→h, elementary→e, middle→d) and write chunks of 5000 via `backfillPolyColumns`.
5. Accumulate perPoly for THIS call's rows (count + close prices where `closePrice > 0`); when the page op returns 0 rows, respond with `nextCursor: null`.
6. Never send a full-row UPDATE; only these columns change.

- [ ] **Step 2: implement the client driver** (loop + progress + audits; cursor-echo guard).

- [ ] **Step 3: typecheck**

Run: `npx tsc --noEmit` → no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sql/assign-poly/route.ts src/lib/boundaryFiles.ts src/components/MapComponent.tsx src/lib/polyAssignClient.ts
git commit -m "feat(admin): per-class resumable polygon assignment route and driver

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Admin page — button, two automatic hooks, report modal

**Files:**
- Modify: `src/app/admin/page.tsx` (boundary completion block ~2282-2298; the "Add All" commit flow; Boundaries section panel; report modal area)
- (Uses Task 4's `polyAssignClient`, `boundaryFiles`)

**Interfaces:**
- Consumes: `runPolyAssignment`, `PolyAssignAudit`, `POLY_ASSIGN_CLASSES`, `BOUNDARY_SOURCES`.
- Produces: DOM/UI only.

- [ ] **Step 1: boundary-upload auto-hook** — after the boundary success toast (admin/page.tsx:2295-2298), if `staged.section === 'boundaries'` (or the actual local flag) and the record name matches a `BOUNDARY_SOURCES` entry: map the name → class (subdivisions file ⇒ `['subdivisions']`), then in background `runPolyAssignment(class, { onlyUnassigned: false })` and open the audit modal; on error, error toast `Polygon re-assignment failed: <msg>`.

- [ ] **Step 2: commit-hook (lazy classes)** — in the "Add All" commit flow (`commitPendingSession` call, admin/page.tsx — search `commitPendingSession` in the page), after a successful commit: background `runPolyAssignment(['zipcodes','highschools','elementary','middle'], { onlyUnassigned: true })` with progress toasts; silent audit modal only when it assigned > 0 rows.

- [ ] **Step 3: manual button** — Boundaries panel: `Re-asignar polígonos`, runs `runPolyAssignment(POLY_ASSIGN_CLASSES, { onlyUnassigned: false })`, disabled while running, progress text `Área asignada: N filas…`, AbortController on unmount.

- [ ] **Step 4: report modal** — same centered-modal styling as the existing upload report in admin/page.tsx (UploadedFileReport popup). Never-empty content: header (class(es), rows assigned/unassigned, polygons covered), `perPoly` table sorted count-desc (name · count · median as `$X`), footer with the no-polygon tally. State `polyAudits: PolyAssignAudit[] | null` shared by button + hooks.

- [ ] **Step 5: typecheck + route smoke**

Run: `npx tsc --noEmit` → no errors; dev-server manual checklist comes with Task 7 (NOT an automated test).

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/page.tsx
git commit -m "feat(admin): polygon re-assignment button, auto-hooks on boundary upload and commit, audit modal

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Query switch — aggregates and selection read the polygon columns

**SEQUENCE NOTE: the connector ops from Tasks 3+6 deploy only AFTER the schema deploy and the backfill run (spec decision 9). Do not ask the owner to mix the order.**

**Files:**
- Modify: `dataconnect/connector/query.gql` (only `areaMapValues` + `filteredPropertiesForSelection`)

**Interfaces:**
- Consumes: Task 1 columns. No change to `route.ts` / `buildVariables`.
- Produces: map values/counts keyed by polygon name for the polygon classes; `MapComponent`'s `resolveMetricId` finds the exact key (identity) — alias/ZIP/geometric-JSON fallbacks stop firing for assigned polygons.

- [ ] **Step 1: swap the `areaMapValues` CASE** — all three boundary-CASE expressions (SELECT key alias, the two WHERE guards; ~688 and ~753-765):

```sql
      CASE $1::text
        WHEN 'subdivisions' THEN poly_id_subdivisions
        WHEN 'neighborhoods' THEN poly_id_subdivisions
        WHEN 'zipcodes' THEN poly_id_zipcodes
        WHEN 'highschools' THEN poly_id_highschools
        WHEN 'elementary' THEN poly_id_elementary
        WHEN 'middle' THEN poly_id_middle
        WHEN 'areas' THEN area
        ELSE poly_id_subdivisions
      END AS key,          -- same CASE pattern in both WHERE guards
```

- [ ] **Step 2: swap the CASE in `filteredPropertiesForSelection`** — the single CASE at query.gql:165-175, same replacement.

- [ ] **Step 3: verify**

Run: `grep -n "poly_id_" dataconnect/connector/query.gql` — the Task 3 ops plus exactly the new CASE lines (3 in areaMapValues, 1 in filteredPropertiesForSelection).

- [ ] **Step 4: Commit**

```bash
git add dataconnect/connector/query.gql
git commit -m "feat(connector): group polygon-class aggregates and selection by point-in-polygon ids

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Final verification and owner deploy checklist

**Files:**
- none (verification + cleanup)

- [ ] **Step 1:** Run: `npx tsc --noEmit && git status --short` → no errors; only planned files modified.

- [ ] **Step 2:** Run: `rm -f query-res.json .poly-test.cjs` (temp artifacts; workspace-root jpeg screenshots stay where the rest of them live).

- [ ] **Step 3: owner deploy checklist** (in the final report):
  1. `firebase dataconnect:sql:migrate` — adds the 5 columns (+ indexes); nothing reads them yet, map unchanged.
  2. CMS → Boundaries → `Re-asignar polígonos` — assigns all 505k rows per class; audit modal per class. Spot-check: West Memorial ≈ the photo's ~218 rows / ~$277,000 (unless the CSVs changed since).
  3. Deploy the connector (Tasks 3+6 ops). Before this the map keeps today's numbers — no silent flip.
  4. Verify the map: force-reload (or Clear cache), hover West Memorial + 2–3 polygons of other classes vs the audit table.

- [ ] **Step 4:** Report results faithfully; if a task failed, state it with output.

## Self-review notes (resolved during writing)

- Spec coverage: Goals 1–5 → Task 1 (columns), 2 (PIP util), 3 (staging + per-class fill ops), 4 (route/driver per class + audit), 5 (buttons/hooks/modal), 6 (query switch), 7 (owner checklist). Re-upload policy = Task 5 Step 1 (per-class, onlyUnassigned=false). Scope extension table = 5 columns throughout.
- Known limitation (documented, unchanged): OFFLINE worker fallback (`aggregateWorker.ts`, local CSV mode) still groups by text — SQL mode is the deployed map's path.
- Sequence 1→7 is dependency-ordered: polyMatch (2) is needed by 4; boundaryFiles (Task 4) needed by 5 and 6's deploy order note.