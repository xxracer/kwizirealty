import Papa from 'papaparse';
import { cmsStore, type CMSMetricOverride, type CMSPropertyOverride } from './cmsStore';
import { cacheVersionFor, readCache, writeCache } from './csvCache';
import { ref, getDownloadURL } from 'firebase/storage';
import { storage } from './firebase';

export interface PropertyData {
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

export type BoundaryKey =
  | 'subdivisions'
  | 'zipcodes'
  | 'highschools'
  | 'elementary'
  | 'middle'
  | 'neighborhoods'
  | 'areas';

export type MetricKey =
  | 'Close Price'
  | 'Price per Sqft'
  | 'List-to-Sale Ratio'
  | 'Days on Market'
  | 'Est. Rental Price'
  | 'Rent-to-Sale Ratio'
  | 'Price per Sqft List'
  | 'Lot Size'
  | 'Rental Price per Sqft'
  | 'Rental Days On Market'
  | 'Appreciation Rate'
  | 'Investor Index'
  | 'Annual HOA Fee'
  | 'Last Year Tax Rate'
  | 'Elem ETA Score'
  | 'Middle ETA Score'
  | 'High ETA Score';

export interface PropertyFilters {
  bedsMin: number;
  bedsMax: number;
  bathsMin: number;
  bathsMax: number;
  sqftMin: number;
  sqftMax: number;
  saleMin: number;
  saleMax: number;
  rentMin: number;
  rentMax: number;
  pricePerSqftMin: number;
  pricePerSqftMax: number;
  lotSizeMin: number;
  lotSizeMax: number;
  domMin: number;
  domMax: number;
  l2sMin: number;
  l2sMax: number;
  yearMin: number;
  yearMax: number;
  period: 'all' | '30d' | '90d' | '6m' | 'ytd' | '1y' | '3y' | '5y';
  propertyTypes: string[];
  pool: 'any' | 'yes' | 'no';
  schoolDistricts: string[];
  cities: string[];
  elementary: string[];
  middle: string[];
  highschools: string[];
  elementaryRating: string[];
  middleRating: string[];
  highRating: string[];
}

export const DEFAULT_FILTERS: PropertyFilters = {
  bedsMin: 0,
  bedsMax: 10,
  bathsMin: 0,
  bathsMax: 8,
  sqftMin: 0,
  sqftMax: 10000,
  saleMin: 0,
  saleMax: 5000000,
  rentMin: 0,
  rentMax: 10000,
  pricePerSqftMin: 0,
  pricePerSqftMax: 2000,
  lotSizeMin: 0,
  lotSizeMax: 50000,
  domMin: 0,
  domMax: 365,
  l2sMin: 80,
  l2sMax: 110,
  yearMin: 1920,
  yearMax: new Date().getFullYear(),
  period: '5y',
  propertyTypes: [],
  pool: 'any',
  schoolDistricts: [],
  cities: [],
  elementary: [],
  middle: [],
  highschools: [],
  elementaryRating: [],
  middleRating: [],
  highRating: [],
};

// Legacy fallback list – the real list is read from /csv/property-manifest.json
const CSV_FILES = [
  '/csv/34_x_40_displayGrid_nonresponsive_ajax_display_dU35329m_show.csv',
  '/csv/94_x_40_displayGrid_nonresponsive_ajax_display_dU35329m_show.csv',
];

const TEA_FILES: Record<'elementary' | 'middle' | 'high', string> = {
  elementary: 'cms_files/csv/TEA_Elem_School_Ratings.csv',
  middle: 'cms_files/csv/TEA_Middle_School_Ratings.csv',
  high: 'cms_files/csv/TEA_High_School_Ratings.csv',
};

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

function cleanBool(raw: string): boolean {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1' || v === 'y';
}

export function cleanBoundaryName(raw: unknown): string {
  const v = String(raw || '').toUpperCase().trim();
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

export function cleanSchoolName(raw: unknown): string {
  let v = String(raw || '').toUpperCase().trim();
  if (!v || v === 'NA' || v === 'N/A' || v === 'NONE' || v === 'NULL' || v === 'UNKNOWN') return '';
  // Strip parenthetical district annotations, e.g. "ELEMENTARY SCHOOL (HOUSTON)"
  v = v.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  // Reduce full school-type names to short suffixes used by the GeoJSON and TEA files.
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

/**
 * The available high-school geometry is actually school-district boundaries
 * (Houston_ISD.geojson). Map HAR district codes such as "27 - Houston" to the
 * full ISD name used by that GeoJSON layer.
 */
export function cleanDistrictCode(raw: unknown): string {
  const v = String(raw || '').trim();
  if (!v || v.toUpperCase() === 'NA' || v.toUpperCase() === 'N/A') return '';
  const name = v.replace(/^\d+\s*-\s*/, '').trim();
  if (!name) return '';
  if (/ISD$/i.test(name) || /SCHOOL\s+DISTRICT$/i.test(name)) {
    return cleanBoundaryName(name);
  }
  return cleanBoundaryName(name + ' Independent School District');
}

function periodToDates(period: PropertyFilters['period'], reference: Date) {
  const end = reference;
  let start: Date | null = null;
  const y = end.getFullYear();
  switch (period) {
    case '30d':
      start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case '90d':
      start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    case '6m':
      start = new Date(end.getTime() - 180 * 24 * 60 * 60 * 1000);
      break;
    case 'ytd':
      start = new Date(y, 0, 1);
      break;
    case '1y':
      start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
      break;
    case '3y':
      start = new Date(end.getTime() - 3 * 365 * 24 * 60 * 60 * 1000);
      break;
    case '5y':
      start = new Date(end.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
      break;
    case 'all':
    default:
      start = null;
  }
  return { start, end };
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentileRank(sorted: number[], value: number): number {
  if (!sorted.length) return 50;
  const idx = sorted.findIndex((v) => v >= value);
  if (idx === -1) return 100;
  return Math.max(0, Math.min(100, (idx / sorted.length) * 100));
}

function parseMonthKey(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return `${y}-${m.toString().padStart(2, '0')}`;
}

function parseWeekKey(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const oneJan = new Date(y, 0, 1);
  const dayOfYear = Math.floor((d.getTime() - oneJan.getTime()) / 86400000) + 1;
  const week = Math.ceil(dayOfYear / 7);
  return `${y}-W${week.toString().padStart(2, '0')}`;
}

export interface DataQualitySummary {
  totalRowsRead: number;
  keptRows: number;
  missingZip: number;
  missingCoordinates: number;
  missingPrice: number;
  uniqueZips: number;
}

function scoreToGrade(score: number): string {
  if (score >= 97) return 'A+';
  if (score >= 93) return 'A';
  if (score >= 90) return 'A-';
  if (score >= 87) return 'B+';
  if (score >= 83) return 'B';
  if (score >= 80) return 'B-';
  if (score >= 77) return 'C+';
  if (score >= 73) return 'C';
  if (score >= 70) return 'C-';
  if (score >= 67) return 'D+';
  if (score >= 63) return 'D';
  if (score >= 60) return 'D-';
  return 'F';
}

async function asyncPool<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers: Promise<void>[] = [];
  const run = async () => {
    while (queue.length) {
      const item = queue.shift()!;
      await fn(item);
    }
  };
  for (let i = 0; i < concurrency; i++) {
    workers.push(run());
  }
  await Promise.all(workers);
}

interface ChunkAreaIndex {
  version: number;
  boundaries: Partial<Record<BoundaryKey, Record<string, number[]>>>;
}

export class RealEstateEngine {
  public data: PropertyData[] = [];
  public isLoaded = false;
  public dataQuality: DataQualitySummary = {
    totalRowsRead: 0,
    keptRows: 0,
    missingZip: 0,
    missingCoordinates: 0,
    missingPrice: 0,
    uniqueZips: 0,
  };
  private etaScoreCache: Record<string, Record<string, number>> = {};
  private teaScores: Record<'elementary' | 'middle' | 'high', Record<string, number>> = {
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

  private normalizeRows(rows: any[], quality: DataQualitySummary, zipSet: Set<string>): PropertyData[] {
    return rows
      .map((row: any) => {
        const close = cleanDate(row['Close Date'] || '');
        const baths = cleanNumber(row['FB']) + cleanNumber(row['HB']);
        const closePrice = cleanNumber(row['Close Price'] || row['Original List Price']);
        const sqft = cleanNumber(row['SF']);
        const pricePerSqft = cleanNumber(row['Price Sq Ft Sold'] || row['Prc/SF']);
        const listPrice = cleanNumber(row['Original List Price']);
        const lat = Number(row['Latitude']);
        const lng = Number(row['Longitude']);
        const zipRaw = String(row['Zip'] || '').trim();

        if (!zipRaw || zipRaw.toUpperCase() === 'NA' || zipRaw.toUpperCase() === 'N/A') {
          quality.missingZip++;
        } else {
          zipSet.add(zipRaw);
        }
        if (!lat || !lng) quality.missingCoordinates++;
        if (!closePrice) quality.missingPrice++;

        if (!closePrice || !lat || !lng) return null as any;

        return {
          mlsNumber: String(row['MLS Number'] || ''),
          address: String(row['Address'] || ''),
          city: String(row['City/Location'] || ''),
          state: String(row['State Or Province'] || ''),
          zip: zipRaw,
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
          closeDate: close.date,
          closeYear: close.year,
          closeDateTs: close.ts,
          maintFee: cleanNumber(row['Maint Fee Amt']),
          maintFeeSchedule: String(row['Maint Fee Pay Schedule'] || '').toLowerCase(),
          taxRate: cleanNumber(row['Tax Rate']),
          taxYear: cleanNumber(row['Tax Year']),
          taxAmount: cleanNumber(row['Tax Amount']),

          subdivisions: cleanBoundaryName(row['Subdivision']),
          zipcodes: zipRaw,
          highschools: cleanDistrictCode(row['School District']),
          highschoolName: cleanSchoolName(row['School High']),
          elementary: cleanSchoolName(row['School Elementary']),
          middle: cleanSchoolName(row['School Middle']),
          schoolDistrict: String(row['School District'] || '').trim(),
          marketArea: String(row['Market Area'] || '').trim(),
          area: String(row['Area'] || '').trim(),

          lat,
          lng,

          propertyType: String(row['Property Type'] || '').trim(),
          pool: cleanBool(row['Pool Private']),
        };
      })
      .filter((item: PropertyData | null) => item !== null) as PropertyData[];
  }

  private buildRowFromOverride(o: CMSPropertyOverride, base?: PropertyData): Record<string, string> {
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

  private applyPropertyOverrides(overrides: CMSPropertyOverride[], quality: DataQualitySummary) {
    const keyFor = (d: PropertyData) => d.mlsNumber || `${d.address}|${d.zip}`;

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
      const items = this.normalizeRows([row], quality, new Set<string>());
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
      const res = await fetch(url, { signal: controller.signal });
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
        boundaries?: Partial<Record<BoundaryKey, { chunks: string[] }>>;
        totalRows: number;
        localBase?: string;
      }
    | null
  > {
    const manifestName = 'master_cache_chunks.json';

    // Prefer a build-time copy in /cache so Vercel serves it same-domain and
    // users avoid the slow cross-origin Firebase Storage download.
    const loadManifest = async (): Promise<any | null> => {
      try {
        const localRes = await fetch(`/cache/${manifestName}`, { method: 'GET' });
        if (localRes.ok) return await localRes.json();
      } catch {
        // ignore
      }

      const manifestPath = `cms_files/csv/${manifestName}`;
      try {
        let url = await this.getFirebaseDownloadUrl(manifestPath);
        if (!url) {
          const direct = this.directStorageUrl(manifestPath);
          const head = await this.fetchWithTimeout(direct, 10000);
          if (head.ok) url = direct;
        }
        if (!url) return null;
        const res = await this.fetchWithTimeout(url, 30000);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    const manifest = await loadManifest();
    if (!manifest) return null;

    if (manifest.format === 'boundary-chunks' && manifest.boundaries) {
      return { boundaries: manifest.boundaries, totalRows: manifest.totalRows || 0, localBase: '/cache/' };
    }

    if (Array.isArray(manifest.chunks) && manifest.chunks.length > 0) {
      return { chunks: manifest.chunks, totalRows: manifest.totalRows || 0, localBase: '/cache/' };
    }

    return null;
  }

  private async resolveChunkUrl(path: string, localBase?: string): Promise<string> {
    const fileName = path.split('/').pop();
    if (localBase) {
      const localUrl = `${localBase}${fileName}`;
      try {
        const head = await fetch(localUrl, { method: 'HEAD' });
        if (head.ok) return localUrl;
      } catch {
        // ignore
      }
    }
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
    localBase?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<PropertyData[]> {
    const ds = (window as any).DecompressionStream as typeof DecompressionStream;
    if (!ds) throw new Error('Browser does not support gzip decompression.');

    const results = new Array(chunkPaths.length);
    let completed = 0;

    await asyncPool(
      6,
      chunkPaths.map((path, index) => ({ path, index })),
      async ({ path, index }) => {
        const url = await this.resolveChunkUrl(path, localBase);
        const res = await this.fetchWithTimeout(url, 120000);
        if (!res.ok) throw new Error(`Chunk fetch failed: ${res.status}`);

        const buf = await res.arrayBuffer();
        let text: string;
        try {
          text = new TextDecoder().decode(buf);
          JSON.parse(text);
        } catch {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(buf));
              controller.close();
            },
          });
          const decompressed = stream.pipeThrough(new ds('gzip'));
          text = await new Response(decompressed).text();
        }
        const parsed = JSON.parse(text);
        let rows: PropertyData[];
        if (Array.isArray(parsed)) {
          rows = parsed as PropertyData[];
        } else if (parsed && parsed.header && parsed.rows) {
          const header = parsed.header as (keyof PropertyData)[];
          rows = (parsed.rows as any[]).map((arr) => {
            const obj: any = {};
            header.forEach((key, i) => (obj[key] = arr[i]));
            return obj as PropertyData;
          });
        } else {
          throw new Error(`Unrecognized chunk format: ${typeof parsed}`);
        }
        results[index] = rows;
        completed++;
        onProgress?.(completed, chunkPaths.length);
        console.log(`[Kwizi Engine] Loaded chunk ${index + 1}/${chunkPaths.length}: ${rows.length.toLocaleString()} rows`);
        // Yield so React can paint the map (overlay hidden, polygons rendered)
        // while the remaining chunks are still being parsed.
        await this.yieldToMain();
      }
    );

    return results.flat();
  }

  private async loadChunkedCache(
    chunkPaths: string[],
    localBase?: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<PropertyData[]> {
    // The chunks are large (~60 MB raw), and transferring parsed rows back from
    // a Web Worker is slower than parsing on the main thread. We run on the main
    // thread while a tiny pre-computed metric snapshot lets the map render
    // instantly in parallel.
    return this.loadChunksOnMainThread(chunkPaths, localBase, onProgress);
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

  private async parseMasterResponse(res: Response, url: string): Promise<{ rows?: Record<string, string>[]; normalized?: PropertyData[] }> {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('.gz')) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const decompressed = res.body ? await new Response(res.body.pipeThrough(new ((window as any).DecompressionStream as typeof DecompressionStream)('gzip'))).text() : '';
        const json = JSON.parse(decompressed);
        if (Array.isArray(json.data) && json.data.length > 0) {
          const first = json.data[0];
          if (first && typeof first.closePrice === 'number' && typeof first.lat === 'number') {
            return { normalized: json.data as PropertyData[] };
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
          return { normalized: json.data as PropertyData[] };
        }
      }
      return { rows: [] };
    }
    return { rows: await this.parseCsvText(await res.text()) };
  }

  /**
   * Load the area -> chunk index generated at build time. Used by
   * loadDataForSelection() to avoid fetching the entire dataset.
   */
  public async loadChunkAreaIndex(): Promise<void> {
    if (this.chunkAreaIndex) return;
    try {
      const index = await this.fetchGzJson<ChunkAreaIndex>('/cache/chunk_area_index.json.gz');
      this.chunkAreaIndex = index;
      console.log('[Kwizi Engine] Loaded chunk area index', {
        version: index.version,
        boundaries: Object.keys(index.boundaries),
      });
    } catch (err) {
      console.warn('[Kwizi Engine] Could not load chunk area index, will fall back to full chunks:', err);
      this.chunkAreaIndex = { version: 0, boundaries: {} };
    }
  }

  /**
   * Return the chunk indices that contain any of the selected area keys for the
   * current boundary. Falls back to all chunks if the index is missing.
   */
  private resolveChunkIndicesForSelection(
    boundary: BoundaryKey,
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
    boundary: BoundaryKey,
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
        return { ok: false, error: `No chunked data for boundary ${boundary}`, count: 0 };
      }
      chunkPaths = boundaryInfo.chunks;
    } else {
      chunkPaths = chunkedCache.chunks || [];
      if (chunkPaths.length === 0) {
        return { ok: false, error: 'No chunked cache available', count: 0 };
      }
    }

    const totalChunks = chunkPaths.length;
    const indices = this.resolveChunkIndicesForSelection(boundary, selectedIds, totalChunks);
    const selectedPaths = indices.map((i) => chunkPaths[i]);

    console.log(
      `[Kwizi Engine] Loading ${selectedPaths.length}/${totalChunks} chunks for ${selectedIds.length} selected ${boundary} areas`
    );
    onProgress?.(0, selectedPaths.length);

    try {
      const rows = await this.loadChunkedCache(selectedPaths, chunkedCache.localBase, onProgress);
      const selectedSet = new Set(selectedIds);
      const filtered = rows.filter((d) => selectedSet.has(this.getBoundaryKey(boundary, d)));

      this.data = filtered;
      this.isLoaded = true;

      // Run post-load steps (overrides, school ratings) in the background.
      // We intentionally do NOT cache selection data so it never overwrites the
      // full-dataset IndexedDB cache with a partial subset.
      this.applyPostLoadSteps(
        {
          totalRowsRead: filtered.length,
          keptRows: filtered.length,
          missingZip: 0,
          missingCoordinates: 0,
          missingPrice: 0,
          uniqueZips: new Set(filtered.map((d) => d.zip)).size,
        },
        new Set(filtered.map((d) => d.zip)),
        ''
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
    if (this.isLoaded && !forceRefresh) return { ok: true, count: this.data.length };
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
        ? ['cms_files/csv/master_cache_chunks.json']
        : masterFile?.path
        ? [masterFile.path]
        : (manifestPaths || []);
      const version = await cacheVersionFor(cacheVersionUrls);

      // 2. Try IndexedDB cache first (avoids any network hit after first load).
      if (!forceRefresh) {
        try {
          const cacheResult = await readCache<PropertyData[]>(version);
          const cached = cacheResult.data;
          if (cached && cached.length > 0) {
            this.data = cached;
            this.isLoaded = true;
            console.log('[Kwizi Engine] Restored', cached.length, 'properties from IndexedDB cache');
            this.loadSchoolRatings().catch(() => {});
            return { ok: true, count: cached.length };
          }
        } catch (err) {
          console.warn('[Kwizi] Failed to read CSV cache:', err);
        }
      }

      const quality: DataQualitySummary = {
        totalRowsRead: 0,
        keptRows: 0,
        missingZip: 0,
        missingCoordinates: 0,
        missingPrice: 0,
        uniqueZips: 0,
      };
      const zipSet = new Set<string>();
      let allItems: PropertyData[] = [];
      let loadError: string | undefined;

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
          loadError = 'Chunked cache manifest has no chunks to load.';
        } else {
          console.log(`[Kwizi Engine] Loading ${fullLoadPaths.length} pre-normalized JSON chunks`);
          onProgress?.(0, fullLoadPaths.length);
          try {
            allItems = await this.loadChunkedCache(fullLoadPaths, chunkedCache.localBase, onProgress);
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

      this.data = allItems;
      // Start post-load work in the background; the UI can render as soon as
      // the data is in memory. applyPostLoadSteps sets this.isLoaded = true.
      this.applyPostLoadSteps(quality, zipSet, version).catch((err) =>
        console.error('[Kwizi] Post-load steps failed:', err)
      );
      return { ok: this.data.length > 0, error: loadError, count: this.data.length };
    })();

    return this.loadingPromise;
  }

  private async saveCache(cacheVersion: string) {
    try {
      const summary = await cmsStore.summary();
      const currentSignature = `${summary.lastUploadAt}-${summary.overrides}-${summary.propertyOverrides}`;
      await writeCache(cacheVersion, this.data, currentSignature);
    } catch (e) {
      console.warn('Failed to save cache', e);
      try {
        await writeCache(cacheVersion, this.data);
      } catch (e2) {
        console.warn('Failed to save cache without signature', e2);
      }
    }
  }

  private async applyPostLoadSteps(
    quality: DataQualitySummary,
    zipSet: Set<string>,
    cacheVersion: string
  ) {
    // Apply manual property overrides (single-row edits) from the CMS.
    try {
      const propertyOverrides = await cmsStore.listPropertyOverrides();
      if (propertyOverrides.length) {
        this.applyPropertyOverrides(propertyOverrides, quality);
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

    quality.uniqueZips = zipSet.size || new Set(this.data.map((d) => d.zip).filter(Boolean)).size;
    this.dataQuality = quality;
    console.log(`[Kwizi Engine] Loaded ${this.data.length} properties`);

    // Mark ready immediately so the UI can render. Cache write and school ratings run in the background.
    this.isLoaded = true;
    this.loadSchoolRatings().catch(() => {});
    if (cacheVersion) {
      this.saveCache(cacheVersion).catch(() => {});
    }
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
        const normalizedRaw = cleanSchoolName(raw);
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

  public getDataQualitySummary(): DataQualitySummary {
    return this.dataQuality;
  }

  public getReferenceDate(): Date {
    if (!this.data.length) return new Date();
    let maxTs = 0;
    this.data.forEach((d) => {
      if (d.closeDateTs) {
        if (d.closeDateTs > maxTs) maxTs = d.closeDateTs;
      }
    });
    return maxTs ? new Date(maxTs) : new Date();
  }

  public filterProperties(filters: PropertyFilters): PropertyData[] {
    const ref = this.getReferenceDate();
    const { start, end } = periodToDates(filters.period, ref);

    return this.data.filter((d) => {
      if (d.closePrice < filters.saleMin || d.closePrice > filters.saleMax) return false;
      if (d.sqft < filters.sqftMin || d.sqft > filters.sqftMax) return false;
      if (d.yearBuilt < filters.yearMin || d.yearBuilt > filters.yearMax) return false;
      if (d.br < filters.bedsMin || d.br > filters.bedsMax) return false;
      if (d.baths < filters.bathsMin || d.baths > filters.bathsMax) return false;

      const l2s = d.listPrice > 0 ? (d.closePrice / d.listPrice) * 100 : 0;
      if (l2s < filters.l2sMin || l2s > filters.l2sMax) return false;

      const dom = d.cdom || d.dom;
      if (dom < filters.domMin || dom > filters.domMax) return false;

      if (d.lotSize < filters.lotSizeMin || d.lotSize > filters.lotSizeMax) return false;

      const ppsf = d.pricePerSqft || (d.sqft ? d.closePrice / d.sqft : 0);
      if (ppsf < filters.pricePerSqftMin || ppsf > filters.pricePerSqftMax) return false;

      const estRent = d.closePrice * 0.008;
      if (estRent < filters.rentMin || estRent > filters.rentMax) return false;

      if (start && d.closeDateTs) {
        if (d.closeDateTs < start.getTime() || d.closeDateTs > end.getTime()) return false;
      }

      if (filters.propertyTypes.length && !filters.propertyTypes.includes(d.propertyType)) return false;
      if (filters.pool === 'yes' && !d.pool) return false;
      if (filters.pool === 'no' && d.pool) return false;
      if (filters.schoolDistricts.length && !filters.schoolDistricts.includes(d.schoolDistrict)) return false;
      if (filters.cities.length && !filters.cities.includes(d.city)) return false;
      if (filters.elementary.length && !filters.elementary.includes(d.elementary)) return false;
      if (filters.middle.length && !filters.middle.includes(d.middle)) return false;
      if (filters.highschools.length && !filters.highschools.includes(d.highschools)) return false;

      if (filters.elementaryRating.length) {
        const score = this.getRealSchoolScore('elementary', d.elementary);
        if (!filters.elementaryRating.includes(scoreToGrade(score))) return false;
      }
      if (filters.middleRating.length) {
        const score = this.getRealSchoolScore('middle', d.middle);
        if (!filters.middleRating.includes(scoreToGrade(score))) return false;
      }
      if (filters.highRating.length) {
        const score = this.getRealSchoolScore('high', d.highschoolName);
        if (!filters.highRating.includes(scoreToGrade(score))) return false;
      }

      return true;
    });
  }

  public getUniqueValues(field: keyof PropertyData): string[] {
    const set = new Set<string>();
    this.data.forEach((d) => {
      const v = d[field];
      if (typeof v === 'string' && v.trim()) set.add(v);
      else if (typeof v === 'number' && v) set.add(String(v));
    });
    return Array.from(set).sort();
  }

  public getRealSchoolScore(level: 'elementary' | 'middle' | 'high', name: string): number {
    if (!name) return 0;
    return this.teaScores[level][name] || this.teaScores[level][cleanSchoolName(name)] || 0;
  }

  private computeDistrictHighScores(): Record<string, number> {
    const groups: Record<string, number[]> = {};
    this.data.forEach((d) => {
      if (!d.highschools) return;
      const score = this.getRealSchoolScore('high', d.highschoolName);
      if (!score) return;
      if (!groups[d.highschools]) groups[d.highschools] = [];
      groups[d.highschools].push(score);
    });
    const result: Record<string, number> = {};
    Object.entries(groups).forEach(([k, arr]) => {
      result[k] = arr.length ? median(arr) : 0;
    });
    return result;
  }

  public getSchoolETAScoreMap(boundary: BoundaryKey): Record<string, number> {
    const cacheKey = boundary;
    if (this.etaScoreCache[cacheKey]) return this.etaScoreCache[cacheKey];

    let result: Record<string, number> = {};
    if (boundary === 'elementary') {
      result = { ...this.teaScores.elementary };
    } else if (boundary === 'middle') {
      result = { ...this.teaScores.middle };
    } else if (boundary === 'highschools') {
      result = this.computeDistrictHighScores();
    } else {
      // subdivision/zip ETA proxy when no direct school rating exists
      const proxy = this.getMapValues(this.data, boundary, 'Elem ETA Score');
      result = proxy.values;
    }
    this.etaScoreCache[cacheKey] = result;
    return result;
  }

  public getSchoolRatingOptions(boundary: BoundaryKey): { name: string; score: number; grade: string }[] {
    const scores = this.getSchoolETAScoreMap(boundary);
    return Object.entries(scores)
      .map(([name, score]) => ({ name, score, grade: scoreToGrade(score) }))
      .sort((a, b) => b.score - a.score);
  }

  public getMetricRange(metric: MetricKey, data?: PropertyData[]): { min: number; max: number } {
    const arr = (data || this.data).map((d) => this.getMetricValue(metric, d)).filter((v) => v > 0 && isFinite(v));
    if (!arr.length) return { min: 0, max: 0 };
    return { min: Math.min(...arr), max: Math.max(...arr) };
  }

  public getBoundaryKey(boundary: BoundaryKey, item: PropertyData): string {
    let key = '';
    switch (boundary) {
      case 'subdivisions':
      case 'neighborhoods':
        key = item.subdivisions;
        break;
      case 'zipcodes':
        key = item.zipcodes;
        break;
      case 'highschools':
        key = item.highschools;
        break;
      case 'elementary':
        key = item.elementary;
        break;
      case 'middle':
        key = item.middle;
        break;
      case 'areas':
        key = item.area;
        break;
      default:
        key = item.subdivisions;
    }
    if (!key || key === 'NA' || key === 'N/A' || key === 'NONE' || key === 'NULL' || key === 'UNKNOWN' || key === 'UNINCORPORATED') return '';
    return key;
  }

  public getRentalPrice(item: PropertyData): number {
    return item.closePrice * 0.008;
  }

  public getAnnualHOAFee(item: PropertyData): number {
    const fee = item.maintFee;
    if (!fee) return 0;
    const sched = item.maintFeeSchedule || 'annually';
    if (sched.includes('month')) return fee * 12;
    if (sched.includes('quarter')) return fee * 4;
    if (sched.includes('semi') || sched.includes('half')) return fee * 2;
    return fee;
  }

  public getMetricValue(metric: MetricKey, item: PropertyData): number {
    const rentalPrice = this.getRentalPrice(item);
    switch (metric) {
      case 'Close Price':
        return item.closePrice;
      case 'Price per Sqft':
        return item.pricePerSqft || (item.sqft ? item.closePrice / item.sqft : 0);
      case 'Price per Sqft List':
        return item.listPrice && item.sqft ? item.listPrice / item.sqft : 0;
      case 'List-to-Sale Ratio':
        return item.listPrice > 0 ? (item.closePrice / item.listPrice) * 100 : 0;
      case 'Days on Market':
        return item.cdom || item.dom;
      case 'Est. Rental Price':
        return rentalPrice;
      case 'Rent-to-Sale Ratio':
        return item.closePrice > 0 ? (rentalPrice * 12) / item.closePrice : 0;
      case 'Rental Price per Sqft':
        return item.sqft ? rentalPrice / item.sqft : 0;
      case 'Rental Days On Market':
        // Proxy: rental listings tend to move faster; use 0.85 of sale DOM.
        return Math.round((item.cdom || item.dom) * 0.85);
      case 'Lot Size':
        return item.lotSize;
      case 'Annual HOA Fee':
        return this.getAnnualHOAFee(item);
      case 'Last Year Tax Rate':
        return item.taxRate;
      case 'Elem ETA Score':
      case 'Middle ETA Score':
      case 'High ETA Score':
        // Area-level scores are computed in getMapValues.
        return 0;
      case 'Appreciation Rate':
        return 0; // computed per-area, not per-property
      case 'Investor Index':
        return 0; // computed per-area, not per-property
      default:
        return item.closePrice;
    }
  }

  public getAppreciationRateForItems(items: PropertyData[]): number {
    const byYear: Record<number, number[]> = {};
    items.forEach((d) => {
      if (!d.closeYear) return;
      if (!byYear[d.closeYear]) byYear[d.closeYear] = [];
      byYear[d.closeYear].push(d.closePrice);
    });
    const years = Object.keys(byYear)
      .map(Number)
      .sort((a, b) => a - b);
    if (years.length < 2) return 0;
    const first = median(byYear[years[0]]);
    const last = median(byYear[years[years.length - 1]]);
    if (!first) return 0;
    const yearsDiff = years[years.length - 1] - years[0];
    if (!yearsDiff) return 0;
    const cagr = (Math.pow(last / first, 1 / yearsDiff) - 1) * 100;
    return isFinite(cagr) ? cagr : 0;
  }

  public getInvestorIndexForItems(items: PropertyData[]): number {
    if (!items.length) return 0;
    const rtsArr = items
      .map((d) => (d.closePrice > 0 ? (this.getRentalPrice(d) * 12) / d.closePrice : 0))
      .filter((v) => v > 0);
    const domArr = items.map((d) => d.cdom || d.dom).filter((v) => v > 0);
    const appreciation = this.getAppreciationRateForItems(items);

    const rentToSale = rtsArr.length ? median(rtsArr) : 0;
    const dom = domArr.length ? median(domArr) : 0;

    const clamp = (v: number, lo: number, hi: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    const rtsScore = clamp(rentToSale, 0.03, 0.15);
    const appScore = clamp(appreciation, -5, 15);
    const domScore = clamp(90 - dom, 0, 70);

    const idx = rtsScore * 0.4 + appScore * 0.3 + (domScore / 70) * 100 * 0.3;
    return Math.max(0, Math.min(100, idx));
  }

  public getMapValues(
    data: PropertyData[],
    boundary: BoundaryKey,
    metric: MetricKey
  ): { values: Record<string, number>; counts: Record<string, number>; names: Record<string, string> } {
    const groups: Record<string, PropertyData[]> = {};
    const names: Record<string, string> = {};

    data.forEach((d) => {
      const key = this.getBoundaryKey(boundary, d);
      if (!key) return;
      if (!groups[key]) groups[key] = [];
      groups[key].push(d);
      names[key] = key;
    });

    const values: Record<string, number> = {};
    const counts: Record<string, number> = {};

    if (metric === 'Elem ETA Score') {
      Object.entries(groups).forEach(([key, items]) => {
        const score = this.getRealSchoolScore('elementary', key);
        values[key] = score || 0;
        counts[key] = items.length;
      });
    } else if (metric === 'Middle ETA Score') {
      Object.entries(groups).forEach(([key, items]) => {
        const score = this.getRealSchoolScore('middle', key);
        values[key] = score || 0;
        counts[key] = items.length;
      });
    } else if (metric === 'High ETA Score') {
      Object.entries(groups).forEach(([key, items]) => {
        const scores = items
          .map((d) => this.getRealSchoolScore('high', d.highschoolName))
          .filter((v) => v > 0);
        values[key] = scores.length ? median(scores) : 0;
        counts[key] = items.length;
      });
    } else {
      Object.entries(groups).forEach(([key, items]) => {
        if (!items.length) return;
        let value: number;
        if (metric === 'Appreciation Rate') {
          value = this.getAppreciationRateForItems(items);
        } else if (metric === 'Investor Index') {
          value = this.getInvestorIndexForItems(items);
        } else {
          const arr = items
            .map((d) => this.getMetricValue(metric, d))
            .filter((v) => v > 0 || metric === 'Days on Market' || metric === 'List-to-Sale Ratio' || metric === 'Last Year Tax Rate');
          if (!arr.length) return;
          value = median(arr);
        }
        values[key] = value;
        counts[key] = items.length;
      });
    }

    // Apply manual CMS metric overrides.
    this.cmsOverrides.forEach((o) => {
      if (o.boundary === boundary && o.metric === metric && values[o.boundaryId] !== undefined) {
        values[o.boundaryId] = o.value;
      }
    });

    return { values, counts, names };
  }

  public getStatsForSelection(data: PropertyData[], boundary: BoundaryKey, selectedIds: string[]) {
    const selected = data.filter((d) => {
      const pid = this.getBoundaryKey(boundary, d);
      return selectedIds.length === 0 || selectedIds.includes(pid);
    });

    let totalSale = 0;
    let totalSqft = 0;
    let totalDom = 0;
    let countWithSqft = 0;
    let countWithDom = 0;
    let totalList = 0;
    let countWithList = 0;
    let totalLot = 0;
    let countWithLot = 0;

    selected.forEach((d) => {
      totalSale += d.closePrice;
      if (d.sqft) {
        totalSqft += d.sqft;
        countWithSqft++;
      }
      if (d.cdom || d.dom) {
        totalDom += d.cdom || d.dom;
        countWithDom++;
      }
      if (d.listPrice > 0) {
        totalList += d.listPrice;
        countWithList++;
      }
      if (d.lotSize > 0) {
        totalLot += d.lotSize;
        countWithLot++;
      }
    });

    return {
      count: selected.length,
      avgSale: selected.length ? totalSale / selected.length : 0,
      avgSqft: countWithSqft ? totalSale / totalSqft : 0,
      avgDom: countWithDom ? totalDom / countWithDom : 0,
      totalVolume: totalSale,
      avgList: countWithList ? totalList / countWithList : 0,
      avgLotSize: countWithLot ? totalLot / countWithLot : 0,
    };
  }

  public generateRentalPoints(data: PropertyData[]): PropertyData[] {
    return data.map((d) => ({
      ...d,
      closePrice: d.closePrice * 0.008,
    }));
  }

  private aggregateTimeSeries(
    data: PropertyData[],
    boundary: BoundaryKey,
    metric: MetricKey,
    selectedIds: string[] | undefined,
    periodKeyFn: (ts: number) => string
  ): { period: string; value: number; n: number }[] {
    const buckets: Record<string, number[]> = {};

    data.forEach((d) => {
      const key = this.getBoundaryKey(boundary, d);
      if (!key) return;
      if (selectedIds && selectedIds.length && !selectedIds.includes(key)) return;
      const realPeriod = periodKeyFn(d.closeDateTs);
      if (!realPeriod) return;
      const val = this.getMetricValue(metric, d);
      if (val <= 0 && metric !== 'Days on Market' && metric !== 'List-to-Sale Ratio') return;
      if (!buckets[realPeriod]) buckets[realPeriod] = [];
      buckets[realPeriod].push(val);
    });

    return Object.entries(buckets)
      .map(([period, arr]) => ({ period, value: median(arr), n: arr.length }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  public getTimeSeries(
    data: PropertyData[],
    boundary: BoundaryKey,
    metric: MetricKey,
    selectedIds?: string[]
  ): { period: string; value: number; n: number }[] {
    const monthly = this.aggregateTimeSeries(data, boundary, metric, selectedIds, parseMonthKey);
    // Most CSV exports contain only a few months. Fall back to weekly buckets so
    // the time-series chart can still show a meaningful trend.
    if (monthly.length >= 3) return monthly;
    const weekly = this.aggregateTimeSeries(data, boundary, metric, selectedIds, parseWeekKey);
    return weekly.length >= 3 ? weekly : monthly;
  }

  public getTimeSeriesForBoundary(
    data: PropertyData[],
    boundary: BoundaryKey,
    metric: MetricKey,
    boundaryId: string
  ): { period: string; value: number; n: number }[] {
    return this.getTimeSeries(data, boundary, metric, [boundaryId]);
  }

  private linearRegression(x: number[], y: number[]) {
    const n = x.length;
    if (n < 2) return { slope: 0, intercept: 0, r2: 0 };
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((s, xi, i) => s + xi * y[i], 0);
    const sumXX = x.reduce((s, xi) => s + xi * xi, 0);
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 };
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    const yMean = sumY / n;
    const ssTot = y.reduce((s, yi) => s + Math.pow(yi - yMean, 2), 0);
    const ssRes = y.reduce((s, yi, i) => s + Math.pow(yi - (slope * x[i] + intercept), 2), 0);
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    return { slope, intercept, r2 };
  }

  private parsePeriodToDate(period: string): Date {
    if (period.includes('W')) {
      const [yearStr, weekStr] = period.split('-W');
      const year = Number(yearStr);
      const week = Number(weekStr);
      const d = new Date(year, 0, 1);
      if (!isNaN(week)) {
        d.setDate(d.getDate() + (week - 1) * 7);
      }
      return d;
    }
    const d = new Date(period + '-01');
    return isNaN(d.getTime()) ? new Date() : d;
  }

  public buildForecast(ts: { period: string; value: number; n: number }[]): {
    periods: string[];
    fitted: number[];
    forecast: number[];
    isForecast: boolean[];
    slope: number;
    intercept: number;
    r2: number;
    annualDelta: number;
    annualPct: number;
    baseline: number;
    forecast3yr: number;
  } | null {
    // Need at least 2 points to draw any line. With 2 points R² is always 1.0;
    // we still produce a forecast but downstream UI should hide the R² badge in that case.
    if (!ts || ts.length < 2) return null;
    const x = ts.map((_, i) => i);
    const y = ts.map((d) => d.value);
    const { slope, intercept, r2 } = this.linearRegression(x, y);
    if (!isFinite(slope) || !isFinite(intercept)) return null;

    const monthlySlope = slope;
    const annualDelta = monthlySlope * 12;
    const baseline = y[y.length - 1] || intercept;
    const annualPct = baseline ? (annualDelta / baseline) * 100 : 0;
    const forecast3yr = baseline + annualDelta * 3;

    const lastIndex = x[x.length - 1];
    const forecastMonths = 60;
    const periods: string[] = [];
    const fitted: number[] = [];
    const forecast: number[] = [];
    const isForecast: boolean[] = [];

    // Extend period labels by month.
    const lastDate = ts.length ? this.parsePeriodToDate(ts[ts.length - 1].period) : new Date();
    for (let i = 0; i <= lastIndex + forecastMonths; i++) {
      const d = new Date(lastDate);
      d.setMonth(d.getMonth() + (i - lastIndex));
      const label = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
      const yhat = slope * i + intercept;
      periods.push(label);
      fitted.push(i <= lastIndex ? yhat : yhat);
      forecast.push(i > lastIndex ? yhat : NaN);
      isForecast.push(i > lastIndex);
    }

    return {
      periods,
      fitted,
      forecast,
      isForecast,
      slope,
      intercept,
      r2,
      annualDelta,
      annualPct,
      baseline,
      forecast3yr,
    };
  }

  public getForecastForSelection(
    data: PropertyData[],
    boundary: BoundaryKey,
    metric: MetricKey,
    selectedIds: string[]
  ): {
    region: string;
    baseline: number;
    annualDelta: number;
    annualPct: number;
    r2: number;
    forecast3yr: number;
  }[] {
    // When no areas are explicitly selected, show a single aggregated forecast
    // for all visible properties so the comparison table is never empty.
    if (!selectedIds.length) {
      const ts = this.getTimeSeries(data, boundary, metric);
      const fc = this.buildForecast(ts);
      if (!fc) return [];
      return [
        {
          region: 'All visible areas',
          baseline: fc.baseline,
          annualDelta: fc.annualDelta,
          annualPct: fc.annualPct,
          r2: fc.r2,
          forecast3yr: fc.forecast3yr,
        },
      ];
    }

    // Pre-group all data by boundary key in one pass to avoid re-scanning the
    // full dataset for every selected id.
    const selectedSet = new Set(selectedIds);
    const groups: Record<string, PropertyData[]> = {};
    data.forEach((d) => {
      const key = this.getBoundaryKey(boundary, d);
      if (!key || !selectedSet.has(key)) return;
      if (!groups[key]) groups[key] = [];
      groups[key].push(d);
    });

    return selectedIds
      .map((id) => {
        const items = groups[id];
        if (!items?.length) return null;
        const ts = this.getTimeSeries(items, boundary, metric);
        const fc = this.buildForecast(ts);
        if (!fc) return null;
        return {
          region: id,
          baseline: fc.baseline,
          annualDelta: fc.annualDelta,
          annualPct: fc.annualPct,
          r2: fc.r2,
          forecast3yr: fc.forecast3yr,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  public getAppreciationRate(data: PropertyData[], boundary: BoundaryKey, boundaryId?: string): number {
    const filtered = boundaryId ? data.filter((d) => this.getBoundaryKey(boundary, d) === boundaryId) : data;
    const byYear: Record<number, number[]> = {};
    filtered.forEach((d) => {
      if (!d.closeYear) return;
      if (!byYear[d.closeYear]) byYear[d.closeYear] = [];
      byYear[d.closeYear].push(d.closePrice);
    });
    const years = Object.keys(byYear)
      .map(Number)
      .sort((a, b) => a - b);
    if (years.length < 2) return 0;
    const first = median(byYear[years[0]]);
    const last = median(byYear[years[years.length - 1]]);
    if (!first) return 0;
    const yearsDiff = years[years.length - 1] - years[0];
    if (!yearsDiff) return 0;
    const cagr = (Math.pow(last / first, 1 / yearsDiff) - 1) * 100;
    return isFinite(cagr) ? cagr : 0;
  }

  public getMarketHealth(
    data: PropertyData[],
    boundary: BoundaryKey,
    selectedIds: string[],
    marketType: 'sale' | 'rental' = 'sale'
  ) {
    // When nothing is selected, report on all visible properties so the panel
    // always shows market health.
    const selectedSet = new Set(selectedIds);
    const selected = selectedIds.length
      ? data.filter((d) => {
          const key = this.getBoundaryKey(boundary, d);
          return selectedSet.has(key);
        })
      : data;
    if (!selected.length) return null;

    const domArr = selected.map((d) => d.cdom || d.dom).filter((v) => v > 0);
    const l2sArr = selected
      .map((d) => (d.listPrice > 0 ? (d.closePrice / d.listPrice) * 100 : 0))
      .filter((v) => v > 0);

    const dom = domArr.length ? median(domArr) : null;
    const l2s = l2sArr.length ? median(l2sArr) : null;

    const clamp = (v: number, lo: number, hi: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));

    const scores: Record<string, number> = {};
    const weights: Record<string, number> = {};

    if (dom !== null) {
      if (marketType === 'rental') {
        scores['Days on Market'] = clamp(60 - dom, 0, 50);
      } else {
        scores['Days on Market'] = clamp(90 - dom, 0, 70);
      }
      weights['Days on Market'] = 0.45;
    }

    if (l2s !== null) {
      if (marketType === 'rental') {
        scores['List-to-Lease Ratio'] = clamp(l2s - 95, 0, 6);
      } else {
        scores['List-to-Sale Ratio'] = clamp(l2s - 94, 0, 8);
      }
      weights[marketType === 'rental' ? 'List-to-Lease Ratio' : 'List-to-Sale Ratio'] = 0.35;
    }

    // Inventory proxy: fewer months of inventory = hotter market.
    const monthsInPeriod = 6; // rough fixed window
    const moi = selected.length / Math.max(monthsInPeriod, 1);
    scores['Months of Inventory'] = clamp(marketType === 'rental' ? 3 - moi : 7 - moi, 0, marketType === 'rental' ? 2.5 : 5);
    weights['Months of Inventory'] = 0.2;

    const totalW = Object.values(weights).reduce((a, b) => a + b, 0);
    if (!totalW) return null;
    const finalScore = Object.entries(scores).reduce((sum, [k, v]) => sum + (v * weights[k]) / totalW, 0);

    let label: string;
    let color: string;
    if (marketType === 'rental') {
      if (finalScore >= 65) { label = "Landlord's Market"; color = '#ef4444'; }
      else if (finalScore >= 35) { label = 'Neutral Market'; color = '#f59e0b'; }
      else { label = "Renter's Market"; color = '#3b82f6'; }
    } else {
      if (finalScore >= 65) { label = "Seller's Market"; color = '#ef4444'; }
      else if (finalScore >= 35) { label = 'Neutral Market'; color = '#f59e0b'; }
      else { label = "Buyer's Market"; color = '#3b82f6'; }
    }

    return {
      score: Math.round(finalScore * 10) / 10,
      label,
      color,
      marketType,
      metrics: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.round(v * 10) / 10])),
      dom,
      l2s,
      moi,
    };
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
