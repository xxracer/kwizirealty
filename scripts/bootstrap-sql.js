/**
 * scripts/bootstrap-sql.js — one-time initial ingest of the published chunk
 * dataset into SQL Connect (same logic as /api/sql/sync, driven directly with
 * the admin SDK so the whole dataset mirrors in one run instead of one chunk
 * per HTTP call). Idempotent: upserts by mlsNumber and records the same
 * Firestore state (cms_meta/sql_sync), so runtime syncs after this are no-ops
 * until a new version is published.
 *
 * Run: node scripts/bootstrap-sql.js
 * Env: GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT (see .env.local)
 */
const zlib = require('zlib');
process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'myreatstat';
// Standalone script: node does not load .env.local — default to this
// machine's gcloud ADC when the caller didn't provide credentials.
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'myreatstat.firebasestorage.app';
const MANIFEST_PATH = 'cms_files/csv/master_cache_chunks.json';
const UPSERT_BATCH = 250;

const { initializeApp } = require('firebase-admin/app');
const { getDataConnect } = require('firebase-admin/data-connect');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function storageUrl(path) {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
}

async function fetchJson(path) {
  const res = await fetch(storageUrl(path), { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function decodeChunk(buf) {
  const isGzip = buf.subarray(0, 2).equals(GZIP_MAGIC);
  const text = isGzip ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.header) || !Array.isArray(parsed.rows)) {
    throw new Error('Unexpected chunk format (expected {header, rows})');
  }
  const header = parsed.header;
  return parsed.rows.map((vals) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = vals[i];
    return obj;
  });
}

function toSqlRow(row) {
  const mls = String(row.mlsNumber ?? '');
  const closePrice = Number(row.closePrice ?? 0);
  const lat = Number(row.lat ?? 0);
  const lng = Number(row.lng ?? 0);
  if (!mls || !closePrice || !lat || !lng) return null;
  return {
    mlsNumber: mls,
    address: String(row.address ?? ''),
    city: String(row.city ?? ''),
    state: String(row.state ?? ''),
    zip: String(row.zip ?? ''),
    closePrice,
    listPrice: Number(row.listPrice ?? 0),
    pricePerSqft: Number(row.pricePerSqft ?? 0),
    sqft: Number(row.sqft ?? 0),
    lotSize: Number(row.lotSize ?? 0),
    br: Number(row.br ?? 0),
    baths: Number(row.baths ?? 0),
    yearBuilt: Number(row.yearBuilt ?? 0),
    dom: Number(row.dom ?? 0),
    cdom: Number(row.cdom ?? 0),
    closeDate: String(row.closeDate ?? ''),
    closeYear: Number(row.closeYear ?? 0),
    closeDateTs: Number(row.closeDateTs ?? 0),
    maintFee: Number(row.maintFee ?? 0),
    maintFeeSchedule: String(row.maintFeeSchedule ?? ''),
    taxRate: Number(row.taxRate ?? 0),
    taxYear: Number(row.taxYear ?? 0),
    taxAmount: Number(row.taxAmount ?? 0),
    subdivisions: String(row.subdivisions ?? ''),
    zipcodes: String(row.zipcodes ?? ''),
    highschools: String(row.highschools ?? ''),
    highschoolName: String(row.highschoolName ?? ''),
    elementary: String(row.elementary ?? ''),
    middle: String(row.middle ?? ''),
    schoolDistrict: String(row.schoolDistrict ?? ''),
    marketArea: String(row.marketArea ?? ''),
    area: String(row.area ?? ''),
    lat,
    lng,
    propertyType: String(row.propertyType ?? ''),
    pool: !!row.pool,
  };
}

(async () => {
  const started = Date.now();
  const app = initializeApp({});
  const dc = getDataConnect(
    { location: 'us-central1', serviceId: 'kwizi-sql', connector: 'default' },
    app
  );
  const db = getFirestore(app);

  // 1. Manifest = the single source of truth.
  const manifest = await fetchJson(MANIFEST_PATH);
  if (!manifest) {
    console.error('NO_MANIFEST');
    process.exit(1);
  }
  const version = typeof manifest.version === 'number' ? manifest.version : 0;
  const boundaries = manifest.boundaries || {};
  const allChunks = [];
  for (const b of Object.keys(boundaries)) {
    for (const c of (boundaries[b] && boundaries[b].chunks) || []) allChunks.push(c);
  }
  console.log(`MANIFEST version=${version} chunks=${allChunks.length}`);

  // 2. A newer published version than what's mirrored → wipe and start over.
  const stateRef = db.collection('cms_meta').doc('sql_sync');
  const state = await stateRef.get();
  const stateData = state.data() || {};
  let syncedChunks = stateData.syncedChunks || [];
  if ((stateData.version ?? 0) !== version) {
    await dc.executeMutation('clearProperties', {});
    syncedChunks = [];
  }

  // 3. Ingest pending chunks one at a time (bounded memory).
  let rows = 0;
  let chunkIdx = 0;
  for (const chunkPath of allChunks) {
    if (syncedChunks.includes(chunkPath)) continue;
    chunkIdx++;
    try {
      const res = await fetch(storageUrl(chunkPath), { cache: 'no-store' });
      if (!res.ok) {
        console.error(`FETCH_FAIL ${chunkPath} ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const records = decodeChunk(buf);
      const sqlRows = [];
      for (const r of records) {
        const mapped = toSqlRow(r);
        if (mapped) sqlRows.push(mapped);
      }
      for (let i = 0; i < sqlRows.length; i += UPSERT_BATCH) {
        // The admin SDK keys this by the GraphQL TYPE name (Property), not the
        // SQL table name (properties) — see dataconnect/schema/schema.gql.
        await dc.upsertMany('Property', sqlRows.slice(i, i + UPSERT_BATCH));
        rows += Math.min(UPSERT_BATCH, sqlRows.length - i);
      }
      syncedChunks.push(chunkPath);
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(`INGESTED [${syncedChunks.length}/${allChunks.length}] rows=${rows} (${elapsed}s)`);
    } catch (err) {
      console.error(`CHUNK_FAIL ${chunkPath}:`, (err && err.message) || err);
    }
    // Checkpoint progress so an interruption resumes where it stopped.
    await stateRef.set(
      { version, syncedChunks, done: false, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  // 4. Final verification + completion state.
  const check = await dc.executeQuery('distinctValues', {});
  const totalRows = Number(check.data?.values?.total_rows ?? 0);
  const done = syncedChunks.length >= allChunks.length;
  await stateRef.set(
    { version, syncedChunks, done, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  console.log(`DONE rows=${totalRows} done=${done} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(0);
})().catch((err) => {
  console.error('FATAL', (err && err.message) || err);
  process.exit(1);
});