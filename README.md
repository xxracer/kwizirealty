# ResDogs

The ResDogs Houston market explorer — the **`new kwizi` app rebuilt in Python**,
with the **old app's map** as the rendering engine.

- **Data**: Firebase only — Data Connect / Cloud SQL (`properties`), Firestore
  (`cms_files`), Cloud Storage (boundary GeoJSON / GPKG). No DuckDB, no
  MotherDuck, no local database.
- **UI**: the `new kwizi` design, verbatim — the same header, summary bar,
  eight filter sections, map card, tool column and report cards.
- **Map**: the old app's engine — MapLibre GL + OpenStreetMap raster, fill
  layer keyed by polygon, click / box / lasso selection, hover tooltip.
- **No TypeScript**: FastAPI + Jinja2 + plain JS.

## Run locally

```bash
pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8601
```

Open `http://127.0.0.1:8601/` (home) and `http://127.0.0.1:8601/map`.

`.env.local` must contain the Firebase service account (the same file the web
app uses):

```
NEXT_PUBLIC_FIREBASE_PROJECT_ID=resdogs-4c0ff
NEXT_PUBLIC_DATACONNECT_LOCATION=us-east4
DATACONNECT_SERVICE_ID=resdogs-4c0ff-service
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
```

## Deploy to Vercel

Vercel auto-detects `server.py` (an ASGI app named `app`). Static files under
`static/` are promoted to the CDN by the `StaticFiles` mount.

1. Import the `RESDOGS` folder as the project root.
2. Set the environment variables above (Production + Preview).
3. Deploy.

`vercel.json` grants the function 60 s (the first aggregate on a cold instance
takes ~4–5 s; subsequent requests are memoized and answer in milliseconds).

## Admin / CMS — `/login` → `/admin`

Same flow as `new kwizi`: `/login` signs in with Google (or email/password),
`/admin` redirects there when there is no session, and the server verifies the
Firebase ID token against `NEXT_PUBLIC_CMS_ALLOWED_EMAILS` on every call.

### The access-control switch (MVP)

**Dashboard → User management**. Stored in Firestore `cms_config/auth`
(`userManagementEnabled`), read live by `/api/me` (5 s cache):

- **OFF** (default) — the map is open: anyone sees every filter, selection and
  report for free. Use this while marketing runs the MVP.
- **ON** — the plan model below is enforced: visitors without an account get a
  read-only map.

`adminLoginRequired` remains in the same document; `/admin` still requires an
allowlisted admin (or an Enterprise account, limited to its own seats).

### Plans

| Plan | Access |
|---|---|
| **free** (not signed in) | The map is visible, but the filters, selection and reports are locked |
| **basic** | Filters + reports; Subdivisions, ZIP and Custom Areas |
| **premium** | Everything, including school / neighborhood boundaries and the map layers |
| **enterprise** | Everything + company seats: colleagues listed in a company inherit its plan |

A user's plan is resolved server-side (`accounts.resolve_account`) from the
`users` profile, or from the `companies` document when the email is one of its
seats. An expired subscription falls back to `free`. Company seats can be added
from **System Users → Company accounts** (admin, or the Enterprise account
itself).

### Ads

`Ads Campaigns` creates a Firestore `ads` document + media in Storage. Four
placements: `corner` (left skyscraper 160×600), `right` (right skyscraper),
`top` / `bottom` (1024×80 banner). The map renders active campaigns at 180 px
wide (sides) and 96 px tall (banners), picks one per placement, and the admin
form shows the exact pixel box plus a live preview before uploading.

The CMS mirrors the main app's sidebar:

- **Dashboard** — committed / pending rows, per-year table, polygon coverage,
  pending upload sessions, the resumable assignment job.
- **Sales · Rent · Tax · Current Listings** — drop a CSV; it is parsed with the
  same column mapping as `new kwizi` (`normalizeRow`), staged into Postgres
  under an `upload_session_id`, and published with **Add All** (or removed with
  **Discard**). The raw file is gzipped into Storage and registered in
  `cms_files`.
- **Area Metrics** — replace a boundary GeoJSON (validated, gzipped, Storage +
  Firestore).
- **Uploaded files** — per section, with delete.
- **Ads Campaigns / System Users** — read-only lists from Firestore.

## Per-polygon assignment (DONE 2026-10-21)

The five `poly_id_*` columns exist and hold the polygon name for every row
with coordinates:

| Column | Assigned | Polygons |
|---|---|---|
| `poly_id_subdivisions` | 483,399 | 4,296 |
| `poly_id_zipcodes` | 770,684 | 211 |
| `poly_id_highschools` | 319,273 | 60 |
| `poly_id_elementary` | 318,620 | 351 |
| `poly_id_middle` | 319,334 | 101 |

**After every data upload**, run:

```bash
python assign_polygons.py --only-missing
```

Add `--reset` to recompute everything (e.g. after replacing a boundary file).

The rows carry a subdivision **text** field that only matches a polygon name
for ~51 % of them; grouping by it under-counts every area. To group by the
polygon that actually contains each property:

1. Run `schema_poly_columns.sql` once in the Cloud SQL console (the app's
   service account can UPDATE rows but cannot ALTER the table — it is not the
   owner). It adds five `poly_id_*` columns + indexes.
2. Re-run the assignment (it only touches rows not yet assigned):

   ```bash
   python assign_polygons.py --only-missing
   ```

3. Restart the server. `engine.poly_columns_ready()` detects the columns and
   every aggregate switches to them automatically.

Until step 1 is done the app keeps working with the text fallback.

## How the numbers are computed

1. **Filters + period** → a `WHERE` clause on `properties` (the same rules as
   `new kwizi/src/lib/engineCore.ts`, including the list-to-sale sanity range
   that rejects corrupt `list_price` rows).
2. **Per-polygon values** → `percentile_cont(0.5)` grouped by the row's
   subdivision / ZIP / school name, executed in Postgres via the connector's
   `_executeReturning`. No 800k-row pull to the server.
3. **Custom areas** (`areas` boundary) → point-in-polygon in Python with
   shapely (Cloud SQL has no PostGIS).

## Boundaries

| Boundary | Source |
|---|---|
| Subdivisions / Neighborhoods | CMS file `Mapped Subdivisions.geojson` (Firestore → Storage) |
| ZIP codes, School districts, Elementary, Middle | the old app's GeoPackage layers on R2 |

The CMS file wins when present, so a re-upload through the admin is reflected
on the next process start. Features with a NULL geometry are skipped (a single
one would invalidate the whole collection for MapLibre).

## Files

| File | Role |
|---|---|
| `server.py` | FastAPI app: pages + JSON API (Vercel entrypoint) |
| `engine.py` | filters, SQL aggregates, point-in-polygon, market health |
| `metrics.py` | the metric / boundary / period / filter model, ported verbatim |
| `firebase_data.py` | Firebase auth + Data Connect SQL + Firestore + Storage |
| `templates/home.html` | the landing page |
| `templates/map.html` | the explorer |
| `static/app.css`, `static/home.css` | the `new kwizi` design tokens |
| `static/map.js` | the MapLibre engine + selection tools + report rendering |
