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

const RENT_PRICE_HEADERS = [
  'Lease Price',
  'Rent Price',
  'Rental Price',
  'Monthly Rent',
  'Lease Amount',
  'Price',
  'Close Price',
  'Original List Price',
];

const LIST_RENT_HEADERS = [
  'Original List Price',
  'List Price',
  'Original Rent',
  'Listed Rent',
];

const LEASE_DATE_HEADERS = [
  'Lease Date',
  'Rented Date',
  'Contract Date',
  'Close Date',
  'Lease Start Date',
  'Lease Date',
];

const TAX_MLS_HEADERS = ['MLS #', 'MLS Number', 'MLS'];
const TAX_YEAR_HEADERS = ['Tax Year'];
const TAX_AMOUNT_HEADERS = ['Tax Amount', 'Taxes'];
const TAX_RATE_HEADERS = ['Tax Rate', 'Tax Rate %'];

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

function pickFirst(row: Record<string, string>, headers: string[]): string {
  for (const h of headers) {
    const v = row[h];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function isRentType(type: SqlImportType): boolean {
  return type === 'rent' || type === 'current-rent';
}

function isSaleType(type: SqlImportType): boolean {
  return type === 'sales' || type === 'current-sale';
}

function isTaxType(type: SqlImportType): boolean {
  return type === 'tax';
}

/** True when the row has the minimum fields required for a property row. */
export function isPropertyRowValid(row: Record<string, string>, type: SqlImportType): boolean {
  const price = isRentType(type)
    ? cleanNumber(pickFirst(row, RENT_PRICE_HEADERS))
    : cleanNumber(row['Close Price'] || row['Original List Price']);
  const lat = Number(row['Latitude']);
  const lng = Number(row['Longitude']);
  const mls = String(row['MLS Number'] || '').trim();
  return !!(mls && price && lat && lng);
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
  if (!isSaleType(type) && !isRentType(type) && !isTaxType(type)) {
    // Reserved for future school imports.
    throw new Error(`SQL import type '${type}' is not implemented yet.`);
  }

  const sqlRows: Record<string, unknown>[] = [];
  for (const raw of rows) {
    const row: Record<string, string> = {};
    for (const key of Object.keys(raw)) {
      row[stripBom(key)] = raw[key];
    }

    if (isTaxType(type)) {
      const mls = String(pickFirst(row, TAX_MLS_HEADERS) || '').trim();
      if (!mls) continue;
      const taxRate = cleanNumber(pickFirst(row, TAX_RATE_HEADERS));
      const taxYear = cleanNumber(pickFirst(row, TAX_YEAR_HEADERS));
      const taxAmount = cleanNumber(pickFirst(row, TAX_AMOUNT_HEADERS));
      // Skip empty tax rows, but a single non-zero field is enough to keep.
      if (!taxRate && !taxYear && !taxAmount) continue;
      sqlRows.push({
        mlsNumber: mls,
        listingType: 'tax',
        taxRate,
        taxYear,
        taxAmount,
      });
      continue;
    }

    if (!isPropertyRowValid(row, type)) continue;

    const rentMode = isRentType(type);
    const close = rentMode
      ? cleanDate(pickFirst(row, LEASE_DATE_HEADERS))
      : cleanDate(row['Close Date'] || '');
    const baths = cleanNumber(row['FB']) + cleanNumber(row['HB']);
    const sqft = cleanNumber(row['SF']);
    const closePrice = rentMode
      ? cleanNumber(pickFirst(row, RENT_PRICE_HEADERS))
      : cleanNumber(row['Close Price'] || row['Original List Price']);
    const listPrice = rentMode
      ? cleanNumber(pickFirst(row, LIST_RENT_HEADERS))
      : cleanNumber(row['Original List Price']);
    const pricePerSqft =
      cleanNumber(row['Price Sq Ft Sold'] || row['Prc/SF']) ||
      (sqft ? closePrice / sqft : 0);
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

      // Tax data is intentionally left untouched for property imports.
      // Tax records are imported separately via type: 'tax' so they never
      // overwrite tax fields on subsequent sales uploads.

      // Boundary / area fields that come from the CSV itself.
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

      // Distinguishes rental records from sales records in the SQL table.
      listingType: rentMode ? 'rent' : 'sale',
    });
  }
  return sqlRows;
}

export { SALES_REQUIRED_HEADERS };
