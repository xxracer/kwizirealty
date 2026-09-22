/**
 * sqlImport.ts — CSV → SQL Connect mapping for direct SQL uploads.
 *
 * The admin panel no longer sends property CSVs to Firebase Storage.
 * Instead it POSTs parsed rows to /api/sql/import, which upserts them into
 * the Data Connect `properties` table keyed by mls_number.
 *
 * IMPORTANT: sales-data CSVs may carry extra columns (tax, schools, etc.)
 * but this mapper intentionally ignores them — those categories are imported
 * separately through their own dedicated imports.
 */

export type SqlImportType =
  | 'sales'
  | 'rent'
  | 'current-sale'
  | 'current-rent'
  | 'tax'
  | 'school-elementary'
  | 'school-middle'
  | 'school-high';

const SALES_REQUIRED_HEADERS = [
  'MLS Number',
  'Address',
  'City/Location',
  'State Or Province',
  'Zip',
  'Close Price',
  'Latitude',
  'Longitude',
];

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

/** True when the row has the minimum fields required for a sales property. */
export function isSalesRowValid(row: Record<string, string>): boolean {
  const closePrice = cleanNumber(row['Close Price'] || row['Original List Price']);
  const lat = Number(row['Latitude']);
  const lng = Number(row['Longitude']);
  const mls = String(row['MLS Number'] || '').trim();
  return !!(mls && closePrice && lat && lng);
}

/**
 * Convert raw CSV rows (header keys = original CSV column names) into the
 * SQL `Property` shape. For sales data we deliberately ignore tax/school
 * columns that sometimes appear in the same file — those are imported later
 * through their own dedicated uploads.
 */
export function csvRowsToSqlPropertyRows(
  rows: Record<string, string>[],
  type: SqlImportType
): Record<string, unknown>[] {
  if (type !== 'sales') {
    // Reserved for future rent/tax/school imports.
    throw new Error(`SQL import type '${type}' is not implemented yet.`);
  }

  const sqlRows: Record<string, unknown>[] = [];
  for (const raw of rows) {
    const row: Record<string, string> = {};
    for (const key of Object.keys(raw)) {
      row[stripBom(key)] = raw[key];
    }

    if (!isSalesRowValid(row)) continue;

    const close = cleanDate(row['Close Date'] || '');
    const baths = cleanNumber(row['FB']) + cleanNumber(row['HB']);
    const sqft = cleanNumber(row['SF']);
    const closePrice = cleanNumber(row['Close Price'] || row['Original List Price']);
    const listPrice = cleanNumber(row['Original List Price']);
    const pricePerSqft = cleanNumber(row['Price Sq Ft Sold'] || row['Prc/SF']) || (sqft ? closePrice / sqft : 0);
    const zipRaw = String(row['Zip'] || '').trim();

    sqlRows.push({
      mlsNumber: String(row['MLS Number'] || ''),
      address: String(row['Address'] || ''),
      city: String(row['City/Location'] || ''),
      state: String(row['State Or Province'] || ''),
      zip: zipRaw,
      closePrice,
      listPrice,
      pricePerSqft,
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

      // Tax data is intentionally left at defaults for sales imports.
      taxRate: 0,
      taxYear: 0,
      taxAmount: 0,

      // Boundary / area fields that come from the sales CSV itself.
      subdivisions: cleanBoundaryName(row['Subdivision']),
      zipcodes: zipRaw,
      highschools: cleanDistrictCode(row['School District']),
      highschoolName: cleanSchoolName(row['School High']),
      elementary: cleanSchoolName(row['School Elementary']),
      middle: cleanSchoolName(row['School Middle']),
      schoolDistrict: String(row['School District'] || '').trim(),
      marketArea: String(row['Market Area'] || '').trim(),
      area: String(row['Area'] || '').trim(),

      lat: Number(row['Latitude']),
      lng: Number(row['Longitude']),

      propertyType: String(row['Property Type'] || '').trim(),
      pool: cleanBool(row['Pool Private']),
    });
  }
  return sqlRows;
}

export { SALES_REQUIRED_HEADERS };
