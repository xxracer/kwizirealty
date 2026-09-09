/**
 * engineCore — the dependency-free heart of the real-estate engine.
 *
 * Everything here is PURE: types, row normalization and the aggregation math
 * (filters, per-area medians, time series, forecast, market health). There are
 * zero imports — deliberately — so the module can run in a Web Worker without
 * dragging Firebase or the CMS store into the worker bundle.
 *
 * `engine.ts` wraps these functions in the RealEstateEngine class (adding the
 * Firebase data plumbing + caches) and re-exports them for compatibility.
 */

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

// Defaults must be no-ops: every max matches (or exceeds) the top of its
// sidebar slider so the untouched filter state includes the whole dataset.
// The previous defaults (saleMax $5M, rentMax $10k, l2sMin 80, domMax 365…)
// silently dropped millions-dollar homes and stale listings from every stat.
export const DEFAULT_FILTERS: PropertyFilters = {
  bedsMin: 0,
  bedsMax: 20,
  bathsMin: 0,
  bathsMax: 20,
  sqftMin: 0,
  sqftMax: 20000,
  saleMin: 0,
  saleMax: 20000000,
  rentMin: 0,
  rentMax: 50000,
  pricePerSqftMin: 0,
  pricePerSqftMax: 5000,
  lotSizeMin: 0,
  lotSizeMax: 1000000,
  domMin: 0,
  domMax: 2000,
  l2sMin: 50,
  l2sMax: 150,
  yearMin: 1920,
  yearMax: new Date().getFullYear(),
  // The user picks the close-period window in the map sidebar; 'all' means no
  // date cutoff, so the default shows every sale in the dataset instead of
  // hiding older ones behind a fixed 5-year window.
  period: 'all',
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

export interface DataQualitySummary {
  totalRowsRead: number;
  keptRows: number;
  missingZip: number;
  missingCoordinates: number;
  missingPrice: number;
  uniqueZips: number;
}

/** TEA scores per school level, keyed by normalized school name. */
export type TeaScoreMap = Record<'elementary' | 'middle' | 'high', Record<string, number>>;

/** Structural subset of the CMS metric override the aggregation needs. */
export interface MetricOverrideLite {
  boundary: string;
  metric: string;
  boundaryId: string;
  value: number;
}

export interface TimeSeriesPoint {
  period: string;
  value: number;
  n: number;
}

export interface ForecastResult {
  periods: string[];
  fitted: number[];
  forecast: number[];
  actual: (number | null)[];
  lower: number[];
  upper: number[];
  isForecast: boolean[];
  slope: number;
  intercept: number;
  r2: number;
  annualDelta: number;
  annualPct: number;
  baseline: number;
  forecast3yr: number;
  forecast5yr: number;
  sigma: number;
}

export function cleanNumber(val: unknown): number {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return isFinite(val) ? val : 0;
  const cleaned = String(val).replace(/[^0-9.\-]+/g, '');
  const n = Number(cleaned);
  return isFinite(n) ? n : 0;
}

export function cleanDate(raw: string): { date: string; year: number; ts: number } {
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

export function cleanBool(raw: string): boolean {
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

export function periodToDates(period: PropertyFilters['period'], reference: Date) {
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

export function median(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentileRank(sorted: number[], value: number): number {
  if (!sorted.length) return 50;
  const idx = sorted.findIndex((v) => v >= value);
  if (idx === -1) return 100;
  return Math.max(0, Math.min(100, (idx / sorted.length) * 100));
}

export function parseMonthKey(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return `${y}-${m.toString().padStart(2, '0')}`;
}

export function parseWeekKey(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const oneJan = new Date(y, 0, 1);
  const dayOfYear = Math.floor((d.getTime() - oneJan.getTime()) / 86400000) + 1;
  const week = Math.ceil(dayOfYear / 7);
  return `${y}-W${week.toString().padStart(2, '0')}`;
}

export function scoreToGrade(score: number): string {
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

/** CSV row → normalized PropertyData (or null when required fields are missing). */
export function normalizeRow(row: Record<string, unknown>): PropertyData | null {
  const close = cleanDate(String(row['Close Date'] || ''));
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
    pool: cleanBool(String(row['Pool Private'] || '')),
  };
}

export function normalizeRows(
  rows: Record<string, unknown>[],
  quality?: DataQualitySummary,
  zipSet?: Set<string>
): PropertyData[] {
  const out: PropertyData[] = [];
  for (const row of rows) {
    const close = cleanDate(String(row['Close Date'] || ''));
    const closePrice = cleanNumber(row['Close Price'] || row['Original List Price']);
    const lat = Number(row['Latitude']);
    const lng = Number(row['Longitude']);
    const zipRaw = String(row['Zip'] || '').trim();

    if (quality && zipSet) {
      if (!zipRaw || zipRaw.toUpperCase() === 'NA' || zipRaw.toUpperCase() === 'N/A') {
        quality.missingZip++;
      } else {
        zipSet.add(zipRaw);
      }
      if (!lat || !lng) quality.missingCoordinates++;
      if (!closePrice) quality.missingPrice++;
    }

    const item = normalizeRow(row);
    if (!item) continue;
    out.push(item);
    // NOTE: keptRows is NOT incremented here — the original engine counted it
    // at the call sites (`quality.keptRows += newItems.length`), so callers
    // must keep doing that to stay byte-identical with the old behavior.
  }
  return out;
}

/** Structural subset of the CMS single-property override. */
export interface PropertyOverrideLite {
  id: string;
  mlsNumber: string;
  address: string;
  zip: string;
  fields: Record<string, string>;
  mode?: 'edit' | 'create';
}

/** Serialize a PropertyData row (or an override's own fields) back into CSV
 *  header form so it can flow through normalizeRow like any other row. */
export function buildRowFromOverride(o: PropertyOverrideLite, base?: PropertyData): Record<string, string> {
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

/** Apply single-property overrides to `rows` in place (engine parity). */
export function applyPropertyOverrides(
  rows: PropertyData[],
  overrides: PropertyOverrideLite[],
  quality?: DataQualitySummary
): void {
  const keyFor = (d: PropertyData) => d.mlsNumber || `${d.address}|${d.zip}`;

  overrides.forEach((o) => {
    const target = rows.find(
      (d) =>
        (o.mlsNumber && d.mlsNumber === o.mlsNumber) ||
        (o.address && o.zip && d.address === o.address && d.zip === o.zip)
    );

    const isCreate = o.mode === 'create';
    if (!target && !isCreate) return;

    if (isCreate && (!o.fields['Address'] || !o.fields['Zip'] || !o.fields['Latitude'] || !o.fields['Longitude'])) {
      return;
    }

    if (quality) quality.totalRowsRead++;
    const row = buildRowFromOverride(o, target);
    const items = normalizeRows([row]);
    if (items.length) {
      const item = items[0];
      const k = keyFor(item);
      const idx = rows.findIndex((d) => keyFor(d) === k);
      if (idx >= 0) rows.splice(idx, 1);
      rows.push(item);
      if (quality) quality.keptRows++;
    }
  });
}

/** FNV-1a hash of a row's identity — deterministic across reloads. */
export function rowHash(r: PropertyData): number {
  const s = r.mlsNumber || r.address || '';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Uniform hash sample down to `cap` rows. */
export function subsampleRows(rows: PropertyData[], cap: number): PropertyData[] {
  if (!isFinite(cap) || rows.length <= cap) return rows;
  const k = Math.max(1, Math.ceil(rows.length / cap));
  return rows.filter((r) => rowHash(r) % k === 0);
}

/**
 * Deduplicate repeated strings across the dataset. Rows share the same few
 * thousand city/school/subdivision names, but JSON.parse gives EVERY row its
 * own copy of each string — on the ~763k-row dataset that is hundreds of MB
 * of duplicates (a real crash cause on 4 GB machines). After this pass all
 * rows share one string instance per unique value.
 */
export function internStrings(rows: PropertyData[]): void {
  // Only massively-repeated fields. Unique-per-row strings (address,
  // mlsNumber) are skipped — interning those would only add pool overhead.
  const fields: (keyof PropertyData)[] = [
    'state',
    'city',
    'zip',
    'zipcodes',
    'subdivisions',
    'highschools',
    'highschoolName',
    'elementary',
    'middle',
    'schoolDistrict',
    'marketArea',
    'area',
    'propertyType',
    'maintFeeSchedule',
    'closeDate',
  ];
  const pools = new Map<string, Map<string, string>>();
  for (const f of fields) pools.set(f as string, new Map());
  for (const d of rows) {
    for (const f of fields) {
      const v = d[f] as unknown;
      if (typeof v !== 'string' || v === '') continue;
      const pool = pools.get(f as string)!;
      const canon = pool.get(v);
      if (canon !== undefined) {
        (d as unknown as Record<string, unknown>)[f as string] = canon;
      } else {
        pool.set(v, v);
      }
    }
  }
}

export function getReferenceDate(data: PropertyData[]): Date {
  if (!data.length) return new Date();
  let maxTs = 0;
  data.forEach((d) => {
    if (d.closeDateTs) {
      if (d.closeDateTs > maxTs) maxTs = d.closeDateTs;
    }
  });
  return maxTs ? new Date(maxTs) : new Date();
}

export function getBoundaryKeyFor(boundary: BoundaryKey, item: PropertyData): string {
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

export function getRentalPrice(item: PropertyData): number {
  return item.closePrice * 0.008;
}

export function getAnnualHOAFee(item: PropertyData): number {
  const fee = item.maintFee;
  if (!fee) return 0;
  const sched = item.maintFeeSchedule || 'annually';
  if (sched.includes('month')) return fee * 12;
  if (sched.includes('quarter')) return fee * 4;
  if (sched.includes('semi') || sched.includes('half')) return fee * 2;
  return fee;
}

export function getMetricValue(metric: MetricKey, item: PropertyData): number {
  const rentalPrice = getRentalPrice(item);
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
      return getAnnualHOAFee(item);
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

export function getRealSchoolScore(teaScores: TeaScoreMap, level: 'elementary' | 'middle' | 'high', name: string): number {
  if (!name) return 0;
  return teaScores[level][name] || teaScores[level][cleanSchoolName(name)] || 0;
}

export function filterProperties(
  data: PropertyData[],
  filters: PropertyFilters,
  teaScores: TeaScoreMap,
  refDate?: Date
): PropertyData[] {
  const ref = refDate || getReferenceDate(data);
  const { start, end } = periodToDates(filters.period, ref);

  return data.filter((d) => {
    if (d.closePrice < filters.saleMin || d.closePrice > filters.saleMax) return false;
    if (d.sqft < filters.sqftMin || d.sqft > filters.sqftMax) return false;
    if (d.yearBuilt < filters.yearMin || d.yearBuilt > filters.yearMax) return false;
    if (d.br < filters.bedsMin || d.br > filters.bedsMax) return false;
    if (d.baths < filters.bathsMin || d.baths > filters.bathsMax) return false;

    // Rows with no list price have no list-to-sale ratio at all — they carry
    // no information about the ratio, so don't drop them (l2s was computed
    // as 0 before, which excluded them even with a permissive range).
    if (d.listPrice > 0) {
      const l2s = (d.closePrice / d.listPrice) * 100;
      if (l2s < filters.l2sMin || l2s > filters.l2sMax) return false;
    }

    const dom = d.cdom || d.dom;
    if (dom < filters.domMin || dom > filters.domMax) return false;

    if (d.lotSize < filters.lotSizeMin || d.lotSize > filters.lotSizeMax) return false;

    const ppsf = d.pricePerSqft || (d.sqft ? d.closePrice / d.sqft : 0);
    if (ppsf < filters.pricePerSqftMin || ppsf > filters.pricePerSqftMax) return false;

    const estRent = d.closePrice * 0.008;
    if (estRent < filters.rentMin || estRent > filters.rentMax) return false;

    // A time period must actually filter: rows with no parseable close date
    // can't be placed in the window, so they only survive 'all' (start=null).
    if (start) {
      if (!d.closeDateTs) return false;
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
      const score = getRealSchoolScore(teaScores, 'elementary', d.elementary);
      if (!filters.elementaryRating.includes(scoreToGrade(score))) return false;
    }
    if (filters.middleRating.length) {
      const score = getRealSchoolScore(teaScores, 'middle', d.middle);
      if (!filters.middleRating.includes(scoreToGrade(score))) return false;
    }
    if (filters.highRating.length) {
      const score = getRealSchoolScore(teaScores, 'high', d.highschoolName);
      if (!filters.highRating.includes(scoreToGrade(score))) return false;
    }

    return true;
  });
}

export function getAppreciationRateForItems(items: PropertyData[]): number {
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

export function getInvestorIndexForItems(items: PropertyData[]): number {
  if (!items.length) return 0;
  const rtsArr = items
    .map((d) => (d.closePrice > 0 ? (getRentalPrice(d) * 12) / d.closePrice : 0))
    .filter((v) => v > 0);
  const domArr = items.map((d) => d.cdom || d.dom).filter((v) => v > 0);
  const appreciation = getAppreciationRateForItems(items);

  const rentToSale = rtsArr.length ? median(rtsArr) : 0;
  const dom = domArr.length ? median(domArr) : 0;

  const clamp = (v: number, lo: number, hi: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const rtsScore = clamp(rentToSale, 0.03, 0.15);
  const appScore = clamp(appreciation, -5, 15);
  const domScore = clamp(90 - dom, 0, 70);

  const idx = rtsScore * 0.4 + appScore * 0.3 + (domScore / 70) * 100 * 0.3;
  return Math.max(0, Math.min(100, idx));
}

export function computeDistrictHighScores(data: PropertyData[], teaScores: TeaScoreMap): Record<string, number> {
  const groups: Record<string, number[]> = {};
  data.forEach((d) => {
    if (!d.highschools) return;
    const score = getRealSchoolScore(teaScores, 'high', d.highschoolName);
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

export function getMapValues(
  data: PropertyData[],
  boundary: BoundaryKey,
  metric: MetricKey,
  teaScores: TeaScoreMap,
  cmsOverrides: MetricOverrideLite[] = []
): { values: Record<string, number>; counts: Record<string, number>; names: Record<string, string> } {
  const groups: Record<string, PropertyData[]> = {};
  const names: Record<string, string> = {};

  data.forEach((d) => {
    const key = getBoundaryKeyFor(boundary, d);
    if (!key) return;
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
    names[key] = key;
  });

  const values: Record<string, number> = {};
  const counts: Record<string, number> = {};

  if (metric === 'Elem ETA Score') {
    Object.entries(groups).forEach(([key, items]) => {
      const score = getRealSchoolScore(teaScores, 'elementary', key);
      values[key] = score || 0;
      counts[key] = items.length;
    });
  } else if (metric === 'Middle ETA Score') {
    Object.entries(groups).forEach(([key, items]) => {
      const score = getRealSchoolScore(teaScores, 'middle', key);
      values[key] = score || 0;
      counts[key] = items.length;
    });
  } else if (metric === 'High ETA Score') {
    Object.entries(groups).forEach(([key, items]) => {
      const scores = items
        .map((d) => getRealSchoolScore(teaScores, 'high', d.highschoolName))
        .filter((v) => v > 0);
      values[key] = scores.length ? median(scores) : 0;
      counts[key] = items.length;
    });
  } else {
    Object.entries(groups).forEach(([key, items]) => {
      if (!items.length) return;
      let value: number;
      if (metric === 'Appreciation Rate') {
        value = getAppreciationRateForItems(items);
      } else if (metric === 'Investor Index') {
        value = getInvestorIndexForItems(items);
      } else {
        const arr = items
          .map((d) => getMetricValue(metric, d))
          .filter((v) => v > 0 || metric === 'Days on Market' || metric === 'List-to-Sale Ratio' || metric === 'Last Year Tax Rate');
        if (!arr.length) return;
        value = median(arr);
      }
      values[key] = value;
      counts[key] = items.length;
    });
  }

  // Apply manual CMS metric overrides.
  cmsOverrides.forEach((o) => {
    if (o.boundary === boundary && o.metric === metric && values[o.boundaryId] !== undefined) {
      values[o.boundaryId] = o.value;
    }
  });

  return { values, counts, names };
}

export function getStatsForSelection(
  data: PropertyData[],
  boundary: BoundaryKey,
  selectedIds: string[]
) {
  const selected = data.filter((d) => {
    const pid = getBoundaryKeyFor(boundary, d);
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

function aggregateTimeSeries(
  data: PropertyData[],
  boundary: BoundaryKey,
  metric: MetricKey,
  selectedIds: string[] | undefined,
  periodKeyFn: (ts: number) => string
): TimeSeriesPoint[] {
  const buckets: Record<string, number[]> = {};

  data.forEach((d) => {
    const key = getBoundaryKeyFor(boundary, d);
    if (!key) return;
    if (selectedIds && selectedIds.length && !selectedIds.includes(key)) return;
    const realPeriod = periodKeyFn(d.closeDateTs);
    if (!realPeriod) return;
    const val = getMetricValue(metric, d);
    if (val <= 0 && metric !== 'Days on Market' && metric !== 'List-to-Sale Ratio') return;
    if (!buckets[realPeriod]) buckets[realPeriod] = [];
    buckets[realPeriod].push(val);
  });

  return Object.entries(buckets)
    .map(([period, arr]) => ({ period, value: median(arr), n: arr.length }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

export function getTimeSeries(
  data: PropertyData[],
  boundary: BoundaryKey,
  metric: MetricKey,
  selectedIds?: string[]
): TimeSeriesPoint[] {
  const monthly = aggregateTimeSeries(data, boundary, metric, selectedIds, parseMonthKey);
  // Most CSV exports contain only a few months. Fall back to weekly buckets so
  // the time-series chart can still show a meaningful trend.
  if (monthly.length >= 3) return monthly;
  const weekly = aggregateTimeSeries(data, boundary, metric, selectedIds, parseWeekKey);
  return weekly.length >= 3 ? weekly : monthly;
}

export function linearRegression(x: number[], y: number[]) {
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

export function parsePeriodToDate(period: string): Date {
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

export function buildForecast(ts: TimeSeriesPoint[]): ForecastResult | null {
  // Need at least 2 points to draw any line. With 2 points R² is always 1.0;
  // we still produce a forecast but downstream UI should hide the R² badge in that case.
  if (!ts || ts.length < 2) return null;
  const x = ts.map((_, i) => i);
  const y = ts.map((d) => d.value);

  // Weighted least squares. Two weight sources:
  //  - recency: recent months describe the current trend better than old ones
  //    (0.9^age ≈ half-weight after ~7 months, quarter after ~13)
  //  - sample size: a month aggregated from 400 sales is far more reliable
  //    than one from 12, so weight by sqrt(n) (n=0 falls back to 1).
  const lastIndex = x[x.length - 1];
  const weights = ts.map((d, i) => Math.pow(0.9, lastIndex - i) * Math.sqrt(d.n > 0 ? d.n : 1));

  let wSum = 0;
  let wxSum = 0;
  let wySum = 0;
  let wxxSum = 0;
  let wxySum = 0;
  for (let i = 0; i < x.length; i++) {
    const w = weights[i];
    wSum += w;
    wxSum += w * x[i];
    wySum += w * y[i];
    wxxSum += w * x[i] * x[i];
    wxySum += w * x[i] * y[i];
  }
  const meanX = wxSum / wSum;
  const meanY = wySum / wSum;
  const sxx = wxxSum - wSum * meanX * meanX;
  const sxy = wxySum - wSum * meanX * meanY;
  const slope = sxx !== 0 ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  if (!isFinite(slope) || !isFinite(intercept)) return null;

  // Weighted R²: share of weighted variance the trend explains.
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < x.length; i++) {
    const resid = y[i] - (slope * x[i] + intercept);
    ssRes += weights[i] * resid * resid;
    ssTot += weights[i] * (y[i] - meanY) * (y[i] - meanY);
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Weighted residual scale → 95% prediction interval. The band widens away
  // from the data centroid (classic prediction-interval form) so far-future
  // months are visibly less certain than next-month ones.
  const sigma = wSum > 0 ? Math.sqrt(ssRes / wSum) : 0;
  const z = 1.96;
  const intervalHalf = (xi: number) =>
    z * sigma * Math.sqrt(1 + 1 / wSum + ((xi - meanX) * (xi - meanX)) / (sxx || 1));

  const monthlySlope = slope;
  const annualDelta = monthlySlope * 12;
  // Baseline is the FITTED value at "today" — the raw last month can be a
  // noisy outlier, the fitted endpoint is the trend's best estimate.
  const baseline = slope * lastIndex + intercept;
  const annualPct = baseline ? (annualDelta / baseline) * 100 : 0;
  const forecast3yr = baseline + annualDelta * 3;
  const forecast5yr = baseline + annualDelta * 60;

  const forecastMonths = 60;
  const periods: string[] = [];
  const fitted: number[] = [];
  const forecast: number[] = [];
  const actual: (number | null)[] = [];
  const lower: number[] = [];
  const upper: number[] = [];
  const isForecast: boolean[] = [];

  // Extend period labels by month.
  const lastDate = ts.length ? parsePeriodToDate(ts[ts.length - 1].period) : new Date();
  for (let i = 0; i <= lastIndex + forecastMonths; i++) {
    const d = new Date(lastDate);
    d.setMonth(d.getMonth() + (i - lastIndex));
    const label = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
    const yhat = slope * i + intercept;
    const half = intervalHalf(i);
    periods.push(label);
    fitted.push(yhat);
    forecast.push(i > lastIndex ? yhat : NaN);
    actual.push(i < ts.length ? ts[i].value : null);
    lower.push(Math.max(0, yhat - half));
    upper.push(yhat + half);
    isForecast.push(i > lastIndex);
  }

  return {
    periods,
    fitted,
    forecast,
    actual,
    lower,
    upper,
    isForecast,
    slope,
    intercept,
    r2,
    annualDelta,
    annualPct,
    baseline,
    forecast3yr,
    forecast5yr,
    sigma,
  };
}

export interface ForecastComparisonRow {
  region: string;
  baseline: number;
  annualDelta: number;
  annualPct: number;
  r2: number;
  forecast3yr: number;
}

export function getForecastForSelection(
  data: PropertyData[],
  boundary: BoundaryKey,
  metric: MetricKey,
  selectedIds: string[]
): ForecastComparisonRow[] {
  // When no areas are explicitly selected, show a single aggregated forecast
  // for all visible properties so the comparison table is never empty.
  if (!selectedIds.length) {
    const ts = getTimeSeries(data, boundary, metric);
    const fc = buildForecast(ts);
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
    const key = getBoundaryKeyFor(boundary, d);
    if (!key || !selectedSet.has(key)) return;
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
  });

  return selectedIds
    .map((id) => {
      const items = groups[id];
      if (!items?.length) return null;
      const ts = getTimeSeries(items, boundary, metric);
      const fc = buildForecast(ts);
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

export function getAppreciationRate(data: PropertyData[], boundary: BoundaryKey, boundaryId?: string): number {
  const filtered = boundaryId ? data.filter((d) => getBoundaryKeyFor(boundary, d) === boundaryId) : data;
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

export interface MarketHealthResult {
  score: number;
  label: string;
  color: string;
  marketType: 'sale' | 'rental';
  metrics: Record<string, number>;
  dom: number | null;
  l2s: number | null;
  moi: number;
}

export function getMarketHealth(
  data: PropertyData[],
  boundary: BoundaryKey,
  selectedIds: string[],
  marketType: 'sale' | 'rental' = 'sale'
): MarketHealthResult | null {
  // When nothing is selected, report on all visible properties so the panel
  // always shows market health.
  const selectedSet = new Set(selectedIds);
  const selected = selectedIds.length
    ? data.filter((d) => {
        const key = getBoundaryKeyFor(boundary, d);
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