# SQL Connect — setup status

Everything stays inside Firebase (free tier). The map never downloads the full
dataset: it opens with GeoJSON only, filters fetch aggregates from SQL
(KB-sized responses), reports render instantly, and reports/chat fetch only the
selected areas' rows.

## Done (2026-09-10) — SQL mirror is LIVE

- Service `kwizi-sql` deployed in `us-central1` (schema + connector `default`).
- Postgres `properties` table created with correct Float columns
  (`pricePerSqft`, `lotSize`, `maintFee`, `taxRate`, `taxAmount` — decimals in
  the real data broke Int columns).
- All 37 chunks ingested via `scripts/bootstrap-sql.js`:
  **101,606 unique properties** (505,220 chunk records deduped by mlsNumber —
  rows repeat across boundaries' chunk sets by design). Firestore
  `cms_meta/sql_sync` = `{ version: 1788998423513, done: true }`.
- Verified end-to-end: `distinctValues` (101,606), `filteredProperties`
  (decimal values round-trip), `filteredPropertiesForSelection` (241 rows for
  two subdivisions).
- The map auto-switches to SQL-first mode (no manual step): when
  `cms_meta/sql_sync.done` is true AND its version matches the chunk manifest,
  the map fetches KB aggregates from `/api/query`, dropdowns from
  `/api/sql/distinct`, and instant reports from the selection's rows. Any SQL
  failure flips `sqlFailed` and the worker dataset path takes over
  automatically; the next filter/metric change retries SQL.

## Maintenance

- A NEW published dataset version (CSV upload → new manifest version) makes the
  mirror stale: the map's watchdog re-checks `cms_meta/sql_sync` every 30 s and
  fires `runSqlSync()` (resumable, one chunk per call) until the new version is
  mirrored; the worker path serves the map meanwhile.
- Re-running `node scripts/bootstrap-sql.js` is also safe — it detects the
  version, clears, and re-ingests.

## Production (Vercel) — still pending

Create a service-account key (Firebase console → Project settings → Service
accounts → Generate new private key) and set `FIREBASE_SERVICE_ACCOUNT` to the
full JSON in Vercel env. Local dev uses the machine's gcloud ADC
(`GOOGLE_APPLICATION_CREDENTIALS` in `.env.local`).

## Gotchas learned

- The admin SDK `upsertMany` keys by the GraphQL TYPE name (`Property`), not
  the SQL table name (`properties`).
- Native-SQL ops live in `dataconnect/connector/query.gql`
  (`filteredProperties`, `filteredPropertiesForSelection`, `clearProperties`,
  `distinctValues`); schema in `dataconnect/schema/schema.gql` with composite
  `(boundary, closeDateTs)` indexes.
- If `firebase deploy --only dataconnect` aborts with "unused SQL objects", a
  stray table was left behind — drop it directly via the Cloud SQL IAM path
  (the CLI's `migrate --force` reports destructive drops but skips them).