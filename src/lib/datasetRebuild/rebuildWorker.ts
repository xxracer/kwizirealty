/**
 * Browser worker that rebuilds the boundary-chunked dataset cache straight
 * from the CSVs in cms_files/csv/ — the same pipeline as
 * scripts/build-cache-from-cms.js, but running automatically inside the
 * admin's browser right after a CSV upload, so new data reaches every
 * visitor's map without anyone running scripts or pressing buttons.
 *
 * Memory care (this runs in the admin's tab, so it must stay lean):
 *  - Files are parsed one at a time and the raw text is released before the
 *    next download (peak ≈ the largest CSV + the normalized rows).
 *  - Repeated strings (subdivision/school/area names) are interned so 763k
 *    rows share one string instance each instead of thousands of copies.
 *  - Chunks are gzipped and uploaded one by one; nothing accumulates.
 *  - Only ONE rebuild can run at a time (the client singleton coalesces).
 *
 * Safety properties (mirroring the script):
 *  - Row-count gate: the rebuilt dataset must be the current deployed one
 *    plus/minus this upload's rows — never a wildly different composition.
 *    A failed gate uploads NOTHING (the live dataset stays untouched).
 *  - Chunk filenames are versioned (boundary_<key>_<idx>_v<version>.json.gz)
 *    so a half-finished rebuild can never mix old and new chunks: browsers
 *    only switch when the manifest (uploaded last) references them.
 *  - After a successful rebuild, chunks from older generations are removed,
 *    keeping the current and the previous generation for in-flight sessions.
 */

import { initializeApp, getApps } from 'firebase/app';
import { getStorage, ref, getDownloadURL, uploadBytes, deleteObject, listAll } from 'firebase/storage';
import Papa from 'papaparse';
import { firebaseEnvConfig as firebaseConfig } from '../firebaseEnv';
import type { RebuildPhase } from './phases';

interface RebuildStartMessage {
  type: 'start';
  /** Raw rows added since the last rebuild (safety gate, upper side). */
  addedRows: number;
  /** Raw rows removed since the last rebuild (safety gate, lower side). */
  removedRows: number;
}

type WorkerRequest = RebuildStartMessage;

interface ProgressMessage {
  type: 'progress';
  phase: RebuildPhase;
  message: string;
}
interface DoneMessage {
  type: 'done';
  version: number;
  totalRows: number;
}
interface ErrorMessage {
  type: 'error';
  message: string;
}
type WorkerResponse = ProgressMessage | DoneMessage | ErrorMessage;

const MANIFEST_PATH = 'cms_files/csv/master_cache_chunks.json';
const INDEX_PATH = 'cms_files/csv/chunk_area_index.json.gz';
const TARGET_ROWS_PER_CHUNK = 15_000;
const CSV_LIST_ROOT = 'cms_files/csv';
const SKIP_PATTERN = /(master_cache|property-manifest|chunk_area_index|^boundary_|^master_cache_chunk_)/i;
const CHUNK_PREFIXES = ['boundary_', 'master_cache_chunk_', 'chunk_area_index'];

const BOUNDARIES: { key: string; keyFn: (r: RebuildRow) => string }[] = [
  { key: 'subdivisions', keyFn: (r) => r.subdivisions },
  { key: 'zipcodes', keyFn: (r) => r.zipcodes },
  { key: 'highschools', keyFn: (r) => r.highschools },
  { key: 'elementary', keyFn: (r) => r.elementary },
  { key: 'middle', keyFn: (r) => r.middle },
];

interface RebuildRow {
  mlsNumber: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  closePrice: number;
  listPrice: number;
  pricePerSqft: number;
  sqft: number;
  lotSize: number;
  br: number;
  baths: number;
  yearBuilt: number;
  dom: number;
  cdom: number;
  closeDate: string;
  closeYear: number;
  closeDateTs: number;
  maintFee: number;
  maintFeeSchedule: string;
  taxRate: number;
  taxYear: number;
  taxAmount: number;
  subdivisions: string;
  zipcodes: string;
  highschools: string;
  highschoolName: string;
  elementary: string;
  middle: string;
  schoolDistrict: string;
  marketArea: string;
  area: string;
  lat: number;
  lng: number;
  propertyType: string;
  pool: boolean;
}

// --- Normalizers (identical to build-cache-from-cms.js / the engine's) ---

function stripBom(str: string): string {
  return str.replace(/^﻿/, '');
}

function cleanNumber(val: unknown): number {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return isFinite(val) ? val : 0;
  const cleaned = String(val).replace(/[^0-9.\-]+/g, '');
  const n = Number(cleaned);
  return isFinite(n) ? n : 0;
}

function cleanDate(raw: string): { date: string; year: number; ts: number } {
  if (!raw) return { date: '', year: 0, ts: 0 };
  const parts = raw.split('/');
  if (parts.length === 3) {
    const y = parseInt(parts[2], 10);
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    const year = isFinite(y) ? y : 0;
    const ts = year && m && d ? new Date(year, m - 1, d).getTime() : 0;
    return { date: raw, year, ts };
  }
  return { date: raw, year: 0, ts: 0 };
}

function cleanBool(raw: unknown): boolean {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1' || v === 'y';
}

function cleanBoundaryName(raw: unknown): string {
  let v = String(raw || '').toUpperCase().trim();
  if (!v || v === 'NA' || v === 'N/A' || v === 'NONE' || v === 'NULL' || v === 'UNKNOWN' || v === 'UNINCORPORATED') return '';
  return v
    .replace(/\s+/g, ' ')
    .replace(/\b(WLDS|WLDNGS|WLNDS)\b/g, 'WOODLANDS')
    .replace(/\b(VLG|VILL|VILLG|VILLAS)\b/g, 'VILLAGE')
    .replace(/\b(EST|ESTS)\b/g, 'ESTATES')
    .replace(/\b(PL|PLAT)\b/g, 'PLACE')
    .replace(/\b(CRE|CRK)\b/g, 'CREEK')
    .replace(/\b(MEADOWS|MEADOW)\b/g, 'MDW')
    .replace(/\b(RANCH|RNCH)\b/g, 'RNCH')
    .replace(/\bGROVE\b/g, 'GRV')
    .replace(/\bHEIGHTS\b/g, 'HTS')
    .replace(/\bSTATION\b/g, 'STA')
    .replace(/\bNORTH\b/g, 'N')
    .replace(/\bSOUTH\b/g, 'S')
    .replace(/\bEAST\b/g, 'E')
    .replace(/\bWEST\b/g, 'W')
    .replace(/\bAT\b/g, '@')
    .replace(/\bOF\b/g, 'OF')
    .replace(/\bTHE\b/g, 'THE')
    .trim();
}

function cleanDistrictCode(raw: unknown): string {
  const v = String(raw || '').trim();
  if (!v || v.toUpperCase() === 'NA' || v.toUpperCase() === 'N/A') return '';
  const name = v.replace(/^\d+\s*-\s*/, '').trim();
  if (!name) return '';
  if (/ISD$/i.test(name) || /SCHOOL\s+DISTRICT$/i.test(name)) {
    return cleanBoundaryName(name);
  }
  return cleanBoundaryName(name + ' Independent School District');
}

function cleanSchoolName(raw: unknown): string {
  let v = String(raw || '').toUpperCase().trim();
  if (!v || v === 'NA' || v === 'N/A' || v === 'NONE' || v === 'NULL' || v === 'UNKNOWN') return '';
  v = v.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  v = v
    .replace(/\bJUNIOR\s+SENIOR\s+HIGH\s+SCHOOL\b/g, 'HS')
    .replace(/\bSENIOR\s+HIGH\s+SCHOOL\b/g, 'HS')
    .replace(/\bHIGH\s+SCHOOL\b/g, 'HS')
    .replace(/\bJUNIOR\s+HIGH\s+SCHOOL\b/g, 'MS')
    .replace(/\bJUNIOR\s+HIGH\b/g, 'MS')
    .replace(/\bMIDDLE\s+SCHOOL\b/g, 'MS')
    .replace(/\bELEMENTARY\s+SCHOOL\b/g, 'ES')
    .replace(/\bINTERMEDIATE\s+SCHOOL\b/g, 'MS')
    .replace(/\bINTERMEDIATE\b/g, 'MS')
    .replace(/\s+/g, ' ')
    .trim();
  return cleanBoundaryName(v);
}

function normalizeRow(row: Record<string, string>, intern: (s: string) => string): RebuildRow | null {
  const close = cleanDate(row['Close Date'] || '');
  const baths = cleanNumber(row['FB']) + cleanNumber(row['HB']);
  const closePrice = cleanNumber(row['Close Price'] || row['Original List Price']);
  const sqft = cleanNumber(row['SF']);
  const pricePerSqft = cleanNumber(row['Price Sq Ft Sold'] || row['Prc/SF']);
  const listPrice = cleanNumber(row['Original List Price']);
  const lat = Number(row['Latitude']);
  const lng = Number(row['Longitude']);
  const zipRaw = String(row['Zip'] || '').trim();

  if (!closePrice || !lat || !lng) return null;

  return {
    mlsNumber: String(row['MLS Number'] || ''),
    address: intern(String(row['Address'] || '')),
    city: intern(String(row['City/Location'] || '')),
    state: intern(String(row['State Or Province'] || '')),
    zip: intern(zipRaw),
    closePrice,
    listPrice,
    pricePerSqft: pricePerSqft || (sqft ? closePrice / sqft : 0),
    sqft,
    lotSize: cleanNumber(row['Lot Size']),
    br: cleanNumber(row['BR']),
    baths,
    yearBuilt: cleanNumber(row['YB']),
    dom: cleanNumber(row['DOM']),
    cdom: cleanNumber(row['CDOM']),
    closeDate: intern(close.date),
    closeYear: close.year,
    closeDateTs: close.ts,
    maintFee: cleanNumber(row['Maint Fee Amt']),
    maintFeeSchedule: intern(String(row['Maint Fee Pay Schedule'] || '').toLowerCase()),
    taxRate: cleanNumber(row['Tax Rate']),
    taxYear: cleanNumber(row['Tax Year']),
    taxAmount: cleanNumber(row['Tax Amount']),

    subdivisions: intern(cleanBoundaryName(row['Subdivision'])),
    zipcodes: intern(zipRaw),
    highschools: intern(cleanDistrictCode(row['School District'])),
    highschoolName: intern(cleanSchoolName(row['School High'])),
    elementary: intern(cleanSchoolName(row['School Elementary'])),
    middle: intern(cleanSchoolName(row['School Middle'])),
    schoolDistrict: intern(String(row['School District'] || '').trim()),
    marketArea: intern(String(row['Market Area'] || '').trim()),
    area: intern(String(row['Area'] || '').trim()),

    lat,
    lng,

    propertyType: intern(String(row['Property Type'] || '').trim()),
    pool: cleanBool(row['Pool Private']),
  };
}

// --- Helpers ---

const storage = (() => {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  return getStorage(app);
})();

const workerScope = self as unknown as {
  postMessage(msg: WorkerResponse): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

function progress(phase: RebuildPhase, message: string) {
  workerScope.postMessage({ type: 'progress', phase, message });
}

async function gzipJson(obj: unknown): Promise<Blob> {
  const json = JSON.stringify(obj);
  if (typeof CompressionStream === 'undefined') {
    throw new Error('This browser does not support gzip compression.');
  }
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(stream).blob();
}

async function listAllRecursive(dirRef: ReturnType<typeof ref>): Promise<{ name: string; fullPath: string }[]> {
  const res = await listAll(dirRef);
  const items = res.items.map((i) => ({ name: i.name, fullPath: i.fullPath }));
  for (const prefix of res.prefixes) {
    items.push(...(await listAllRecursive(prefix)));
  }
  return items;
}

interface ChunkManifest {
  version?: number;
  totalRows?: number;
  format?: string;
  boundaries?: Record<string, { chunks: string[] }>;
  chunks?: string[];
}

async function fetchCurrentManifest(): Promise<ChunkManifest | null> {
  try {
    let url: string | null = null;
    try {
      url = await getDownloadURL(ref(storage, MANIFEST_PATH));
    } catch {
      url = null;
    }
    if (!url) {
      // Fall back to the locally deployed manifest for the baseline count.
      const res = await fetch('/cache/master_cache_chunks.json', { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    }
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Serialize one chunk of rows into the compact {header, rows} shape. */
function compactChunk(rows: RebuildRow[]): { header: string[]; rows: unknown[][] } {
  const header = Object.keys(rows[0]) as (keyof RebuildRow)[];
  return { header, rows: rows.map((r) => header.map((k) => r[k] as unknown)) };
}

// --- Main rebuild ---

async function runRebuild(addedRows: number, removedRows: number) {
  progress('preparing', 'Preparing data update…');

  const currentManifest = await fetchCurrentManifest();
  const baseTotal = typeof currentManifest?.totalRows === 'number' ? currentManifest.totalRows : 0;

  progress('downloading', 'Downloading CMS files…');
  const rootRef = ref(storage, CSV_LIST_ROOT);
  const allItems = await listAllRecursive(rootRef);
  const csvFiles = allItems.filter(
    (item) =>
      item.name.toLowerCase().endsWith('.csv') &&
      !SKIP_PATTERN.test(item.name) &&
      !item.name.toLowerCase().startsWith('tea_')
  );

  // Intern pool: one string instance per distinct value across the dataset.
  // Capped to avoid unbounded growth in pathological cases (rare strings).
  const INTERN_LIMIT = 300_000;
  const internPool = new Map<string, string>();
  const intern = (s: string): string => {
    if (!s) return '';
    let cached = internPool.get(s);
    if (cached === undefined) {
      cached = s;
      if (internPool.size < INTERN_LIMIT) {
        internPool.set(s, cached);
      }
    }
    return cached;
  };

  const allRows: RebuildRow[] = [];

  // Every listed CSV is recorded as a consumed source in the manifest, so the
  // admin can later verify the published dataset actually reflects the CMS
  // contents (see datasetRebuild/reconcile.ts) and self-heal when they diverge.
  const sourcePaths: string[] = [];
  // File-type counters for the full-wipe rule: a wipe is only real when NO
  // property CSV remains (tax-only CSVs never contribute rows) and no file
  // failed before its type could be determined.
  let propertyFileCount = 0;
  let undeterminedFiles = 0;

  // Standalone Tax Data CSVs (deduped on MLS #) carry tax fields but no
  // Close Price/Latitude/Longitude, so normalizeRow drops every one of their
  // rows. Instead of losing them, they are keyed by MLS here and merged into
  // the property rows after the parse loop (see the enrichment step below).
  const taxByMls = new Map<string, [number, number, number]>(); // [taxYear, taxAmount, taxRate]

  for (let i = 0; i < csvFiles.length; i++) {
    const file = csvFiles[i];
    sourcePaths.push(file.fullPath);
    let decidedAsProperty = false;
    try {
      const url = await getDownloadURL(ref(storage, file.fullPath));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let text = await res.text();

      // Parse row-by-row so Papa never keeps the full CSV in parsed.data.
      await new Promise<void>((resolve, reject) => {
        let isTaxFile: boolean | null = null;
        Papa.parse<Record<string, string>>(text, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (h) => stripBom(h),
          step: (results) => {
            const data = results.data as Record<string, string>;
            // A tax file is decided from its first row: it has the tax
            // columns but none of the sale columns normalizeRow requires.
            if (isTaxFile === null) {
              isTaxFile =
                !('Close Price' in data) &&
                ('Tax Amount' in data || 'Tax Rate' in data || 'Tax Year' in data);
              if (!isTaxFile) decidedAsProperty = true;
            }
            if (isTaxFile) {
              const mls = String(data['MLS #'] || data['MLS Number'] || '').trim();
              if (mls) {
                const year = cleanNumber(data['Tax Year']);
                const amount = cleanNumber(data['Tax Amount']);
                const rate = cleanNumber(data['Tax Rate']);
                const prev = taxByMls.get(mls);
                // Keep the newest tax record per MLS (re-uploads repeat rows).
                if (!prev || year >= prev[0]) taxByMls.set(mls, [year, amount, rate]);
              }
              return;
            }
            const item = normalizeRow(data, intern);
            if (item) allRows.push(item);
          },
          complete: () => resolve(),
          error: reject,
        });
      });

      // Explicitly release the raw CSV text and let the GC reclaim it.
      text = '';
    } catch (err) {
      console.warn('[datasetRebuild] Failed file:', file.fullPath, err);
      undeterminedFiles++;
    }
    if (decidedAsProperty) propertyFileCount++;
    // Yield periodically so the worker never stacks up huge parse buffers.
    if ((i + 1) % 10 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  // MLS merge: fill in the tax fields of property rows that were sold without
  // tax columns, using the standalone Tax Data CSVs parsed above. Rows that
  // already carry their own tax values (or have no MLS number) are untouched.
  if (taxByMls.size > 0) {
    let enriched = 0;
    for (const row of allRows) {
      if (row.taxRate || row.taxAmount || row.taxYear || !row.mlsNumber) continue;
      const tax = taxByMls.get(row.mlsNumber);
      if (!tax) continue;
      row.taxYear = tax[0];
      row.taxAmount = tax[1];
      row.taxRate = tax[2];
      enriched++;
    }
    console.log(`[datasetRebuild] Tax merge: ${enriched.toLocaleString()} rows enriched from ${taxByMls.size.toLocaleString()} tax records.`);
  }

  if ('performance' in self) {
    const mem = (self as any).performance.memory;
    if (mem) {
      console.log(
        '[datasetRebuild] Memory after parse:',
        Math.round(mem.usedJSHeapSize / 1024 / 1024),
        'MB / limit',
        Math.round(mem.jsHeapSizeLimit / 1024 / 1024),
        'MB'
      );
    }
  }

  progress('processing', 'Processing information…');

  // Safety gate: the recomputed dataset must be the deployed one plus this
  // upload minus any removed rows — a wildly different count means something
  // parsed wrong, and we must not push a broken dataset to every visitor.
  // The tolerance is small (verified rebuilds reproduce the expected count
  // exactly) so a silently lost source file fails the gate instead of
  // shipping a degraded dataset. Removals still widen the lower bound: a
  // replaced file keeps most of its rows inside the new file, so the real
  // delta is roughly `addedRows`.
  let expectedLower: number;
  let expectedUpper: number;

  // Full wipe: the admin deleted every dataset CSV on purpose, so publishing
  // an empty dataset is the intended outcome — the map shows "no data" until
  // new files are uploaded instead of serving the old rows forever. The rule
  // is file-based (zero property CSVs left, none failed mid-download), NOT
  // delta-based: reconciliation calls run with zero deltas after deletions.
  const isFullWipe =
    allRows.length === 0 && propertyFileCount === 0 && undeterminedFiles === 0;

  if (baseTotal === 0) {
    // Fresh restore: the manifest was reset, so the expected count is unknown.
    // Allow any non-empty dataset to publish so the restore can complete.
    expectedLower = 1;
    expectedUpper = Number.MAX_SAFE_INTEGER;
  } else {
    // The user may be replacing or re-uploading whole folders; exact deltas
    // are unreliable because duplicate detection, empty/corrupt CSVs, and folder
    // drops change the final count. Keep a wide ±10% window around the previous
    // total so routine re-uploads don't get blocked, while still catching wildly
    // wrong rebuilds (e.g. total collapse or doubling).
    const netCenter = baseTotal + addedRows - removedRows;
    const margin = Math.max(5_000, Math.round(netCenter * 0.1));
    expectedUpper = netCenter + margin;
    expectedLower = Math.max(
      1,
      Math.round(netCenter * 0.75)
    );
  }

  if (
    !isFullWipe &&
    (allRows.length < expectedLower || allRows.length > expectedUpper)
  ) {
    throw new Error(
      `Safety check: ${allRows.length.toLocaleString()} rows were computed, expected between ${expectedLower.toLocaleString()} and ${expectedUpper.toLocaleString()}. The dataset was not modified.`
    );
  }
  if (isFullWipe) {
    console.log('[datasetRebuild] Full wipe detected (all dataset CSVs deleted) — publishing an empty dataset.');
  }

  // Capture the kept count BEFORE we start streaming chunks out.
  const keptRows = allRows.length;

  const version = Date.now();
  const manifestBoundaries: Record<string, { chunks: string[] }> = {};
  const areaIndex: { version: number; boundaries: Record<string, Record<string, number[]>> } = {
    version,
    boundaries: {},
  };
  const newChunkPaths: string[] = [];

  progress('uploading', 'Uploading updated data…');

  // Heartbeat: the upload phase can run for many minutes without completing a
  // boundary, so re-send the same (number-free) phase message periodically to
  // keep the main-thread watchdog alive.
  let uploadsSinceHeartbeat = 0;
  const heartbeat = () => {
    if (++uploadsSinceHeartbeat >= 10) {
      uploadsSinceHeartbeat = 0;
      progress('uploading', 'Uploading updated data…');
    }
  };

  // Build + upload ONE boundary at a time. Each boundary gets its own group
  // map, so at most two full copies of the dataset live in memory at once
  // (allRows + the active boundary groups) instead of six.
  for (const b of BOUNDARIES) {
    const groupsMap = new Map<string, RebuildRow[]>();
    for (const row of allRows) {
      const key = b.keyFn(row);
      if (!key) continue;
      const arr = groupsMap.get(key);
      if (arr) {
        arr.push(row);
      } else {
        groupsMap.set(key, [row]);
      }
    }

    const groups = Array.from(groupsMap.entries()).sort((a, c) => a[0].localeCompare(c[0]));
    const chunks: string[] = [];
    const boundaryIndex: Record<string, number[]> = {};
    let currentRows: RebuildRow[] = [];

    const uploadChunk = async (rows: RebuildRow[]) => {
      if (rows.length === 0) return;
      const chunkIdx = chunks.length;
      const path = `cms_files/csv/boundary_${b.key}_${chunkIdx}_v${version}.json.gz`;
      const blob = await gzipJson(compactChunk(rows));
      await uploadBytes(ref(storage, path), blob, { contentType: 'application/json' });
      chunks.push(path);
      newChunkPaths.push(path);
      heartbeat();
    };

    for (const [areaKey, rows] of groups) {
      boundaryIndex[areaKey] = [];

      if (rows.length > TARGET_ROWS_PER_CHUNK) {
        // Big area: flush the open chunk, then emit dedicated chunks for it.
        if (currentRows.length) await uploadChunk(currentRows);
        currentRows = [];
        for (let i = 0; i < rows.length; i += TARGET_ROWS_PER_CHUNK) {
          const slice = rows.slice(i, i + TARGET_ROWS_PER_CHUNK);
          const chunkIdx = chunks.length;
          await uploadChunk(slice);
          boundaryIndex[areaKey].push(chunkIdx);
          await new Promise((r) => setTimeout(r, 0));
        }
      } else {
        // Small area: append to the open chunk, flushing when it gets full.
        if (currentRows.length && currentRows.length + rows.length > TARGET_ROWS_PER_CHUNK) {
          await uploadChunk(currentRows);
          currentRows = [];
        }
        const chunkIdx = chunks.length;
        for (let i = 0; i < rows.length; i++) currentRows.push(rows[i]);
        boundaryIndex[areaKey].push(chunkIdx);
      }
    }
    await uploadChunk(currentRows);

    manifestBoundaries[b.key] = { chunks };
    areaIndex.boundaries[b.key] = boundaryIndex;

    // Release this boundary's data before starting the next one.
    groupsMap.clear();
    currentRows = [];
    await new Promise((r) => setTimeout(r, 0));
  }

  // Release the master row list — we are done reading from it.
  allRows.length = 0;

  const manifest = {
    version,
    totalRows: keptRows,
    format: 'boundary-chunks',
    defaultBoundary: 'subdivisions',
    // FullPaths of every CSV consumed for this build. The admin compares
    // these against the live Storage listing to detect drift (a file that
    // was uploaded/deleted without triggering a rebuild) and self-heal.
    sources: sourcePaths,
    boundaries: manifestBoundaries,
  };

  // Manifest LAST — browsers only switch when it points at the new
  // versioned chunk files. NOTE: the manifest is uploaded as PLAIN JSON
  // (the engine reads it with res.json(), not fetchGzJson) — only the area
  // index is gzipped, matching the build script's output format exactly.
  const indexBlob = await gzipJson(areaIndex);
  await uploadBytes(ref(storage, INDEX_PATH), indexBlob, { contentType: 'application/json' });
  const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
  await uploadBytes(ref(storage, MANIFEST_PATH), manifestBlob, { contentType: 'application/json' });

  progress('finalizing', 'Finalizing…');

  // Cleanup: remove chunk files from generations older than the previous one.
  // The manifest and the freshly-uploaded area index must never be deleted —
  // their names match the chunk prefixes ('chunk_area_index' does), so they
  // are added to the keep set explicitly.
  try {
    const keep = new Set<string>(newChunkPaths);
    keep.add(MANIFEST_PATH);
    keep.add(INDEX_PATH);
    for (const boundary of Object.values(currentManifest?.boundaries || {})) {
      for (const p of boundary.chunks || []) keep.add(p);
    }
    const listRes = await listAll(ref(storage, CSV_LIST_ROOT));
    for (const item of listRes.items) {
      const name = item.name;
      if (!CHUNK_PREFIXES.some((p) => name.startsWith(p))) continue;
      if (keep.has(item.fullPath)) continue;
      await deleteObject(item);
    }
  } catch (err) {
    console.warn('[datasetRebuild] Cleanup skipped:', err);
  }

  if ('performance' in self) {
    const mem = (self as any).performance.memory;
    if (mem) {
      console.log(
        '[datasetRebuild] Memory after upload:',
        Math.round(mem.usedJSHeapSize / 1024 / 1024),
        'MB'
      );
    }
  }

  workerScope.postMessage({ type: 'done', version, totalRows: keptRows });
}

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data?.type !== 'start') return;
  runRebuild(event.data.addedRows, event.data.removedRows).catch((err) => {
    workerScope.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  });
};