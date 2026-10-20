# Design: Per-polygon geographic assignment of CSV rows

**Date:** 2026-10-19 · **Status:** approved in conversation (owner picked the approach)
**Owner-facing name:** "Mapa con los datos exactos del CSV en cada polígono"

## Intent and why

Every polygon on the Subdivisions map must show, in its hover popup and in the
color legend, the values computed from **exactly the CSV rows whose lat/lng
falls inside that polygon** — the same semantics the owner's reference
application (Streamlit `Real_Stat.py`, kept locally at the workspace root)
uses, and the numbers the owner cross-checks against har.com data:

- **count** ("Samples" / "N properties") = number of rows inside the polygon
  after the same period/filters the map is displaying,
- **value** = median over the display metric (e.g. `Close Price` for "Sales
  Price") of those same rows.

Today the map derives polygon values by **string-matching the polygon's name
against the CSV "Subdivision" column** (normalized). Verified failure
(2026-10-19, dataset 505,210 sale rows): polygon "WEST MEMORIAL R/P" resolves
to a ≤10-row name group; the ~218 rows physically inside it are scattered
across `W MEMORIAL`, `W MEMORIAL SEC 01 R/P`, `W MEMORIAL SEC 03 R/P`, … —
so the popup shows a tiny count and a wrong median (owner saw 2 / $308,000;
reference says 218 / $277,000). This affects the whole map, not just West
Memorial. Fixing one polygon is explicitly wrong; the fix is systemic.

## Goals

1. Every polygon of every boundary class that has a polygon file —
   **subdivisions, neighborhoods (same file), zipcodes, highschools,
   elementary, middle** (`BOUNDARY_SOURCES`, MapComponent.tsx:41-49) —
   displays aggregates over exactly its geographically-contained CSV rows,
   for all metrics and all period choices (the 8 time periods are computed
   at query time from `closeDateTs`, so they keep working). The owner
   confirmed 2026-10-19: "recuerda los otros geojson usados" — the scope is
   ALL the boundary geojson the map uses; all the data needed lives in the
   CSVs (each row already carries lat/lng).
2. Live filters (price ranges, beds, sqft, year, cities, pool, schools, …)
   keep working unchanged — they filter rows, then rows group by polygon.
3. Future CSV uploads automatically get geographic assignment at upload time
   (subdivisions, whose boundary file is small); the other classes fill in
   automatically right after each upload's "Add All" commit (rows whose
   column is still empty).
4. A one-time backfill assigns the ~505,210 existing sale rows (plus rental
   rows in the dataset) without re-uploading any CSV.
5. The owner can verify: for spot polygons (West Memorial is the canonical
   one), popup count/median must equal a locally computed count/median from
   the CSV rows inside the polygon.

## Scope extension (owner 2026-10-19): per-class columns

One column is not enough — there is one polygon column per boundary class
that has a file:

| Column (Postgres) | Boundary keys fed |
|---|---|
| `poly_id_subdivisions` | `subdivisions`, `neighborhoods` |
| `poly_id_zipcodes` | `zipcodes` |
| `poly_id_highschools` | `highschools` |
| `poly_id_elementary` | `elementary` |
| `poly_id_middle` | `middle` |

Assignment runs per class (each class re-runs only when its own boundary
file is re-uploaded; the school/zip files can be large — e.g. Elementary
School ISD.geojson is ~171 MB — so per-class processing and a disk cache of
the parsed geometry keep it feasible in serverless functions). The boundary
file that was current at execution time is always the one used (latest
`cms_files` record by `uploadedAt`) — this matters because the owner
re-uploads boundaries and the CURRENT Storage copy (833.79 KB,
2026-10-18) is already different from the historical 65 MB file.

## Non-goals / out of scope (this iteration)

- The **"areas"** boundary has no polygon file (`BOUNDARY_SOURCES.areas = ''`)
  — it keeps the CSV text key.
- `High School ISD.geojson` and `COH_SiteAddresses.geojson` are uploaded in
  Storage but are NOT referenced by `BOUNDARY_SOURCES` (MapComponent.tsx:41-49
  — highschools uses `Houston_ISD.geojson`) — they are not drawn map layers
  and stay untouched.
- The offline SQLite/Streamlit `Real_Stat.py` app itself stays untouched.
- The `Real_Stat.py` app itself stays untouched.
- No redesign of the color scales / legends / popup layout.

## Anti-goals (failure even if it "works")

- Popup numbers that disagree with a point-in-polygon recomputation from the
  CSV rows (that is the bug being fixed).
- Any new hidden sampling for these values (the legacy 50,000-row `SQL_ROW_CAP`
  path must not silently decide what West Memorial says).
- Dropping the interactive filters so polygons are "precomputed-only".

## Constraints

- Data layer is Firebase Data Connect (Postgres, no PostGIS) — **spatial
  joins cannot run in the database**. Assignment must be computed outside
  SQL (browser worker and/or a Node/Python tool) and stored as plain columns.
- Schema changes require the owner's manual Data Connect deploy (the project
  rule is the owner pushes/deploys; nothing may be deployed by the assistant).
- The whole flow that previously imported ~974k rows ran from the browser
  against Data Connect `_execute`; same channel is available for backfill.
- Subdivisions boundary file: `Mapped Subdivisions.geojson` — ~59k polygons,
  already gzipped in Firebase Storage and cached in the browser (IndexedDB).
  The same geometry file exists locally in `kwizi-python-tools/`.

## Geometry source of truth (fact-checked 2026-10-19)

- The map actually reads the **Firebase Storage copy** `cms_files/Mapped
  Subdivisions.geojson` (category `boundary`, exact file name — 65,171,634
  bytes, uploaded 2026-09-17). That is the ~59–63k-polygon file the map
  renders ("63,212 areas" in the top bar, MapComponent's "~59k polygons"
  comment).
- The smaller 4,983-feature copies on disk (`kwizi-python-tools/Mapped
  Subdivisions.geojson`, `public/geojson/subdivisions.geojson.gz`) are
  unrelated lightweight/local files — **not** the assignment source. The
  backfill and any audit must download the Storage copy (same channel as
  `kwizi_backup_download.py`).
- Every boundary re-upload lightens/simplifies geometry (~11m tolerance) —
  see re-upload policy below.

## Boundary re-upload policy (owner 2026-10-19: automatic)

When a new **Subdivisions** boundary file is uploaded (the file that feeds the
`subdivisions`/`neighborhoods` layer), the property→polygon assignment for the
existing rows is **re-computed automatically** as part of that upload — the
owner expects uploads of boundaries to "just update" the map data, the same
way uploaded GeoJSON already goes live immediately. Other boundary files
(zips, schools) don't trigger anything: they don't affect this column. The
re-assignment reuses the same machinery as the one-time backfill; it must not
block the map (background job, staged, committed like the existing upload
flows).

## Decided decisions (owner or obvious from the conversation)

- **Assignment source of truth: point-in-polygon.** A row belongs to the
  subdivision polygon whose surface contains its `lat`/`lng`.
- Semantic parity with the reference app wins over any clever name matching.
- The CSV `Subdivision` text keeps existing in SQL (search, chat stats, and
  the selection report still use it); polygons simply stop relying on it as
  the aggregate key.
- `cleanBoundaryName` normalization stays untouched for the places that still
  use name matching.

## Builder's calls to make (document as builder's choice if needed)

1. **Rows inside two polygons: which polygon wins?** Recommendation: assign
   the **smallest containing polygon** (most specific). The reference app
   (`gpd.sjoin`, `predicate="intersects"`) counts the row in *all* of them;
   replicate only if subdivision polygons actually overlap measurably — check
   during the backfill and report the number of multi-hit rows.
2. **Rows missing lat/lng (or lat=lng=0):** excluded from geographic groups
   (same as the reference app, which only loads rows with coordinates). Their
   count/median simply doesn't count anywhere; report how many rows that is.
   Rows whose coordinates fall inside NO polygon: unassigned, tallied in the
   audit report (expected small — outside the metro coverage).
3. **Where the polygons geometry comes from for each context** — the Storage
   copy (see "Geometry source of truth"); never the local lightweight files.
4. **Key = polygon NAME, as stored in the GeoJSON** (the map's existing
   feature key, `cleanBoundaryName`-cleaned like today). Reason: names are
   stable across boundary re-uploads, display names already resolve through
   them, and per-name sharing is acceptable — the GeoJSON has 99 names shared
   by more than one feature (e.g. `RIVERSIDE PARK` ×2), which will simply
   share one aggregate under the same visible label. fid-based keys were
   evaluated and rejected: fragile across the owner's boundary re-upload
   rehearsal flow and would touch selection/id plumbing everywhere.
5. **`neighborhoods` switches too.** It renders the same Storage file and
   groups by the same row column — leaving it on name matching would keep
   the exact bug on an identical-looking map layer. One mode, two labels.
6. **`/api/sql/import` route is dead code** (no caller in src; admin page
   uses `csvRowsToSqlPropertyRows` directly via the browser staging flow).
   Builder tags it deprecated in a comment and applies the same polygon
   assignment if trivially shared via the upload helper — otherwise a
   410-style guard + comment, so goal 3 can't break silently.
7. **Selections and the selection report move to the polygon key for
   polygon-class selections.** When the user selects polygons, the selection
   (and the exact-rows report behind it) must filter by the new polygon key
   — filtering the report by the CSV `Subdivision` *text* would return
   nearly nothing for precisely the polygons this fix targets (a polygon's
   contained rows carry variant texts like `W MEMORIAL SEC 03 R/P`). The
   "Subdivision text keeps existing" rule stays true for TEXT-based
   consumers: the search box, chat stats, and the CSV row itself.
8. **Staged-but-uncommitted rows are NOT backfilled** (ephemeral by design);
   the backfill only touches `upload_session_id IS NULL` rows. Upload-time
   assignment covers future staged rows as they are committed.
9. **Deploy sequence (no broken transitional state):**
   1) owner deploys the *schema* (adds the column; nothing reads it yet),
   2) backfill fills the column + audit report,
   3) owner deploys the *connector* change (GROUP BY polygon key / selection
      ops). Before step 3 the map keeps today's behavior — no silent flip to
      empty aggregates.

## Architecture (the how, as decided)

One `properties` table column, filled by the same assignment semantics in two
places, consumed by one query change:

1. **Schema:** add `polyIdSubdivisions: String` (snake_case column
   `poly_id_subdivisions` — same name the reference app used for this exact
   concept) with an index on `(polyIdSubdivisions, closeDateTs)`.
2. **Upload flow (future-proof):** the CSV→SQL browser worker resolves each
   row's polygon id **at upload time**, against the cached Subdivisions
   GeoJSON (it already fetches/stores boundary files), and writes it into
   `polyIdSubdivisions` alongside the existing field mapping. Rows without
   usable coordinates get an empty value.
3. **Backfill (existing data):** a one-time assignment job over the existing
   rows (same pattern as the historic `recover-cms-to-sql.js` browser-based
   import, or a `kwizi-python-tools` script using shapely + a spatial index —
   builder picks based on Data Connect write mechanics):
   - read `mlsNumber`, `datasetYear`, `lat`, `lng` for all live rows,
   - load `Mapped Subdivisions.geojson`, R-tree/grid index,
   - compute containing polygon per row,
   - write `polyIdSubdivisions` back in bounded batches,
   - progress and resumability required (it is ~505k rows),
   - produce an **audit report**: per-polygon old name-group count vs new
     geographic count, total rows assigned / unassigned / multi-hit, and a
     CSV spot-check table for at least West Memorial (expected: ~218 rows).
4. **Query:** `/api/query` fast path (`areaMapValues`) for
   `boundary=subdivisions` switches `GROUP BY` from `subdivisions` to
   `poly_id_subdivisions`; keys become polygon ids, and the
   polygon→data-key alias/name resolution becomes identity for this boundary.
   The legacy/worker path mirrors it (group by the polygon id column).
5. **Map resolution:** `MapComponent` value/count lookup for Subdivisions
   keys directly on `metricValues[polygonId]`; the alias-index / ZIP-bridge /
   geometric-JSON fallbacks remain only as a safety net and must be reached
   zero times in normal operation (assertable via console in dev builds).

## Success criteria

- West Memorial (reference case): popup ≈ 218 properties and median ≈
  $277,000, matching an independent point-in-polygon recount from the CSV.
- The audit report shows zero polygons whose displayed value depends on name
  matching (in dev, the fallback path logs zero resolutions).
- All filters still recomputed correctly with geographic groups.
- Fresh CSV upload assigns polygon ids without manual steps.

## Verification plan (owner-facing)

After backfill + deploy, the owner checks in their browser:
- hover West Memorial → 218 / $277,000 (or whatever the current CSVs
  actually produce after the historical uploads coexist — the audit table is
  the arbiter, not a remembered number).
- a handful of other polygons of their choice vs the audit table.