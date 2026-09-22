import Papa from 'papaparse';
import { cmsStore, type CMSMetricOverride, type CMSPropertyOverride } from './cmsStore';
import { cacheVersionFor, readDatasetCache, writeDatasetCache } from './csvCache';
import { ref, getDownloadURL } from 'firebase/storage';
import { storage } from './firebase';
import * as core from './engineCore';
import type { DataSourcePlan } from './engineWorker/protocol';
import { isSQLEnabled } from './sqlData';
import { resolveSqlDatasetVersion } from './sqlSync';

// Re-export the pure core (types + helpers + aggregation math) so every
// existing `from '@/lib/engine'` import keeps working.
export * from './engineCore';

export interface ChunkAreaIndex {
  version: number;
  boundaries: Partial<Record<core.BoundaryKey, Record<string, number[]>>>;
}

export class RealEstateEngine {
  /**
   * Max rows kept in RAM, derived from the device's RAM (navigator.deviceMemory).
   * The full ~763k-row dataset needs ~0.5 GB of JS heap just for the rows — on
   * machines with 4 GB (or less) of total RAM that is an instant
   * "Out of Memory" tab crash. We keep a deterministic uniform sample instead:
   * every row is kept/dropped by a hash of its MLS number, so the sample is
   * stable across reloads and medians/averages stay statistically valid.
   */
  private memoryRowCap(): number {
    try {
      const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
      if (!mem || mem <= 0) return 250000; // unknown device — stay safe
      if (mem <= 2) return 100000; // <2 GB machines
      if (mem <= 4) return 180000; // 4 GB machines
      return Infinity; // 8+ GB — keep the full dataset
    } catch {
      return 250000;
    }
  }

  public data: core.PropertyData[] = [];
  public isLoaded = false;
  /** True once the complete dataset (all chunks) is in memory, not a selection subset. */
  private fullDatasetLoaded = false;
  public dataQuality: core.DataQualitySummary = {
    totalRowsRead: 0,
    keptRows: 0,
    missingZip: 0,
    missingCoordinates: 0,
    missingPrice: 0,
    uniqueZips: 0,
  };
  private etaScoreCache: Record<string, Record<string, number>> = {};
  private teaScores: core.TeaScoreMap = {
    elementary: {},
    middle: {},
    high: {},
  };
  private cmsOverrides: CMSMetricOverride[] = [];
  private loadingPromise: Promise<{ ok: boolean; error?: string; count: number }> | null = null;

  // Inverted index built at build time: boundary -> areaKey -> chunk indices.
  // Lets us fetch only the CSV chunks that contain selected areas when
  // generating a report, keeping initial page load tiny and memory low.
  private chunkAreaIndex: ChunkAreaIndex | null = null;

  private normalizeRows(rows: any[], quality: core.DataQualitySummary, zipSet: Set<string>): core.PropertyData[] {
    return core.normalizeRows(rows as Record<string, unknown>[], quality, zipSet);
  }

  private buildRowFromOverride(o: CMSPropertyOverride, base?: core.PropertyData): Record<string, string> {
    const row: Record<string, string> = {};
    if (base) {
      row['MLS Number'] = base.mlsNumber;
      row['Address'] = base.address;
      row['City/Location'] = base.city;
      row['State Or Province'] = base.state;
      row['Zip'] = base.zip;
      row['Latitude'] = String(base.lat);
      row['Longitude'] = String(base.lng);
      row['Subdivision'] = base.subdivisions;
      row['School District'] = base.schoolDistrict;
      row['School High'] = base.highschoolName;
      row['School Elementary'] = base.elementary;
      row['School Middle'] = base.middle;
      row['Market Area'] = base.marketArea;
      row['Area'] = base.area;
      row['Property Type'] = base.propertyType;
      row['Pool Private'] = base.pool ? 'yes' : 'no';
      row['Close Price'] = String(base.closePrice);
      row['Original List Price'] = String(base.listPrice);
      row['Price Sq Ft Sold'] = String(base.pricePerSqft);
      row['Prc/SF'] = String(base.pricePerSqft);
      row['SF'] = String(base.sqft);
      row['Lot Size'] = String(base.lotSize);
      row['BR'] = String(base.br);
      const fb = Math.floor(base.baths);
      const hb = Math.round((base.baths - fb) * 10);
      row['FB'] = String(fb);
      row['HB'] = String(hb);
      row['YB'] = String(base.yearBuilt);
      row['DOM'] = String(base.dom);
      row['CDOM'] = String(base.cdom);
      row['Close Date'] = base.closeDate;
      row['Maint Fee Amt'] = String(base.maintFee);
      row['Maint Fee Pay Schedule'] = base.maintFeeSchedule;
      row['Tax Rate'] = String(base.taxRate);
      row['Tax Year'] = String(base.taxYear);
      row['Tax Amount'] = String(base.taxAmount);
    }
    // Override / creation fields use the original CSV header names.
    Object.entries(o.fields).forEach(([label, value]) => {
      if (value !== '' && value != null) row[label] = value;
    });
    return row;
  }

  private applyPropertyOverrides(overrides: CMSPropertyOverride[], quality: core.DataQualitySummary) {
    const keyFor = (d: core.PropertyData) => d.mlsNumber || `${d.address}|${d.zip}`;

    overrides.forEach((o) => {
      const target = this.data.find(
        (d) =>
          (o.mlsNumber && d.mlsNumber === o.mlsNumber) ||
          (o.address && o.zip && d.address === o.address && d.zip === o.zip)
      );

      const isCreate = o.mode === 'create';
      if (!target && !isCreate) {
        console.warn('[Kwizi] Property override has no matching static row:', o.address, o.zip);
        return;
      }

      if (isCreate && (!o.fields['Address'] || !o.fields['Zip'] || !o.fields['Latitude'] || !o.fields['Longitude'])) {
        console.warn('[Kwizi] Create-mode override missing required address/coordinates:', o.id);
        return;
      }

      quality.totalRowsRead++;
      const row = this.buildRowFromOverride(o, target);
      const items = core.normalizeRows([row], quality, new Set<string>());
      if (items.length) {
        const item = items[0];
        const k = keyFor(item);
        this.data = this.data.filter((d) => keyFor(d) !== k);
        this.data.push(item);
        quality.keptRows++;
      } else {
        console.warn('[Kwizi] Override row was dropped (missing required price/coords):', row['Address'], row['Zip']);
      }
    });

    quality.uniqueZips = new Set(this.data.map((d) => d.zip).filter(Boolean)).size;
  }

  public async reloadFromCMS() {
    await this.loadAllCSV(true);
  }

  /**
   * Resolve where the aggregation worker should fetch the dataset from.
   * Returns null when no chunked manifest is available — the caller then has
   * to fall back to the main-thread engine paths (master file / manifest).
   *
   * SQL-first mode: the map never downloads chunks, so the "plan" is just a
   * version marker taken from the Firestore sync state. The Storage manifest
   * is intentionally ignored because CSV files no longer live there.
   */
  public async resolveDataSource(): Promise<DataSourcePlan | null> {
    if (isSQLEnabled()) {
      const sqlVersion = await resolveSqlDatasetVersion();
      if (!sqlVersion) return null;
      return {
        bucket: this.storageBucket,
        chunks: [],
        totalRows: sqlVersion.totalRows,
        version: sqlVersion.version,
      };
    }
    const chunked = await this.findChunkedCache();
    if (!chunked) return null;
    if (chunked.boundaries) {
      return {
        bucket: this.storageBucket,
        boundaries: chunked.boundaries,
        totalRows: chunked.totalRows,
        version: chunked.version ?? 0,
      };
    }
    if (chunked.chunks && chunked.chunks.length) {
      return {
        bucket: this.storageBucket,
        chunks: chunked.chunks,
        totalRows: chunked.totalRows,
        version: chunked.version ?? 0,
      };
    }
    return null;
  }

  /** Single-property CMS overrides (baked into worker rows on load). */
  public async getPropertyOverrideLites(): Promise<core.PropertyOverrideLite[]> {
    try {
      const overrides = await cmsStore.listPropertyOverrides();
      return overrides.map((o) => ({
        id: o.id,
        mlsNumber: o.mlsNumber,
        address: o.address,
        zip: o.zip,
        fields: o.fields,
        mode: o.mode,
      }));
    } catch {
      return [];
    }
  }

  private teaLoadPromise: Promise<void> | null = null;

  /** Load the TEA score maps once (page awaits this before sending them to
   *  the worker so rating filters behave identically to the engine path). */
  public async ensureSchoolRatings(): Promise<void> {
    if (!this.teaLoadPromise) this.teaLoadPromise = this.loadSchoolRatings();
    await this.teaLoadPromise;
  }

  private get storageBucket(): string {
    return process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'myreatstat.firebasestorage.app';
  }

  private directStorageUrl(path: string): string {
    const encoded = encodeURIComponent(path).replace(/%2F/g, '%2F');
    return `https://firebasestorage.googleapis.com/v0/b/${this.storageBucket}/o/${encoded}?alt=media`;
  }

  private async fetchWithTimeout(url: string, timeoutMs = 60000): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeout(id);
      return res;
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  }

  private async loadManifest(): Promise<string[]> {
    try {
      const manifestRef = ref(storage, 'cms_files/csv/property-manifest.json');
      const url = await getDownloadURL(manifestRef);
      const res = await this.fetchWithTimeout(url, 30000);
      if (!res.ok) throw new Error(`Firebase manifest fetch failed: ${res.status}`);
      const data = await res.json();
      console.log('[Kwizi Engine] Loaded manifest from Firebase Storage');
      return data;
    } catch (err) {
      console.warn('[Kwizi] Could not load property manifest from Firebase Storage:', err);
      return [];
    }
  }

  private async getFirebaseDownloadUrl(storagePath: string): Promise<string | null> {
    try {
      const fileRef = ref(storage, storagePath);
      return await getDownloadURL(fileRef);
    } catch {
      return null;
    }
  }

  private async findMasterFile(): Promise<{ url: string; path: string } | null> {
    const candidates = [
      'cms_files/csv/master_cache_slim.csv.gz', // preferred: same data, fewer columns, smaller download
      'cms_files/csv/master_cache.csv.gz',
      'cms_files/csv/master_cache.json.gz',
      'cms_files/master_cache_slim.csv.gz',
      'cms_files/master_cache.csv.gz',
      'cms_files/master_cache.json.gz',
      'cms_files/csv/master_cache.csv',
      'cms_files/master_cache.csv',
      'master_cache/master_cache.json',
      'cms_files/master_cache.json',
    ];
    for (const path of candidates) {
      try {
        // Prefer Firebase SDK signed URL (handles auth), but fall back to direct public URL.
        let url = await this.getFirebaseDownloadUrl(path);
        if (!url) {
          const direct = this.directStorageUrl(path);
          const head = await this.fetchWithTimeout(direct, 10000);
          if (head.ok) url = direct;
        }
        if (url) return { url, path };
      } catch {
        // ignore candidate errors
      }
    }
    return null;
  }

  private async findChunkedCache(): Promise<
    | {
        chunks?: string[];
        boundaries?: Partial<Record<core.BoundaryKey, { chunks: string[] }>>;
        totalRows: number;
        version?: number;
      }
    | null
  > {
    const manifestPath = 'cms_files/csv/master_cache_chunks.json';

    // Firebase Storage is the SINGLE source of truth for the dataset. There is
    // deliberately no build-time /cache snapshot here: a baked-in copy would
    // resurrect rows the admin deleted (a full wipe must stay empty until new
    // files are uploaded), so when Firebase has no manifest there is NO data.
    let manifest: any | null = null;
    try {
      let url = await this.getFirebaseDownloadUrl(manifestPath);
      if (!url) {
        const direct = this.directStorageUrl(manifestPath);
        const head = await this.fetchWithTimeout(direct, 10000);
        if (head.ok) url = direct;
      }
      if (url) {
        const res = await this.fetchWithTimeout(url, 30000);
        if (res.ok) manifest = await res.json();
      }
    } catch {
      manifest = null;
    }
    if (!manifest) return null;
    const version = typeof manifest.version === 'number' ? manifest.version : 0;

    if (manifest.format === 'boundary-chunks' && manifest.boundaries) {
      return {
        boundaries: manifest.boundaries,
        totalRows: manifest.totalRows || 0,
        version,
      };
    }

    if (Array.isArray(manifest.chunks) && manifest.chunks.length > 0) {
      return {
        chunks: manifest.chunks,
        totalRows: manifest.totalRows || 0,
        version,
      };
    }

    return null;
  }

  private async resolveChunkUrl(path: string): Promise<string> {
    let url = await this.getFirebaseDownloadUrl(path);
    if (!url) {
      const direct = this.directStorageUrl(path);
      const head = await this.fetchWithTimeout(direct, 10000);
      if (head.ok) url = direct;
    }
    if (!url) throw new Error(`Could not resolve chunk ${path}`);
    return url;
  }

  private async yieldToMain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  private async loadChunksOnMainThread(
    chunkPaths: string[],
    onProgress?: (loaded: number, total: number) => void,
    rowCap: number = Infinity
  ): Promise<core.PropertyData[]> {
    const ds = (window as any).DecompressionStream as typeof DecompressionStream;
    if (!ds) throw new Error('Browser does not support gzip decompression.');

    const results: core.PropertyData[][] = new Array(chunkPaths.length);
    let completed = 0;
    // Streaming memory-cap state (see the adaptive filter inside the loop).
    let keepFactor = 1;
    let keptRows = 0;

    // Prefetch the NEXT chunk's bytes while the current one is being
    // gunzipped/parsed. Strictly sequential processing left the network idle
    // through the CPU-heavy parse phase; one buffer in flight ahead (~0.7 MB
    // gz) hides that latency. Processing itself stays strictly sequential —
    // the adaptive memory cap depends on it, and several chunks in flight
    // crashed low-RAM (4 GB) machines when this used to run at concurrency 6.
    const fetchChunk = (index: number): Promise<ArrayBuffer | null> => {
      if (index >= chunkPaths.length) return Promise.resolve(null);
      return (async () => {
        try {
          const url = await this.resolveChunkUrl(chunkPaths[index]);
          const res = await this.fetchWithTimeout(url, 120000);
          if (!res.ok) return null;
          return await res.arrayBuffer();
        } catch {
          return null;
        }
      })();
    };

    let inFlight = fetchChunk(0);
    for (let index = 0; index < chunkPaths.length; index++) {
      const bufPromise = inFlight;
      inFlight = fetchChunk(index + 1);
      const buf = await bufPromise;
      if (!buf) throw new Error(`Chunk fetch failed: ${chunkPaths[index]}`);

      // Detect gzip by magic bytes (1f 8b) instead of the old approach of
      // JSON.parse-ing the text as a "validation" — that parsed every
      // non-gzip chunk TWICE, doubling the transient allocation peak.
      const isGzip = buf.byteLength >= 2 && new Uint8Array(buf, 0, 2)[0] === 0x1f && new Uint8Array(buf, 0, 2)[1] === 0x8b;
      let text: string;
      if (isGzip) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(buf));
            controller.close();
          },
        });
        text = await new Response(stream.pipeThrough(new ds('gzip'))).text();
      } else {
        text = new TextDecoder().decode(buf);
      }
      const parsed = JSON.parse(text);
      let rows: core.PropertyData[];
      if (Array.isArray(parsed)) {
        rows = parsed as core.PropertyData[];
      } else if (parsed && parsed.header && parsed.rows) {
        const header = parsed.header as (keyof core.PropertyData)[];
        rows = (parsed.rows as any[]).map((arr) => {
          const obj: any = {};
          header.forEach((key, i) => (obj[key] = arr[i]));
          return obj as core.PropertyData;
        });
      } else {
        throw new Error(`Unrecognized chunk format: ${typeof parsed}`);
      }

      // Adaptive streaming cap: while chunks arrive (processing is strictly
      // sequential, so this loop body is safe), thin the accumulated rows
      // whenever they grow past the device cap. Rows are kept/dropped by a
      // stable hash so the sample is uniform and reproducible.
      if (rowCap !== Infinity) {
        if (keepFactor > 1) {
          rows = rows.filter((r) => core.rowHash(r) % keepFactor === 0);
        }
        keptRows += rows.length;
        if (keptRows > rowCap * 1.15) {
          keepFactor = Math.max(keepFactor, Math.ceil(keptRows / rowCap));
          keptRows = 0;
          for (let i = 0; i < results.length; i++) {
            const arr = results[i];
            if (!arr) continue;
            const filtered = arr.filter((r) => core.rowHash(r) % keepFactor === 0);
            results[i] = filtered;
            keptRows += filtered.length;
          }
          console.log(`[Kwizi Engine] Memory cap: sampling 1-in-${keepFactor} rows (${keptRows.toLocaleString()} kept)`);
        }
      }

      results[index] = rows;
      completed++;
      onProgress?.(completed, chunkPaths.length);
      console.log(`[Kwizi Engine] Loaded chunk ${index + 1}/${chunkPaths.length}: ${rows.length.toLocaleString()} rows`);
      // Yield so React can paint the map (overlay hidden, polygons rendered)
      // while the remaining chunks are still being parsed.
      await this.yieldToMain();
    }

    return results.flat();
  }

  private async loadChunkedCache(
    chunkPaths: string[],
    onProgress?: (loaded: number, total: number) => void,
    rowCap: number = Infinity
  ): Promise<core.PropertyData[]> {
    // The chunks are large (~60 MB raw), and transferring parsed rows back from
    // a Web Worker is slower than parsing on the main thread. We run on the main
    // thread while a tiny pre-computed metric snapshot lets the map render
    // instantly in parallel.
    return this.loadChunksOnMainThread(chunkPaths, onProgress, rowCap);
  }

  private async parseCsvText(text: string): Promise<Record<string, string>[]> {
    const parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
    });
    return parsed.data;
  }

  private async parseGzippedResponse(res: Response): Promise<Record<string, string>[]> {
    if (!res.body) return [];
    const ds = (window as any).DecompressionStream as typeof DecompressionStream;
    if (!ds) {
      throw new Error('This browser does not support gzip decompression (DecompressionStream).');
    }
    const decompressed = res.body.pipeThrough(new ds('gzip'));
    const text = await new Response(decompressed).text();
    return this.parseCsvText(text);
  }

  private async parseMasterResponse(res: Response, url: string): Promise<{ rows?: Record<string, string>[]; normalized?: core.PropertyData[] }> {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('.gz')) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const decompressed = res.body ? await new Response(res.body.pipeThrough(new ((window as any).DecompressionStream as typeof DecompressionStream)('gzip'))).text() : '';
        const json = JSON.parse(decompressed);
        if (Array.isArray(json.data) && json.data.length > 0) {
          const first = json.data[0];
          if (first && typeof first.closePrice === 'number' && typeof first.lat === 'number') {
            return { normalized: json.data as core.PropertyData[] };
          }
        }
        return { rows: [] };
      }
      return { rows: await this.parseGzippedResponse(res) };
    }
    if (pathname.endsWith('.json')) {
      const json = await res.json();
      if (Array.isArray(json.data) && json.data.length > 0) {
        const first = json.data[0];
        if (first && typeof first.closePrice === 'number' && typeof first.lat === 'number') {
          return { normalized: json.data as core.PropertyData[] };
        }
      }
      return { rows: [] };
    }
    return { rows: await this.parseCsvText(await res.text()) };
  }

  /**
   * Load the area -> chunk index generated at build time. Used by
   * loadDataForSelection() to avoid fetching the entire dataset.
   *
   * The index must come from the SAME source that wins the manifest compare:
   * every rebuild reshuffles chunk numbering, so a stale (local) index paired
   * with a fresh (Firebase) manifest would make selection loads fetch the
   * wrong chunks.
   */
  public async loadChunkAreaIndex(): Promise<void> {
    if (this.chunkAreaIndex) return;
    const chunkedCache = await this.findChunkedCache().catch(() => null);

    // Firebase-only: the index must match the manifest that actually loaded,
    // and a build-time local copy could pair a stale index with fresh chunks.
    const candidates: string[] = ['cms_files/csv/chunk_area_index.json.gz'];

    for (const candidate of candidates) {
      try {
        let index: ChunkAreaIndex | null = null;
        const url = await this.resolveChunkUrl(candidate);
        index = await this.fetchGzJson<ChunkAreaIndex>(url);
        if (!index?.boundaries) continue;
        // The index must describe the manifest we actually loaded; otherwise
        // give up on selective loading (empty index = fetch all chunks, which
        // is always correct).
        if (
          typeof chunkedCache?.version === 'number' &&
          chunkedCache.version > 0 &&
          typeof index.version === 'number' &&
          index.version !== chunkedCache.version
        ) {
          console.warn(
            '[Kwizi Engine] Chunk area index version mismatch (index',
            index.version,
            '≠ manifest',
            chunkedCache.version,
            ') — falling back to full chunk loads'
          );
          break;
        }
        this.chunkAreaIndex = index;
        console.log('[Kwizi Engine] Loaded chunk area index', {
          version: index.version,
          boundaries: Object.keys(index.boundaries),
        });
        return;
      } catch {
        continue;
      }
    }
    this.chunkAreaIndex = { version: 0, boundaries: {} };
  }

  /**
   * Return the chunk indices that contain any of the selected area keys for the
   * current boundary. Falls back to all chunks if the index is missing.
   */
  private resolveChunkIndicesForSelection(
    boundary: core.BoundaryKey,
    selectedIds: string[],
    totalChunks: number
  ): number[] {
    const boundaryIndex = this.chunkAreaIndex?.boundaries[boundary];
    if (!boundaryIndex || selectedIds.length === 0) {
      return Array.from({ length: totalChunks }, (_, i) => i);
    }
    const set = new Set<number>();
    for (const id of selectedIds) {
      const indices = boundaryIndex[id];
      if (indices) {
        for (const idx of indices) set.add(idx);
      }
    }
    const result = Array.from(set);
    result.sort((a, b) => a - b);
    return result.length ? result : Array.from({ length: totalChunks }, (_, i) => i);
  }

  /**
   * Load only the CSV chunks that contain properties for the selected areas,
   * then keep just those properties in memory. This keeps initial page load
   * tiny and avoids holding 700k+ rows in memory unless the user asks for a
   * broad report.
   */
  public async loadDataForSelection(
    boundary: core.BoundaryKey,
    selectedIds: string[],
    onProgress?: (loaded: number, total: number) => void
  ): Promise<{ ok: boolean; error?: string; count: number }> {
    if (selectedIds.length === 0) {
      return { ok: false, error: 'No areas selected', count: 0 };
    }

    await this.loadChunkAreaIndex();
    const chunkedCache = await this.findChunkedCache();
    if (!chunkedCache) {
      // No chunked cache available; fall back to the full dataset.
      return this.loadAllCSV(false, onProgress);
    }

    let chunkPaths: string[];
    if (chunkedCache.boundaries) {
      const boundaryInfo = chunkedCache.boundaries[boundary];
      if (!boundaryInfo || !Array.isArray(boundaryInfo.chunks) || boundaryInfo.chunks.length === 0) {
        // An empty published dataset (admin wiped every CSV) is a valid
        // 0-row selection, not an error — the report must still generate and
        // show its "no data" state. Same for a boundary with zero coverage.
        console.log(`[Kwizi Engine] No chunks for boundary ${boundary} — report runs with 0 rows.`);
        return { ok: true, count: 0 };
      }
      chunkPaths = boundaryInfo.chunks;
    } else {
      chunkPaths = chunkedCache.chunks || [];
      if (chunkPaths.length === 0) {
        console.log('[Kwizi Engine] Published dataset has no chunks — report runs with 0 rows.');
        return { ok: true, count: 0 };
      }
    }

    // If the full dataset is already in memory (background load), the selected
    // areas' rows are already part of it — skip the chunk re-load entirely.
    // Reports scope themselves via getStatsForSelection(..., selectedIds), and
    // keeping the full data here is what keeps every non-selected area colored
    // on the map instead of wiping it when the report renders.
    if (this.fullDatasetLoaded) {
      console.log('[Kwizi Engine] Full dataset already in memory — skipping selection chunk load');
      return { ok: true, count: this.data.length };
    }

    const totalChunks = chunkPaths.length;
    const indices = this.resolveChunkIndicesForSelection(boundary, selectedIds, totalChunks);
    const selectedPaths = indices.map((i) => chunkPaths[i]);

    console.log(
      `[Kwizi Engine] Loading ${selectedPaths.length}/${totalChunks} chunks for ${selectedIds.length} selected ${boundary} areas`
    );
    onProgress?.(0, selectedPaths.length);

    try {
      const rows = await this.loadChunkedCache(selectedPaths, onProgress);
      const selectedSet = new Set(selectedIds);
      const filtered = rows.filter((d) => selectedSet.has(this.getBoundaryKey(boundary, d)));

      this.data = filtered;
      this.isLoaded = true;

      // Run post-load steps (overrides, school ratings) in the background.
      // Selection data is never persisted anywhere.
      this.applyPostLoadSteps(
        {
          totalRowsRead: filtered.length,
          keptRows: filtered.length,
          missingZip: 0,
          missingCoordinates: 0,
          missingPrice: 0,
          uniqueZips: new Set(filtered.map((d) => d.zip)).size,
        },
        new Set(filtered.map((d) => d.zip))
      ).catch((err) => console.error('[Kwizi] Post-load steps failed for selection:', err));

      console.log(`[Kwizi Engine] Loaded ${filtered.length} properties for selection`);
      return { ok: filtered.length > 0, count: filtered.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Kwizi Engine] Failed to load selection data:', err);
      return { ok: false, error: message, count: 0 };
    }
  }

  public async loadAllCSV(
    forceRefresh = false,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<{ ok: boolean; error?: string; count: number }> {
    // Only a completed FULL load makes this early return: a selection load
    // also sets isLoaded, but its data is a subset — retrying must reload.
    if (this.fullDatasetLoaded && !forceRefresh) return { ok: true, count: this.data.length };
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      // 1. Decide the data source: chunked JSON cache, single master file, or the individual manifest.
      const chunkedCache = await this.findChunkedCache();
      const masterFile = chunkedCache ? null : await this.findMasterFile();
      let masterUrl: string | null = masterFile?.url || null;
      let manifestPaths: string[] | null = null;

      if (!masterUrl && !chunkedCache) {
        manifestPaths = await this.loadManifest();
      }

      const cacheVersionUrls = chunkedCache
        ? [
            // The URL string alone never changed, so an IndexedDB cache restored
            // stale rows forever after a CMS rebuild. Baking the manifest's
            // version timestamp into the key invalidates the cache exactly
            // when the CMS dataset is newer (and stays stable across reloads
            // when it isn't).
            'cms_files/csv/master_cache_chunks.json',
            `version:${chunkedCache.version ?? 'unknown'}`,
          ]
        : masterFile?.path
        ? [masterFile.path]
        : (manifestPaths || []);
      const version = await cacheVersionFor(cacheVersionUrls);

      // Version-keyed row cache. The manifest is always fetched no-store, so
      // its version is trustworthy: a newer CMS publish is always a cache
      // miss → fresh download. The row count is validated against the
      // manifest's totalRows as a second guard.
      const datasetVersion = chunkedCache?.version ?? 0;
      if (!forceRefresh && datasetVersion) {
        try {
          const cached = await readDatasetCache<core.PropertyData[]>(datasetVersion);
          if (cached && cached.length > 0 && (chunkedCache!.totalRows === 0 || cached.length === chunkedCache!.totalRows)) {
            // An old cache may hold the full 763k rows — trimming BEFORE the
            // interning pass keeps both the peak and the steady state low.
            const trimmed = core.subsampleRows(cached, this.memoryRowCap());
            core.internStrings(trimmed);
            this.data = trimmed;
            this.isLoaded = true;
            this.fullDatasetLoaded = true;
            console.log('[Kwizi Engine] Restored', cached.length, 'properties from version cache (v' + datasetVersion + ')');
            // CMS overrides (area metrics + single-property edits) must also
            // reach the map on the cached path — without this, a cache restore
            // silently dropped every CMS edit.
            await this.applyCmsOverrides();
            this.ensureSchoolRatings().catch(() => {});
            return { ok: true, count: cached.length };
          }
        } catch (err) {
          console.warn('[Kwizi] Failed to read version cache:', err);
        }
      }

      const quality: core.DataQualitySummary = {
        totalRowsRead: 0,
        keptRows: 0,
        missingZip: 0,
        missingCoordinates: 0,
        missingPrice: 0,
        uniqueZips: 0,
      };
      const zipSet = new Set<string>();
      let allItems: core.PropertyData[] = [];
      let loadError: string | undefined;
      // True when the published dataset is legitimately EMPTY (the admin wiped
      // every CSV, or nothing was ever published and no fallback file exists).
      // That is a successful 0-row load — treating it as an error used to drop
      // the map onto the stale baked static snapshot and resurrect deleted data.
      let emptyPublished = false;

      // 3. Load from the chunked JSON cache (fastest path: skip CSV parse/normalize).
      if (chunkedCache) {
        let fullLoadPaths: string[] = [];
        if (chunkedCache.boundaries) {
          // The per-boundary format partitions rows by area. Loading all chunks for
          // the default boundary gives us the full dataset exactly once.
          const defaultInfo = chunkedCache.boundaries['subdivisions'];
          if (defaultInfo) fullLoadPaths = defaultInfo.chunks;
        } else {
          fullLoadPaths = chunkedCache.chunks || [];
        }

        if (fullLoadPaths.length === 0) {
          console.log('[Kwizi Engine] Published dataset is empty (0 chunks) — loading 0 rows.');
          emptyPublished = true;
        } else {
          console.log(`[Kwizi Engine] Loading ${fullLoadPaths.length} pre-normalized JSON chunks`);
          onProgress?.(0, fullLoadPaths.length);
          try {
            allItems = await this.loadChunkedCache(fullLoadPaths, onProgress, this.memoryRowCap());
            console.log(`[Kwizi Engine] Restored ${allItems.length} properties from chunked JSON cache`);
          } catch (err) {
            loadError = err instanceof Error ? err.message : String(err);
            console.error('[Kwizi] Failed to load chunked JSON cache, will fall back:', err);
            allItems = [];
          }
        }
      }

      // 4. Load from the single Firebase master file if chunked cache is unavailable/failed.
      if (allItems.length === 0 && masterUrl) {
        console.log('[Kwizi Engine] Loading master file from Firebase Storage');
        onProgress?.(0, 1);
        try {
          const res = await this.fetchWithTimeout(masterUrl, 120000);
          if (!res.ok) throw new Error(`Master fetch failed: ${res.status}`);
          const parsed = await this.parseMasterResponse(res, masterUrl);
          if (parsed.normalized) {
            allItems = parsed.normalized;
            onProgress?.(1, 1);
            console.log(`[Kwizi Engine] Restored ${allItems.length} normalized properties from master JSON`);
          } else if (parsed.rows) {
            const rows = parsed.rows;
            quality.totalRowsRead += rows.length;
            const newItems = this.normalizeRows(rows, quality, zipSet);
            quality.keptRows += newItems.length;
            allItems = newItems;
            onProgress?.(1, 1);
            console.log(`[Kwizi Engine] Parsed ${rows.length} rows from master CSV (${newItems.length} kept)`);
          }
        } catch (err) {
          loadError = err instanceof Error ? err.message : String(err);
          console.error('[Kwizi] Failed to load master file, will fall back to manifest:', err);
          allItems = [];
          masterUrl = null;
        }
      }

      // 5. Fallback: download individual CSVs from the Firebase Storage manifest.
      if (!masterUrl && manifestPaths) {
        const bucket = this.storageBucket;
        const firebaseUrls = manifestPaths
          .filter((p) => p.toLowerCase().endsWith('.csv'))
          .map((p) =>
            `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/cms_files%2Fcsv%2F${encodeURIComponent(p)}?alt=media`
          );

        if (firebaseUrls.length > 0) {
          console.log(`[Kwizi Engine] No master file, downloading ${firebaseUrls.length} CSVs from Firebase Storage...`);
          const chunkArray = <T, >(arr: T[], size: number): T[][] =>
            Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
          const urlChunks = chunkArray(firebaseUrls, 10);
          let loadedFiles = 0;
          for (const chunk of urlChunks) {
            await Promise.all(
              chunk.map(async (url) => {
                try {
                  const res = await this.fetchWithTimeout(url, 60000);
                  if (!res.ok) return;
                  const rows = await this.parseCsvText(await res.text());
                  quality.totalRowsRead += rows.length;
                  const newItems = this.normalizeRows(rows, quality, zipSet);
                  quality.keptRows += newItems.length;
                  allItems.push(...newItems);
                  loadedFiles++;
                  onProgress?.(loadedFiles, firebaseUrls.length);
                } catch (err) {
                  console.error('Error loading CSV chunk:', url, err);
                }
              })
            );
          }
          if (allItems.length === 0 && !loadError) {
            loadError = 'No CSV files could be loaded from Firebase Storage.';
          }
        }
      }

      // Nothing published at all (no chunked manifest, no master file, no CSV
      // manifest): that is an empty dataset, not a failure — the CMS decides
      // what exists, and right now it says there is no data.
      if (
        !chunkedCache &&
        !masterUrl &&
        allItems.length === 0 &&
        !loadError &&
        !(manifestPaths && manifestPaths.some((p) => p.toLowerCase().endsWith('.csv')))
      ) {
        emptyPublished = true;
      }

      // Safety net for the master/manifest paths (the chunked path caps
      // during load): never hold more than the device can survive.
      allItems = core.subsampleRows(allItems, this.memoryRowCap());
      core.internStrings(allItems);
      this.data = allItems;
      // An empty published dataset counts as a completed full load, so the UI
      // shows "no data" instead of retrying the network on every mount.
      if (allItems.length > 0 || emptyPublished) this.fullDatasetLoaded = true;
      // Version-keyed cache write — only a COMPLETE dataset (count matching
      // the manifest) may be stored under the dataset version, so a
      // memory-capped load can never poison the cache.
      if (datasetVersion && allItems.length > 0 && (chunkedCache!.totalRows === 0 || allItems.length === chunkedCache!.totalRows)) {
        writeDatasetCache(datasetVersion, allItems).catch(() => {});
      }
      // Start post-load work in the background; the UI can render as soon as
      // the data is in memory. applyPostLoadSteps sets this.isLoaded = true.
      this.applyPostLoadSteps(quality, zipSet).catch((err) =>
        console.error('[Kwizi] Post-load steps failed:', err)
      );
      return { ok: this.data.length > 0 || emptyPublished, error: loadError, count: this.data.length };
    })();

    try {
      return await this.loadingPromise;
    } finally {
      // Clear the in-flight promise so a later retry (e.g. the first load
      // failed) can start fresh instead of returning the stale result.
      this.loadingPromise = null;
    }
  }

  private async applyCmsOverrides() {
    // Apply manual property overrides (single-row edits) from the CMS.
    try {
      const propertyOverrides = await cmsStore.listPropertyOverrides();
      if (propertyOverrides.length) {
        const quality: core.DataQualitySummary = {
          totalRowsRead: 0,
          keptRows: 0,
          missingZip: 0,
          missingCoordinates: 0,
          missingPrice: 0,
          uniqueZips: new Set(this.data.map((d) => d.zip).filter(Boolean)).size,
        };
        this.applyPropertyOverrides(propertyOverrides, quality);
        this.dataQuality = quality;
      }
    } catch (err) {
      console.error('[Kwizi] Failed to merge CMS property overrides:', err);
    }

    // Load metric/area overrides set in the CMS.
    try {
      this.cmsOverrides = await cmsStore.listOverrides();
    } catch (err) {
      console.error('[Kwizi] Failed to load CMS overrides:', err);
      this.cmsOverrides = [];
    }
  }

  private async applyPostLoadSteps(quality: core.DataQualitySummary, zipSet: Set<string>) {
    await this.applyCmsOverrides();

    quality.uniqueZips = zipSet.size || new Set(this.data.map((d) => d.zip).filter(Boolean)).size;
    this.dataQuality = quality;
    console.log(`[Kwizi Engine] Loaded ${this.data.length} properties`);

    // Mark ready immediately so the UI can render. School ratings run in the background.
    this.isLoaded = true;
    this.ensureSchoolRatings().catch(() => {});
  }

  private async loadSchoolRatings() {
    const loadRows = (level: 'elementary' | 'middle' | 'high', rows: any[]) => {
      const map: Record<string, number> = {};
      rows.forEach((row) => {
        const score = Number(row['Overall Score']);
        if (!isFinite(score)) return;
        const keys = new Set<string>();
        const clean = String(row['school_name_clean'] || '').trim().toUpperCase();
        const raw = String(row['school_name_raw'] || '').trim().toUpperCase();
        const normalizedRaw = core.cleanSchoolName(raw);
        if (clean) keys.add(clean);
        if (raw) keys.add(raw);
        if (normalizedRaw) keys.add(normalizedRaw);
        keys.forEach((k) => {
          if (!map[k] || score > map[k]) map[k] = score;
        });
      });
      this.teaScores[level] = map;
    };

    const loadOne = async (level: 'elementary' | 'middle' | 'high', path: string) => {
      try {
        let url = path;
        if (!path.startsWith('http') && !path.startsWith('/')) {
          // Treat as Firebase Storage path.
          url = (await this.getFirebaseDownloadUrl(path)) || '';
        }
        if (!url) return;
        const res = await fetch(url);
        if (!res.ok) {
          // Last-resort local fallback for TEA files only.
          const localUrl = `/csv/${path.split('/').pop()}`;
          const localRes = await fetch(localUrl);
          if (!localRes.ok) return;
          const text = await localRes.text();
          const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
          loadRows(level, parsed.data as any[]);
          return;
        }
        const text = await res.text();
        const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
        loadRows(level, parsed.data as any[]);
      } catch (err) {
        console.error('Error loading TEA ratings:', path, err);
      }
    };

    const TEA_FILES: Record<'elementary' | 'middle' | 'high', string> = {
      elementary: 'cms_files/csv/TEA_Elem_School_Ratings.csv',
      middle: 'cms_files/csv/TEA_Middle_School_Ratings.csv',
      high: 'cms_files/csv/TEA_High_School_Ratings.csv',
    };

    await Promise.all(
      (Object.keys(TEA_FILES) as Array<'elementary' | 'middle' | 'high'>).map((level) =>
        loadOne(level, TEA_FILES[level])
      )
    );

    // Merge CMS-uploaded school rating files.
    try {
      await Promise.all(
        (['elementary', 'middle', 'high'] as const).map(async (level) => {
          const rows = await cmsStore.getUploadedSchoolRows(level);
          if (!rows.length) return;
          // Start from the static map and overlay uploaded scores.
          const current = { ...this.teaScores[level] };
          loadRows(level, rows);
          // Preserve any static scores the upload did not replace.
          this.teaScores[level] = { ...current, ...this.teaScores[level] };
        })
      );
    } catch (err) {
      console.error('[Kwizi] Failed to merge CMS school ratings:', err);
    }
  }

  public getDataQualitySummary(): core.DataQualitySummary {
    return this.dataQuality;
  }

  public getReferenceDate(): Date {
    return core.getReferenceDate(this.data);
  }

  /**
   * Deduplicate repeated strings across the dataset. See engineCore.internStrings.
   */
  private internStrings(rows: core.PropertyData[]): void {
    core.internStrings(rows);
  }

  public filterProperties(filters: core.PropertyFilters): core.PropertyData[] {
    return core.filterProperties(this.data, filters, this.teaScores);
  }

  public getUniqueValues(field: keyof core.PropertyData): string[] {
    const set = new Set<string>();
    this.data.forEach((d) => {
      const v = d[field];
      if (typeof v === 'string' && v.trim()) set.add(v);
      else if (typeof v === 'number' && v) set.add(String(v));
    });
    return Array.from(set).sort();
  }

  public getRealSchoolScore(level: 'elementary' | 'middle' | 'high', name: string): number {
    return core.getRealSchoolScore(this.teaScores, level, name);
  }

  /** Snapshot of the TEA score maps for the worker (rating filters must behave
   *  identically on both sides of the worker boundary). */
  public getTeaScoresSnapshot(): core.TeaScoreMap {
    return {
      elementary: { ...this.teaScores.elementary },
      middle: { ...this.teaScores.middle },
      high: { ...this.teaScores.high },
    };
  }

  /** Replace the TEA score maps wholesale (used by /api/query, which loads
   *  them server-side so ETA metrics work without client rows). */
  public setTeaScores(maps: core.TeaScoreMap): void {
    this.teaScores = {
      elementary: { ...maps.elementary },
      middle: { ...maps.middle },
      high: { ...maps.high },
    };
  }

  public getSchoolETAScoreMap(boundary: core.BoundaryKey): Record<string, number> {
    const cacheKey = boundary;
    if (this.etaScoreCache[cacheKey]) return this.etaScoreCache[cacheKey];

    let result: Record<string, number> = {};
    if (boundary === 'elementary') {
      result = { ...this.teaScores.elementary };
    } else if (boundary === 'middle') {
      result = { ...this.teaScores.middle };
    } else if (boundary === 'highschools') {
      result = core.computeDistrictHighScores(this.data, this.teaScores);
    } else {
      // subdivision/zip ETA proxy when no direct school rating exists
      const proxy = core.getMapValues(this.data, boundary, 'Elem ETA Score', this.teaScores, this.cmsOverrides);
      result = proxy.values;
    }
    this.etaScoreCache[cacheKey] = result;
    return result;
  }

  public getSchoolRatingOptions(boundary: core.BoundaryKey): { name: string; score: number; grade: string }[] {
    const scores = this.getSchoolETAScoreMap(boundary);
    return Object.entries(scores)
      .map(([name, score]) => ({ name, score, grade: core.scoreToGrade(score) }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Concrete school names (per the TEA score map for `level`) whose grade is in
   * `grades`. Used by the SQL Connect path to resolve rating filters to plain
   * name lists — mirrors filterProperties' per-row getRealSchoolScore check.
   * Note: for 'high' this returns individual high-school names (matching the
   * highschoolName column), NOT district names.
   */
  public getSchoolNamesByGrade(level: 'elementary' | 'middle' | 'high', grades: string[]): string[] {
    if (!grades.length) return [];
    return Object.entries(this.teaScores[level])
      .filter(([, score]) => grades.includes(core.scoreToGrade(score)))
      .map(([name]) => name);
  }

  public getMetricRange(metric: core.MetricKey, data?: core.PropertyData[]): { min: number; max: number } {
    const arr = (data || this.data).map((d) => this.getMetricValue(metric, d)).filter((v) => v > 0 && isFinite(v));
    if (!arr.length) return { min: 0, max: 0 };
    // Linear scan — Math.min(...arr) with tens of thousands of values risks a
    // RangeError ("Maximum call stack size exceeded").
    let min = Infinity;
    let max = -Infinity;
    for (const v of arr) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  }

  public getBoundaryKey(boundary: core.BoundaryKey, item: core.PropertyData): string {
    return core.getBoundaryKeyFor(boundary, item);
  }

  public getRentalPrice(item: core.PropertyData): number {
    return core.getRentalPrice(item);
  }

  public getAnnualHOAFee(item: core.PropertyData): number {
    return core.getAnnualHOAFee(item);
  }

  public getMetricValue(metric: core.MetricKey, item: core.PropertyData): number {
    return core.getMetricValue(metric, item);
  }

  public getAppreciationRateForItems(items: core.PropertyData[]): number {
    return core.getAppreciationRateForItems(items);
  }

  public getInvestorIndexForItems(items: core.PropertyData[]): number {
    return core.getInvestorIndexForItems(items);
  }

  public getMapValues(
    data: core.PropertyData[],
    boundary: core.BoundaryKey,
    metric: core.MetricKey
  ): { values: Record<string, number>; counts: Record<string, number>; names: Record<string, string> } {
    return core.getMapValues(data, boundary, metric, this.teaScores, this.cmsOverrides);
  }

  public getStatsForSelection(data: core.PropertyData[], boundary: core.BoundaryKey, selectedIds: string[]) {
    return core.getStatsForSelection(data, boundary, selectedIds);
  }

  /** Lightweight rental point — MapComponent only reads lat/lng to draw dots.
   *  The previous implementation cloned every full row ({...d}), which for the
   *  ~763k-row dataset allocated hundreds of MB on every filter change and
   *  could crash the tab. */
  public generateRentalPoints(data: core.PropertyData[]): { lat: number; lng: number }[] {
    const out: { lat: number; lng: number }[] = [];
    for (const d of data) {
      if (isFinite(d.lat) && isFinite(d.lng) && (d.lat !== 0 || d.lng !== 0)) {
        out.push({ lat: d.lat, lng: d.lng });
      }
    }
    return out;
  }

  public getTimeSeries(
    data: core.PropertyData[],
    boundary: core.BoundaryKey,
    metric: core.MetricKey,
    selectedIds?: string[]
  ): core.TimeSeriesPoint[] {
    return core.getTimeSeries(data, boundary, metric, selectedIds);
  }

  public getTimeSeriesForBoundary(
    data: core.PropertyData[],
    boundary: core.BoundaryKey,
    metric: core.MetricKey,
    boundaryId: string
  ): core.TimeSeriesPoint[] {
    return core.getTimeSeries(data, boundary, metric, [boundaryId]);
  }

  public buildForecast(ts: core.TimeSeriesPoint[]) {
    return core.buildForecast(ts);
  }

  public getForecastForSelection(
    data: core.PropertyData[],
    boundary: core.BoundaryKey,
    metric: core.MetricKey,
    selectedIds: string[]
  ): core.ForecastComparisonRow[] {
    return core.getForecastForSelection(data, boundary, metric, selectedIds);
  }

  public getAppreciationRate(data: core.PropertyData[], boundary: core.BoundaryKey, boundaryId?: string): number {
    return core.getAppreciationRate(data, boundary, boundaryId);
  }

  public getMarketHealth(
    data: core.PropertyData[],
    boundary: core.BoundaryKey,
    selectedIds: string[],
    marketType: 'sale' | 'rental' = 'sale'
  ) {
    return core.getMarketHealth(data, boundary, selectedIds, marketType);
  }

  /**
   * Fetch a JSON payload that may be served raw or gzip-compressed. We try to
   * parse it directly first; if that fails we stream it through
   * DecompressionStream. This lets us serve pre-compressed `.json.gz` files
   * from /cache while still working if a CDN transparently decompresses them.
   */
  public async fetchGzJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

    const buf = await res.arrayBuffer();
    let text: string;
    try {
      text = new TextDecoder().decode(buf);
      JSON.parse(text);
    } catch {
      const ds = (window as any).DecompressionStream as typeof DecompressionStream;
      if (!ds) throw new Error('Browser does not support gzip decompression.');
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      });
      const decompressed = stream.pipeThrough(new ds('gzip'));
      text = await new Response(decompressed).text();
    }
    return JSON.parse(text) as T;
  }
}

const globalStore = typeof globalThis !== 'undefined' ? (globalThis as any) : undefined;
export const engine: RealEstateEngine = globalStore?.__kwiziEngine || new RealEstateEngine();
if (globalStore) globalStore.__kwiziEngine = engine;