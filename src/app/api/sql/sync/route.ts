/**
 * /api/sql/sync — mirrors the published Firebase Storage dataset into the
 * SQL Connect Postgres table, ONE STEP PER CALL (resumable, no serverless
 * timeouts, no manual import script).
 *
 * Each invocation:
 *   1. verifies the caller's Firebase ID token,
 *   2. reads the chunk manifest from Storage (the single source of truth),
 *   3. reads the sync state from Firestore (cms_meta/sql_sync),
 *   4. when the manifest version changed: clears the table and resets state,
 *   5. ingests the next not-yet-synced chunk file: download → gunzip → parse
 *      → admin `upsertMany` (idempotent ON CONFLICT by mls_number),
 *   6. records the chunk as synced and returns progress.
 *
 * The admin page drives this route in a loop after every dataset rebuild
 * (and on mount), so uploads keep SQL current automatically — no buttons.
 * ALL boundaries' chunks are ingested: rows with an empty key for one
 * boundary (e.g. no subdivision) still exist under another, and the upsert
 * by mls_number makes the repeats free.
 *
 * Until the synced version matches the manifest version, the map page keeps
 * using its worker dataset — SQL never serves partial data.
 */
import zlib from 'zlib';
import { NextResponse } from 'next/server';
import { getAdminAuth, getAdminDataConnect } from '@/lib/firebaseAdmin';
import { guardPublicRead } from '@/lib/server/requestGuard';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const maxDuration = 60;

const BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'myreatstat.firebasestorage.app';
const MANIFEST_PATH = 'cms_files/csv/master_cache_chunks.json';
const STATE_DOC = { collection: 'cms_meta', id: 'sql_sync' };
/** Rows per admin upsertMany call (matches the proven import script batch). */
const UPSERT_BATCH = 250;
/** Stop the invocation after this many milliseconds; the client calls again. */
const TIME_BUDGET_MS = 40_000;

interface SyncState {
  version: number;
  syncedChunks: string[];
}

function storageUrl(path: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
}

async function fetchJson(path: string): Promise<any | null> {
  try {
    const res = await fetch(storageUrl(path), { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

interface ChunkRecord {
  [column: string]: unknown;
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** {header, rows} chunk → row objects (camelCase keys, PropertyData shape). */
function decodeChunk(buf: Buffer): ChunkRecord[] {
  const isGzip = buf.subarray(0, 2).equals(GZIP_MAGIC);
  const text = isGzip ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  const parsed = JSON.parse(text) as { header: string[]; rows: unknown[][] };
  if (!parsed || !Array.isArray(parsed.header) || !Array.isArray(parsed.rows)) {
    throw new Error('Unexpected chunk format (expected {header, rows})');
  }
  const header = parsed.header;
  return parsed.rows.map((vals) => {
    const obj: ChunkRecord = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = vals[i];
    return obj;
  });
}

/** The admin SDK upsert keys rows by the table key field (mlsNumber). */
function toSqlRow(row: ChunkRecord): Record<string, unknown> | null {
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
    listingType: 'sale',
    datasetYear: Number(row.closeYear ?? 0) || Number(row.taxYear ?? 0) || 0,
    updatedAt: new Date().toISOString(),
  };
}

export async function GET(req: Request) {
  // Vercel Cron invokes crons with GET; the browser loop uses POST.
  return POST(req);
}

export async function POST(req: Request) {
  // Auth — a signed-in Firebase token, the CRON_SECRET (Vercel Cron keeps the
  // mirror fresh when no one has the map open), or a same-origin public call:
  // the map itself drives the sync while a signed-out visitor waits for it.
  // The route only ever ingests rows from the Storage manifest (the source of
  // truth), so public triggering cannot inject data — same-origin + rate
  // limiting keep abuse down.
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const cronSecret = process.env.CRON_SECRET || '';
  if (!token || (cronSecret && token !== cronSecret)) {
    if (token) {
      try {
        await getAdminAuth().verifyIdToken(token);
      } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } else {
      const blocked = guardPublicRead(req);
      if (blocked) return blocked;
    }
  }

  const db = getFirestore();
  const stateRef = db.collection(STATE_DOC.collection).doc(STATE_DOC.id);

  // 1. Manifest = the single source of truth for what SQL must contain.
  const manifest = await fetchJson(MANIFEST_PATH);
  if (!manifest) {
    return NextResponse.json({ error: 'Manifest not found' }, { status: 503 });
  }
  const version = typeof manifest.version === 'number' ? manifest.version : 0;
  const boundaries: Record<string, { chunks: string[] }> = manifest.boundaries || {};
  const allChunks: string[] = [];
  for (const b of Object.keys(boundaries)) {
    for (const c of boundaries[b]?.chunks || []) allChunks.push(c);
  }

  const state = await stateRef.get();
  const stateData = state.data();
  const current: SyncState = state.exists && stateData
    ? { version: stateData.version ?? 0, syncedChunks: stateData.syncedChunks ?? [] }
    : { version: 0, syncedChunks: [] };

  // Direct SQL import mode (SQL_FIRST / admin uploads): the admin panel is the
  // source of truth. The legacy Storage manifest must NEVER wipe rows that were
  // uploaded directly to SQL, because the manifest is empty when CSVs live in
  // SQL only. Skip the destructive clear/ingest cycle in that mode.
  if (stateData?.directImport === true) {
    return NextResponse.json({ ok: true, done: true, version, skipped: true });
  }

  // Empty manifest = no published Storage dataset. Do not wipe SQL rows; the
  // admin may have populated SQL directly and we must preserve them.
  if (allChunks.length === 0 || (manifest.totalRows ?? 0) === 0) {
    await stateRef.set(
      { version, syncedChunks: [], done: true, totalRows: manifest.totalRows ?? 0, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    return NextResponse.json({ ok: true, done: true, version, empty: true });
  }

  // 2. New published version → start over. The DELETE clears rows that no
  //    longer exist in the CMS (deletes must propagate to SQL too).
  let syncedChunks = current.syncedChunks;
  if (current.version !== version) {
    const dc = getAdminDataConnect();
    await dc.executeMutation('clearProperties', {});
    syncedChunks = [];
    await stateRef.set({ version, syncedChunks, startedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  const pending = allChunks.filter((c) => !syncedChunks.includes(c));
  if (pending.length === 0) {
    await stateRef.set({ version, syncedChunks, done: true, totalRows: manifest.totalRows ?? 0, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return NextResponse.json({ ok: true, done: true, version, synced: allChunks.length, total: allChunks.length });
  }

  // 3. Ingest chunks until the time budget runs out (resumable loop).
  const dc = getAdminDataConnect();

  // Idempotent: ensure the Postgres trigger that refreshes updated_at on every
  // UPDATE exists. Ignored if already present or if Data Connect permissions
  // block it; rows also carry updatedAt explicitly from the client/server.
  try {
    await dc.executeMutation('createUpdatedAtTrigger', {});
  } catch {
    // ignore
  }

  const started = Date.now();
  let ingested = 0;
  let rows = 0;
  for (const chunkPath of pending) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    let res: Response;
    try {
      res = await fetch(storageUrl(chunkPath), { cache: 'no-store' });
    } catch {
      continue; // transient network error — the next call retries this chunk
    }
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    let records: ChunkRecord[];
    try {
      records = decodeChunk(buf);
    } catch {
      // A corrupt chunk must not wedge the loop forever — mark it synced and
      // let the manifest reconcile (sources compare) trigger a fresh rebuild.
      syncedChunks.push(chunkPath);
      ingested++;
      continue;
    }
    const sqlRows: Record<string, unknown>[] = [];
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
    ingested++;
  }

  const done = syncedChunks.length >= allChunks.length;
  await stateRef.set(
    { version, syncedChunks, done, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  return NextResponse.json({
    ok: true,
    done,
    version,
    synced: syncedChunks.length,
    total: allChunks.length,
    ingestedThisCall: ingested,
    rowsThisCall: rows,
  });
}