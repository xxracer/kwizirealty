'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import Papa from 'papaparse';
import {
  cmsStore,
  detectDatasetYear,
  type CMSFileRecord,
  type CMSMetricOverride,
  type CMSPropertyOverride,
  type CMSStoreSummary,
  type CMSFileCategory,
} from '@/lib/cmsStore';
import { engine, type BoundaryKey, type MetricKey, type PropertyData } from '@/lib/engine';
import { fetchJsonAutoGz } from '@/lib/fetchJsonAuto';
import { auth } from '@/lib/firebase';
import {
  commitPendingProperties,
  commitPendingSession,
  countCommittedProperties,
  deletePendingSession,
  mergeTaxIntoSaleRows,
  stagePropertyRows,
} from '@/lib/dataConnectClient';
import { publishSqlDatasetVersion } from '@/lib/sqlSync';
import {
  csvToFeatureCollection,
  diffAgainstExisting,
  getFeatureName,
  mergeFeaturesReplacing,
  normalizeGeoJsonCrs,
  type GeoJsonFeature,
  type GeoJsonFeatureCollection,
} from '@/lib/geojsonUpload';
import { AdminAds } from '@/components/admin/AdminAds';
import { AdminUsers } from '@/components/admin/AdminUsers';
import { RequireAdmin } from '@/components/RequireAuth';
import DatasetRebuildBanner from '@/components/admin/DatasetRebuildBanner';
import { watchFreshDeployments } from '@/lib/cacheBuster';
import {
  Upload,
  FileSpreadsheet,
  Database,
  Trash2,
  ArrowLeft,
  RefreshCw,
  Download,
  AlertTriangle,
  CheckCircle,
  Eye,
  X,
  Search,
  BarChart3,
  Map,
  SlidersHorizontal,
  Save,
  Home,
  TrendingUp,
  DollarSign,
  Building,
  School,
  FileText,
  Layers,
  Pencil,
  ChevronRight,
  Plus,
  ChevronDown,
  Megaphone,
  Users,
  Loader2,
} from 'lucide-react';

type AdminSection = 'dashboard' | 'sales' | 'rent' | 'current' | 'tax' | 'schools' | 'boundaries' | 'areas' | 'ads' | 'users';
type DataTab = 'upload' | 'edit';
type PropertyEditMode = 'edit' | 'create';

const REQUIRED_PROPERTY_HEADERS = [
  'MLS Number',
  'Address',
  'City/Location',
  'State Or Province',
  'Zip',
  { oneOf: ['Close Price', 'Lease Price', 'Rent Price', 'Rental Price', 'Monthly Rent', 'Price'] },
  'Latitude',
  'Longitude',
];
const REQUIRED_SCHOOL_HEADERS = ['school_name_clean', 'Overall Score'];
const REQUIRED_TAX_HEADERS = [
  'MLS #',
  { oneOf: ['Tax Year', 'Tax Amount', 'Tax Rate'] },
];

const BOUNDARY_OPTIONS: { value: BoundaryKey; label: string }[] = [
  { value: 'zipcodes', label: 'ZIP Code' },
  { value: 'subdivisions', label: 'Subdivision' },
  { value: 'highschools', label: 'High School District' },
  { value: 'elementary', label: 'Elementary School' },
  { value: 'middle', label: 'Middle School' },
  { value: 'neighborhoods', label: 'Neighborhood' },
];

const METRIC_OPTIONS: { value: MetricKey; label: string }[] = [
  { value: 'Close Price', label: 'Median Close Price' },
  { value: 'Price per Sqft', label: 'Median Price per Sqft' },
  { value: 'List-to-Sale Ratio', label: 'List-to-Sale Ratio %' },
  { value: 'Days on Market', label: 'Median Days on Market' },
  { value: 'Est. Rental Price', label: 'Estimated Rental Price' },
  { value: 'Rent-to-Sale Ratio', label: 'Rent-to-Sale Ratio' },
  { value: 'Lot Size', label: 'Median Lot Size' },
  { value: 'Annual HOA Fee', label: 'Annual HOA Fee' },
  { value: 'Appreciation Rate', label: 'Appreciation Rate %' },
  { value: 'Investor Index', label: 'Investor Index' },
  { value: 'Elem ETA Score', label: 'Elementary School Score' },
  { value: 'Middle ETA Score', label: 'Middle School Score' },
  { value: 'High ETA Score', label: 'High School Score' },
];

const SECTIONS: { id: AdminSection; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <Home className="w-4 h-4" />, desc: 'Overview of all data' },
  { id: 'sales', label: 'Sales Data', icon: <TrendingUp className="w-4 h-4" />, desc: 'Sold prices & history' },
  { id: 'rent', label: 'Rent Data', icon: <DollarSign className="w-4 h-4" />, desc: 'Rental prices & history' },
  { id: 'current', label: 'Current Listings', icon: <Building className="w-4 h-4" />, desc: 'Active for sale / for rent' },
  { id: 'tax', label: 'Tax Records', icon: <FileText className="w-4 h-4" />, desc: 'Assessed values & taxes' },
  { id: 'schools', label: 'School Ratings', icon: <School className="w-4 h-4" />, desc: 'TEA scores' },
  { id: 'areas', label: 'Area Metrics', icon: <Layers className="w-4 h-4" />, desc: 'Boundary GeoJSON uploads' },
  { id: 'ads', label: 'Ads Campaigns', icon: <Megaphone className="w-4 h-4" />, desc: 'Manage advertisements' },
  { id: 'users', label: 'System Users', icon: <Users className="w-4 h-4" />, desc: 'Manage access' },
];

interface SectionConfig {
  title: string;
  subtitle: string;
  whatItModifies: string[];
  requiredColumns: Array<string | { oneOf: string[] }>;
  category: CMSFileCategory | CMSFileCategory[];
  fileHint: string;
}

const SECTION_CONFIG: Record<Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>, SectionConfig> = {
  sales: {
    title: 'Sales Data',
    subtitle: 'Manage sold property records.',
    whatItModifies: [
      'Median sold price per ZIP / subdivision',
      'Price per square foot trends',
      'Days on market',
      'List-to-sale ratio',
    ],
    requiredColumns: REQUIRED_PROPERTY_HEADERS,
    category: ['sales', 'property'],
    fileHint: 'Sale 2021 … Sale 2026 CSVs',
  },
  rent: {
    title: 'Rent Data',
    subtitle: 'Manage rental property records.',
    whatItModifies: [
      'Estimated rental price per area',
      'Rent-to-sale ratio',
      'Rental price per square foot',
    ],
    requiredColumns: REQUIRED_PROPERTY_HEADERS,
    category: ['rent', 'property'],
    fileHint: 'Rent 2021 … Rent 2026 CSVs',
  },
  current: {
    title: 'Current Listings',
    subtitle: 'Manage active for-sale and for-rent listings.',
    whatItModifies: [
      'Active listings on the map',
      'Current list prices',
      'HOA fees shown on property cards',
    ],
    requiredColumns: REQUIRED_PROPERTY_HEADERS,
    category: ['current-sale', 'current-rent', 'property'],
    fileHint: 'Current for Sale / Current for Rent CSVs',
  },
  tax: {
    title: 'Tax Records',
    subtitle: 'Manage tax records.',
    whatItModifies: [
      'Tax amount per property',
      'Tax rate per area',
      'Assessed values on property cards',
    ],
    requiredColumns: REQUIRED_TAX_HEADERS,
    category: 'tax',
    fileHint: 'Tax Data/2025 CSVs',
  },
  schools: {
    title: 'School Ratings',
    subtitle: 'Manage TEA school ratings.',
    whatItModifies: [
      'Elementary, middle and high school ETA scores',
      'School boundary colors on the map',
      'School filter options',
    ],
    requiredColumns: REQUIRED_SCHOOL_HEADERS,
    category: ['school-elementary', 'school-middle', 'school-high'],
    fileHint: 'TEA_Elem_School_Ratings.csv, TEA_Middle_School_Ratings.csv, TEA_High_School_Ratings.csv',
  },
  boundaries: {
    title: 'Map Boundaries',
    subtitle: 'Manage GeoJSON boundary files.',
    whatItModifies: [
      'Zip codes, subdivisions, and school zones drawn on the map',
      'Area boundary overlays',
    ],
    requiredColumns: [],
    category: 'boundary',
    fileHint: 'Zip.geojson, Houston_ISD.geojson, etc.',
  },
  areas: {
    title: 'Area Metrics',
    subtitle: 'Upload the map’s boundary GeoJSON files here (GeoJSON only).',
    whatItModifies: [
      'Subdivisions / neighborhoods polygons (Mapped Subdivisions.geojson)',
      'Zip code polygons (Zip.geojson)',
      'School zone polygons (Elementary / Middle / Houston_ISD)',
      'The map switches to the new polygons as soon as a file with the same name is uploaded',
    ],
    requiredColumns: [],
    category: 'boundary',
    fileHint: 'Mapped Subdivisions.geojson, Zip.geojson, Elementary School ISD.geojson, Houston_ISD.geojson, Middle School ISD.geojson',
  },
};

interface StagedFile {
  id: string;
  file: File;
  section: Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>;
  record: CMSFileRecord;
  stats: {
    total: number;
    new: number;
    duplicate: number;
  };
  /** For SQL-bound property CSVs: session id used to stage/commit rows. */
  sessionId?: string;
  /** Background import progress for SQL-bound files. */
  importProgress?: { loaded: number; total: number; status: 'running' | 'done' | 'error'; error?: string };
  /** Set only for Area Metrics uploads; holds the parsed FeatureCollection. */
  geoJson?: GeoJsonFeatureCollection;
  /** Names of duplicate features detected against the existing custom-area set. */
  duplicateNames?: string[];
  /** Names of new features detected against the existing custom-area set. */
  newNames?: string[];
  /** CSV rows that were skipped during conversion (with reason). */
  csvSkipped?: { row: number; reason: string }[];
  /** For SQL-bound property CSVs: warning shown when some MLS numbers already exist in the live DB. */
  duplicateWarning?: { count: number; sampleMlsNumbers: string[]; status: 'pending' | 'confirmed' };
  /** Zip codes of this file split by whether the row's MLS already existed in
   *  the live database — powers the "Actualizado/Nuevo" locality list in the
   *  upload report card. */
  zipUpdate?: { updated: { name: string; count: number }[]; added: { name: string; count: number }[] };
}

/** Confirmation modal shown before committing all staged files. */
interface ConfirmAllState {
  open: boolean;
  totalFiles: number;
  totalRows: number;
  sqlFiles: number;
  sqlRows: number;
  geoJsonFiles: number;
  years: (number | null)[];
}

/** Preview modal state — extends CMSFileRecord with GeoJSON awareness. */
interface PreviewState extends CMSFileRecord {
  isGeoJson?: boolean;
  totalFeatures?: number;
  geometryTypes?: string;
}

/** Result of the per-section duplicate scan (see runDupesScan). */
interface SectionDupes {
  status: 'idle' | 'loading' | 'done' | 'error';
  totalRows: number;
  duplicateRows: number;
  keyLabel: string;
  samples: { label: string; count: number }[];
  error?: string;
}

const NO_SECTION_DUPES: SectionDupes = {
  status: 'idle',
  totalRows: 0,
  duplicateRows: 0,
  keyLabel: '',
  samples: [],
};

const FIELD_LABELS: Record<string, string> = {
  'Close Price': 'Close Price',
  'DOM': 'Days on Market (DOM)',
  'CDOM': 'Cumulative Days on Market (CDOM)',
  'Close Date': 'Close Date',
  'Est. Rental Price': 'Estimated Rental Price',
  'Rent-to-Sale Ratio': 'Rent-to-Sale Ratio',
  'Status': 'Listing Status',
  'Original List Price': 'Original List Price',
  'List Price': 'Current List Price',
  'Tax Year': 'Tax Year',
  'Tax Amount': 'Tax Amount',
  'Tax Rate': 'Tax Rate',
};

const SALES_QUICK_FIELDS = ['Close Price', 'DOM', 'CDOM', 'Close Date'];
const RENT_QUICK_FIELDS = ['Close Price', 'Est. Rental Price', 'Rent-to-Sale Ratio'];
const CURRENT_QUICK_FIELDS = ['Status', 'Original List Price', 'List Price'];
const TAX_QUICK_FIELDS = ['Tax Year', 'Tax Amount', 'Tax Rate'];

const getEngine = (): typeof engine =>
  (typeof window !== 'undefined' ? (window as any).__kwiziEngine : undefined) || engine;

const FIELD_TO_PROPERTY_KEY: Record<string, keyof PropertyData | undefined> = {
  'Close Price': 'closePrice',
  'DOM': 'dom',
  'CDOM': 'cdom',
  'Close Date': 'closeDate',
  'Est. Rental Price': 'closePrice',
  'Rent-to-Sale Ratio': undefined,
  'Status': undefined,
  'Original List Price': 'listPrice',
  'List Price': 'listPrice',
  'Tax Year': 'taxYear',
  'Tax Amount': 'taxAmount',
  'Tax Rate': 'taxRate',
};

function formatNumber(num: number): string {
  if (!isFinite(num)) return '0';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v && v.toUpperCase() !== 'NA' && v.toUpperCase() !== 'N/A'))).sort();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Oversized boundary uploads are auto-simplified in the browser before they
// are staged: a 60MB+ FeatureCollection exhausts the tab during the later
// stringify/merge/gzip passes and the upload never reaches Firebase. The
// tolerance matches scripts/simplify-boundaries.js (~110 m at Houston's
// latitude) — invisible at map zoom levels, and every feature is kept.
const AUTO_SIMPLIFY_MIN_CHARS = 25_000_000;
const AUTO_SIMPLIFY_TOLERANCE = 0.001;

function countBoundaryVertices(geometry: { type: string; coordinates: any } | null | undefined): number {
  if (!geometry || !Array.isArray(geometry.coordinates)) return 0;
  const coords = geometry.coordinates;
  if (geometry.type === 'Polygon') {
    return (coords as number[][][]).reduce((sum, ring) => sum + (ring?.length ?? 0), 0);
  }
  if (geometry.type === 'MultiPolygon') {
    return (coords as number[][][][]).reduce(
      (sum, poly) => sum + (poly ?? []).reduce((s, ring) => s + (ring?.length ?? 0), 0),
      0
    );
  }
  return 0;
}

function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function rowsToCsv(headers: string[], rows: Record<string, string>[]): string {
  const escapeCell = (v: unknown) => {
    const s = String(v ?? '').replace(/"/g, '""');
    return `"${s}"`;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(','))].join('\n');
}

function validateHeaders(
  headers: string[] | undefined,
  required: Array<string | { oneOf: string[] }>
): { valid: boolean; missing: string[] } {
  const normalized = (headers || []).map((h) => h.trim().toLowerCase());
  const missing: string[] = [];
  for (const r of required) {
    if (typeof r === 'string') {
      if (!normalized.includes(r.toLowerCase())) missing.push(r);
    } else {
      const hasOne = r.oneOf.some((h) => normalized.includes(h.toLowerCase()));
      if (!hasOne) missing.push(`one of: ${r.oneOf.join(' / ')}`);
    }
  }
  return { valid: missing.length === 0, missing };
}

function getDedupeColumns(section: Exclude<AdminSection, 'dashboard' | 'areas' | 'boundaries' | 'ads' | 'users'>): string[] {
  switch (section) {
    case 'sales':
    case 'rent':
    case 'current':
      return ['MLS Number', 'Address', 'Zip'];
    case 'tax':
      return ['MLS #', 'Parcel ID', 'Address'];
    case 'schools':
      return ['school_name_clean', 'Overall Score'];
    default:
      return [];
  }
}

function makeDedupeKey(row: Record<string, string>, columns: string[]): string {
  return columns.map((col) => (row[col] ?? '').trim().toLowerCase()).join('|');
}

function makeEngineDedupeKey(d: PropertyData): string {
  return makeDedupeKey(
    { 'MLS Number': d.mlsNumber, Address: d.address, Zip: d.zip },
    ['MLS Number', 'Address', 'Zip']
  );
}

function findMlsColumn(headers: string[] | undefined): string | undefined {
  if (!headers) return undefined;
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const candidates = ['mls number', 'mls #', 'mls', 'mls_number', 'mlsnum'];
  for (let i = 0; i < normalized.length; i++) {
    if (candidates.includes(normalized[i])) return headers[i];
  }
  return undefined;
}

/** Categories whose rows live in the SQL `properties` table (direct import). */
const SQL_BACKED_CATEGORIES = new Set<string>(['sales', 'rent', 'current-sale', 'current-rent', 'tax']);

// After committing one of these buckets the tax records must be re-merged onto
// the sale rows: a fresh sale upload brings new rows with empty tax fields, and
// a tax upload brings the values to copy onto them. (mergeTaxIntoSaleRows.)
const TAX_MERGE_CATEGORIES = new Set<string>(['sales', 'current-sale', 'tax']);

/**
 * Recompute the (mlsNumber, datasetYear) pairs a CSV file staged into SQL,
 * using the exact mapper used at upload time. Reads the Storage backup
 * (gzip-sniffed, same trick as fetchJsonAutoGz) so deleting a file deletes
 * precisely the rows that file owns — never rows other files uploaded.
 */
async function collectSqlKeysForFile(file: {
  storageUrl?: string;
  category: CMSFileCategory;
  year?: number | null;
}): Promise<{ m: string; y: number }[]> {
  if (!file.storageUrl || !SQL_BACKED_CATEGORIES.has(file.category)) return [];
  const res = await fetch(file.storageUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Backup fetch failed (${res.status})`);
  const buf = await res.arrayBuffer();
  let text: string;
  const head = new Uint8Array(buf.slice(0, 2));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const ds = (globalThis as any).DecompressionStream as typeof DecompressionStream | undefined;
    if (!ds) throw new Error('Browser does not support gzip decompression.');
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(buf));
        c.close();
      },
    });
    text = await new Response(stream.pipeThrough(new ds('gzip'))).text();
  } else {
    text = new TextDecoder().decode(buf);
  }
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const { csvRowsToSqlPropertyRows } = await import('@/lib/sqlImport');
  const sqlRows = csvRowsToSqlPropertyRows(parsed.data, file.category as any, undefined, file.year ?? null);
  const seen = new Set<string>();
  const keys: { m: string; y: number }[] = [];
  for (const r of sqlRows) {
    const m = String(r.mlsNumber || '').trim();
    const y = Number(r.datasetYear ?? 0);
    const k = `${m}|${y}`;
    if (!m || seen.has(k)) continue;
    seen.add(k);
    keys.push({ m, y });
  }
  return keys;
}

async function buildDedupeKeySet(
  section: Exclude<AdminSection, 'dashboard' | 'areas' | 'boundaries' | 'ads' | 'users'>,
  eng: ReturnType<typeof getEngine>,
  includeUploadedFiles = true
): Promise<Set<string>> {
  const set = new Set<string>();
  const columns = getDedupeColumns(section);
  if (!columns.length) return set;

  if ((section === 'sales' || section === 'rent' || section === 'current') && eng.isLoaded) {
    // Only treat engine rows as duplicates when the CMS still registers files
    // for this section. After a mass delete (empty CMS), the engine's stale
    // in-memory dataset must NOT mark re-uploaded rows as duplicates — those
    // rows are exactly what needs to be re-uploaded to restore the dataset.
    const config = SECTION_CONFIG[section as keyof typeof SECTION_CONFIG];
    const cats = config ? (Array.isArray(config.category) ? config.category : [config.category]) : [];
    const metadatas = await cmsStore.listFilesMetadata();
    const hasFiles = metadatas.some((f) => cats.includes(f.category));
    if (hasFiles) {
      for (const d of eng.data) {
        set.add(makeEngineDedupeKey(d));
      }
    }
  }

  if (includeUploadedFiles) {
    const config = SECTION_CONFIG[section as keyof typeof SECTION_CONFIG];
    if (config) {
      const cats = Array.isArray(config.category) ? config.category : [config.category];
      const existingRows = await cmsStore.getUploadedRowsByCategories(cats);
      for (const row of existingRows) {
        set.add(makeDedupeKey(row, columns));
      }
    }
  }

  return set;
}

/**
 * Recursively collect files from a DataTransferItemList so dropping a folder
 * (or a folder containing folders) explores every level.
 */
async function collectFilesFromDataTransfer(items: DataTransferItemList | null): Promise<File[]> {
  if (!items) return [];
  const files: File[] = [];
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  await Promise.all(entries.map((entry) => readEntryRecursive(entry, files)));
  console.log(`[Folder upload] discovered ${files.length} file(s) from ${entries.length} dropped item(s)`);
  return files;
}

/** Read every entry in a directory, continuing until readEntries returns empty.
 *  Chrome's DataTransfer directory reader batches entries (~100 at a time),
 *  so a single call is not enough for large folders. */
function readDirectoryEntry(dirReader: FileSystemDirectoryReader, files: File[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const collect = () => {
      dirReader.readEntries(
        async (entries) => {
          if (entries.length === 0) {
            resolve();
            return;
          }
          // Wait for this batch (including any subdirectories) before asking for the next batch.
          await Promise.all(entries.map((entry) => readEntryRecursive(entry, files)));
          // Use setTimeout(0, ...) to avoid stack overflow on very deep directory trees.
          setTimeout(collect, 0);
        },
        (err) => reject(err)
      );
    };
    collect();
  });
}

function readEntryRecursive(entry: FileSystemEntry, files: File[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file(
        (f) => {
          files.push(f);
          resolve();
        },
        (err) => reject(err)
      );
    } else if (entry.isDirectory) {
      const dirReader = (entry as FileSystemDirectoryEntry).createReader();
      readDirectoryEntry(dirReader, files).then(resolve, reject);
    } else {
      resolve();
    }
  });
}

/**
 * Detect the real data category from the file/folder path.
 * If the path/folder name explicitly says "sale", "rent", etc., that wins.
 * Otherwise the category defaults to the active section's main category so
 * generic displayGrid filenames do not leak into every data section.
 */
function detectCategory(fileName: string, section: AdminSection): CMSFileCategory {
  const parts = fileName.toLowerCase().split('/');

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.endsWith('.geojson') || part.endsWith('.json')) return 'boundary';
    if (part.includes('tax')) return 'tax';
    if (part.includes('school')) {
      if (part.includes('elem')) return 'school-elementary';
      if (part.includes('middle')) return 'school-middle';
      if (part.includes('high')) return 'school-high';
      return 'school-elementary';
    }
    // NOTE: "current".includes("rent") is TRUE ("cur-RENT") — the rent check
    // MUST run after the sale check and only win when there is no sale
    // keyword, or every "Current for Sale" folder silently became Rent data.
    if (part.includes('current')) {
      if (part.includes('sale')) return 'current-sale';
      if (part.includes('rent')) return 'current-rent';
      return 'current-sale';
    }
    if (part.includes('rent')) return 'rent';
    if (part.includes('sale')) return 'sales';
  }

  const fallback =
    section === 'sales'
      ? 'sales'
      : section === 'rent'
      ? 'rent'
      : section === 'current'
      ? 'current-sale'
      : section === 'tax'
      ? 'tax'
      : section === 'schools'
      ? 'school-elementary'
      : 'property';

  return fallback;
}

function categorySectionName(category: CMSFileCategory): string {
  switch (category) {
    case 'sales':
      return 'Sales Data';
    case 'rent':
      return 'Rent Data';
    case 'current-sale':
    case 'current-rent':
      return 'Current Listings';
    case 'tax':
      return 'Tax Records';
    case 'school-elementary':
    case 'school-middle':
    case 'school-high':
      return 'School Ratings';
    case 'boundary':
      return 'Boundaries';
    case 'custom-area':
      return 'Area Metrics';
    case 'property':
      return 'Sales Data';
  }
}

/** ── "What did you actually upload?" report ────────────────────────────────
 *  The plain staging toasts scroll away and never say WHICH data changed.
 *  After every upload batch this popup summarizes, per file: what kind of
 *  data it is, the dataset year, how many rows went in vs. were skipped, and
 *  the zip codes / cities the file covers — in plain English. */
interface UploadedFileReport {
  /** File name — shown ONLY in the expanded "visualizar" detail, not the row. */
  fileName: string;
  /** Data kind only (Sales Data / Tax Records / …) — the row header. */
  categoryLabel: string;
  datasetYear: number | null;
  rowsStaged: number;
  rowsSkipped: number;
  error?: string;
  /** Rows whose MLS numbers already existed in the live SQL database. */
  alreadyInDb: number;
  /** Zips that UPDATE existing rows (their MLS was already in the database). */
  updated: { name: string; count: number }[];
  /** Zips that add NEW rows (MLS numbers not seen before). */
  added: { name: string; count: number }[];
  /** Coverage when the new/updated split is unknown (engine not loaded). */
  fallbackZips: { name: string; count: number }[];
  /** GeoJSON upload — rowsStaged counts FEATURES (new areas), not CSV rows. */
  isGeo?: boolean;
  /** One-sentence explanation of what this upload changes on the map. */
  effect: string;
}

function effectSentenceFor(category: CMSFileCategory, year: number | null): string {
  const yearPart = year ? ` (year ${year})` : '';
  switch (category) {
    case 'tax':
      return 'Tax records: the tax amount/rate/year are attached to the sale and current-listings rows that share the same MLS number. Nothing is deleted — re-uploading just refreshes the values.';
    case 'sales':
      return `Sold-property records${yearPart}, keyed by MLS number + year. Re-uploading the same file is safe — it UPDATES the existing rows instead of duplicating them.`;
    case 'rent':
      return `Rental records${yearPart}, keyed by MLS number + year. Re-uploading is safe — existing rows are updated in place.`;
    case 'current-sale':
    case 'current-rent':
      return 'Active for-sale/for-rent listings, keyed by MLS number + year. Old records keep their own year entry — history is never deleted.';
    case 'boundary':
    case 'custom-area':
      return 'GeoJSON areas: new features are drawn on the map; areas with the same name are updated.';
    default:
      return 'Rows are keyed by MLS number + year.';
  }
}

/** Zip-code / city coverage from the file's own rows. Column names vary per
 *  export (sales CSVs use "Zip"/"City/Location"; CoreLogic tax CSVs use
 *  "Postal Code"/"City Name") so match loosely. */
function coverageCounts(rows: Record<string, string>[], headerRe: RegExp, excludeRe: RegExp): { name: string; count: number }[] {
  const header = (Object.keys(rows[0] ?? {}) || []).find((h) => headerRe.test(h) && !excludeRe.test(h));
  if (!header) return [];
  // NOTE: this file shadows the global `Map` with a react-icons component —
  // count with a plain object instead.
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const raw = String(row[header] ?? '').trim();
    if (!raw || raw === '0') continue;
    const name = raw.length > 28 ? `${raw.slice(0, 25)}…` : raw;
    counts[name] = (counts[name] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** Classify a CSV's rows against the currently loaded engine MLS set: which
 *  zip codes the rows UPDATE (MLS already in the database) and which are NEW.
 *  Shared by the "what you're uploading" card and the per-document preview
 *  panel so a saved file's Eye shows the same numbers the upload card did.
 *  When the engine isn't loaded, falls back to plain zip coverage counts. */
function computeZipEffect(rows: Record<string, string>[]): {
  updated: { name: string; count: number }[];
  added: { name: string; count: number }[];
  fallback: { name: string; count: number }[];
  classified: boolean;
  existingCount: number;
  sampleMlsNumbers: string[];
} {
  const headers = Object.keys(rows[0] ?? {});
  const zipHeader = headers.find((h) => /zip|postal/i.test(h) && !/zipcodes/i.test(h));
  const mlsHeader = findMlsColumn(headers);
  const eng = getEngine();
  const zipUpdatedCounts: Record<string, number> = {};
  const zipAddedCounts: Record<string, number> = {};
  let existingCount = 0;
  const sampleMlsNumbers: string[] = [];
  let classified = false;
  if (mlsHeader && eng.isLoaded) {
    classified = true;
    const engineMlsSet = new Set(eng.data.map((d) => d.mlsNumber));
    const seen = new Set<string>();
    for (const row of rows) {
      const raw = String(row[mlsHeader] ?? '').trim();
      if (!raw || seen.has(raw)) continue;
      seen.add(raw);
      const zipRaw = zipHeader ? String(row[zipHeader] ?? '').trim().slice(0, 28) : '';
      if (engineMlsSet.has(raw)) {
        existingCount++;
        if (sampleMlsNumbers.length < 5) sampleMlsNumbers.push(raw);
      }
      if (!zipRaw || zipRaw === '0') continue;
      const bucket = engineMlsSet.has(raw) ? zipUpdatedCounts : zipAddedCounts;
      bucket[zipRaw] = (bucket[zipRaw] || 0) + 1;
    }
  }
  const toCountList = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);
  return {
    updated: toCountList(zipUpdatedCounts),
    added: toCountList(zipAddedCounts),
    fallback: classified ? [] : coverageCounts(rows, /zip|postal/i, /zipcodes/).slice(0, 12),
    classified,
    existingCount,
    sampleMlsNumbers,
  };
}

function buildUploadReportFor(staged: StagedFile): UploadedFileReport {
  // GeoJSON (Area Metrics / Boundaries): the "rows" ARE the localities —
  // duplicates were already on the map ("updated"), newNames are brand new.
  if (staged.geoJson) {
    return {
      fileName: staged.record.name,
      categoryLabel: categorySectionName(staged.record.category),
      datasetYear: null,
      rowsStaged: staged.stats.new,
      rowsSkipped: staged.stats.duplicate,
      alreadyInDb: staged.stats.duplicate,
      updated: (staged.duplicateNames || []).slice(0, 40).map((name) => ({ name, count: 1 })),
      added: (staged.newNames || []).slice(0, 40).map((name) => ({ name, count: 1 })),
      fallbackZips: [],
      isGeo: true,
      effect:
        staged.stats.duplicate > 0
          ? `${staged.stats.new} new area(s) · ${staged.stats.duplicate} already on the map (updated in place)`
          : `${staged.stats.new} new areas drawn on the map`,
    };
  }
  const rows = staged.record.rows;
  const progress = staged.importProgress;
  const stagedRows = progress?.total ?? rows.length;
  const status = progress?.status;
  const updated = staged.zipUpdate?.updated ?? [];
  const added = staged.zipUpdate?.added ?? [];
  return {
    fileName: staged.record.name,
    categoryLabel: categorySectionName(staged.record.category),
    datasetYear: staged.record.year ?? null,
    rowsStaged: status === 'done' ? stagedRows : 0,
    rowsSkipped: Math.max(0, staged.stats.total - stagedRows),
    error: status === 'error' ? progress?.error : undefined,
    alreadyInDb: staged.duplicateWarning?.count ?? 0,
    updated,
    added,
    // When the engine could not classify (not loaded / no MLS column), show
    // plain coverage so the user still sees which localities the file touches.
    fallbackZips:
      updated.length || added.length
        ? []
        : coverageCounts(rows, /zip|postal/i, /zipcodes/).slice(0, 12),
    effect: effectSentenceFor(staged.record.category, staged.record.year ?? null),
  };
}

/** Zip chips for the upload-report modal — the COMPLETE list is shown (no
 *  truncation), each chip carrying its row count. */
function ZipChips({ list, tone }: { list: { name: string; count: number }[]; tone: 'amber' | 'emerald' | 'plain' }) {
  const toneCls =
    tone === 'amber'
      ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
      : tone === 'emerald'
        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
        : 'bg-white/5 border-border-subtle text-gray-300';
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((z) => (
        <span key={z.name} className={`text-[11px] font-medium border rounded-md px-2 py-0.5 ${toneCls}`}>
          {z.name}
          {z.count > 1 ? ` · ${z.count}` : ''}
        </span>
      ))}
    </div>
  );
}

/** Full, NEVER-empty detail content for an upload-report row. When a bucket
 *  is empty it says explicitly what that means ("all brand-new" / "all
 *  updated in place") instead of showing an empty panel. */
function UploadDetailContent({ r }: { r: UploadedFileReport }) {
  return (
    <div className="mt-2 border-t border-border-subtle pt-3 space-y-2">
      <p className="text-xs font-semibold text-white">What this document uploaded</p>
      <p className="text-[11px] text-gray-400 break-all">{r.fileName}</p>
      <p className="text-[11px] text-gray-300">
        {r.datasetYear ? `Year ${r.datasetYear} · ` : ''}
        {r.isGeo
          ? `${r.rowsStaged.toLocaleString()} areas on the map`
          : `${r.rowsStaged.toLocaleString()} rows in the database`}
        {r.rowsSkipped > 0 ? ` · ${r.rowsSkipped.toLocaleString()} skipped` : ''}
        {!r.isGeo && r.alreadyInDb > 0
          ? ` · ${r.alreadyInDb.toLocaleString()} already in the database before this upload`
          : ''}
      </p>
      <p className="text-[11px] text-gray-300">{r.effect}</p>
      {r.error && <p className="text-[11px] text-red-300">Error: {r.error}</p>}
      {r.updated.length > 0 && (
        <>
          <p className="text-[11px] font-semibold text-amber-300">
            Updated — these ZIPs already had rows with these MLS numbers; the existing rows were refreshed in place:
          </p>
          <ZipChips list={r.updated} tone="amber" />
        </>
      )}
      {r.added.length > 0 && (
        <>
          <p className="text-[11px] font-semibold text-emerald-400">
            New — rows for these ZIPs did not exist in the database yet and were added:
          </p>
          <ZipChips list={r.added} tone="emerald" />
        </>
      )}
      {r.updated.length > 0 && r.added.length === 0 && (
        <p className="text-[11px] text-gray-400">
          Every MLS number in this document already existed in the database — nothing new was added; the rows were updated in place.
        </p>
      )}
      {r.updated.length === 0 && r.added.length > 0 && (
        <p className="text-[11px] text-gray-400">
          Every row in this document is brand-new — no row with these MLS numbers existed yet.
        </p>
      )}
      {r.updated.length === 0 && r.added.length === 0 && (
        r.fallbackZips.length > 0 ? (
          <>
            <p className="text-[11px] font-semibold text-gray-300">ZIPs covered in this document:</p>
            <ZipChips list={r.fallbackZips} tone="plain" />
            <p className="text-[11px] text-gray-500">
              The updated/new split is computed against the loaded dataset; it was not available at upload time.
            </p>
          </>
        ) : (
          <p className="text-[11px] text-gray-400">
            {r.rowsStaged > 0
              ? 'This document was uploaded into the database (keyed by MLS number + year). The updated/new split was not available at upload time — it is visible in the per-document preview once the dataset engine is loaded.'
              : 'No rows landed in the database for this document.'}
          </p>
        )
      )}
    </div>
  );
}

/** Section each property-like category belongs to — used to point the user at
 *  the right place when a file is dropped on a different section. */
const CATEGORY_TARGET_SECTION: Partial<Record<CMSFileCategory, Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>>> = {
  sales: 'sales',
  rent: 'rent',
  'current-sale': 'current',
  'current-rent': 'current',
  tax: 'tax',
};

interface CloseDateSniff {
  /** Name of the Close-Date-like column, or null when the file has none. */
  col: string | null;
  /** How many rows were sampled (capped, folders can hold 100k-row CSVs). */
  checked: number;
  /** How many sampled rows actually carry a Close Date value. */
  withClose: number;
}

/** Looks for a Close Date column and samples real values from the parsed rows. */
function sniffCloseDate(fields: string[], rows: Record<string, string>[]): CloseDateSniff {
  const col =
    fields.find((f) =>
      /^(close\s*date|close_date|closedate|closed\s*date|closing\s*date|sold\s*date|sale\s*date)$/i.test(f.trim())
    ) || null;
  if (!col) return { col: null, checked: 0, withClose: 0 };
  let checked = 0;
  let withClose = 0;
  for (const row of rows) {
    if (checked >= 200) break;
    const v = row[col]?.trim();
    if (v) withClose++;
    checked++;
  }
  return { col, checked, withClose };
}

/**
 * The CONTENT wins over the folder name. detectCategory only reads folder/
 * file names, so a "Current for Sale Data" folder holding 2025 closings
 * (rows with real Close Dates) would be misread as active listings — and a
 * "Sale 2025" folder whose CSVs lack a Close Date column holds listings that
 * never closed. The sniffed rows settle it either way.
 */
function refineCategoryByRows(fields: string[], sniff: CloseDateSniff, category: CMSFileCategory): CMSFileCategory {
  if (category !== 'sales' && category !== 'rent' && category !== 'current-sale' && category !== 'current-rent') {
    return category;
  }
  if (category === 'current-sale' || category === 'current-rent') {
    if (sniff.col && sniff.checked > 0 && sniff.withClose / sniff.checked >= 0.3) {
      return category === 'current-rent' ? 'rent' : 'sales';
    }
    return category;
  }
  if (!sniff.col) {
    // No Close Date at all — but a Close/Sold Price column means it IS sold
    // data that simply doesn't carry dates; keep it where the folder put it.
    const hasClosePrice = fields.some((f) => /^(close\s*price|close_price|closeprice|sold\s*price|soldprice)$/i.test(f.trim()));
    if (hasClosePrice) return category;
    return category === 'rent' ? 'current-rent' : 'current-sale';
  }
  return category;
}

function describeCategoryEvidence(sniff: CloseDateSniff, category: CMSFileCategory): string {
  if (category === 'tax') return 'The file name marks it as tax data.';
  if (category !== 'sales' && category !== 'rent' && category !== 'current-sale' && category !== 'current-rent') {
    return `The file name marks it as ${categorySectionName(category)} data.`;
  }
  if (!sniff.col) return 'No Close Date column — that matches active listings.';
  const pct = sniff.checked > 0 ? Math.round((sniff.withClose / sniff.checked) * 100) : 0;
  return `Close Date filled in ${pct}% of the first ${sniff.checked || 'a few'} rows — that matches sold records.`;
}

type TreeNode = {
  name: string;
  files: Omit<CMSFileRecord, 'rows'>[];
  folders: { [key: string]: TreeNode };
};

function buildTree(files: Omit<CMSFileRecord, 'rows'>[], title: string): TreeNode {
  const root: TreeNode = { name: 'Root', files: [], folders: {} };
  const sectionNode: TreeNode = { name: title, files: [], folders: {} };
  root.folders[title] = sectionNode;

  // Group files by detected year so the admin sees "2021", "2022", ... folders.
  const byYear: Record<string, Omit<CMSFileRecord, 'rows'>[]> = {};
  for (const file of files) {
    const cleanName = file.name.split('/').pop() || file.name;
    const year = file.year ?? null;
    const folder = year != null ? String(year) : 'No Year';
    byYear[folder] = byYear[folder] || [];
    byYear[folder].push({ ...file, name: cleanName });
  }

  const sortedFolders = Object.keys(byYear).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aIsNum = !isNaN(na);
    const bIsNum = !isNaN(nb);
    if (aIsNum && bIsNum) return na - nb;
    if (aIsNum) return -1;
    if (bIsNum) return 1;
    return a.localeCompare(b);
  });

  for (const folder of sortedFolders) {
    sectionNode.folders[folder] = {
      name: folder,
      files: byYear[folder].sort((a, b) => a.name.localeCompare(b.name)),
      folders: {},
    };
  }

  return root;
}

function FolderNode({ node, path, onPreview, onDelete }: { node: TreeNode, path: string, onPreview: (f: any) => void, onDelete: (id: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  
  const hasChildren = node.files.length > 0 || Object.keys(node.folders).length > 0;
  if (!hasChildren) return null;

  return (
    <div className="ml-4 first:ml-0">
      {path !== '' && (
        <div 
          className="flex items-center gap-2 py-2 cursor-pointer text-gray-300 hover:text-white transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-gray-500 w-4">{expanded ? '▼' : '▶'}</span>
          <span className="text-blue-400">📁</span>
          <span className="font-semibold text-sm">{node.name}</span>
          <span className="text-xs text-gray-500">
            ({node.files.length} files, {Object.keys(node.folders).length} folders)
          </span>
        </div>
      )}
      
      {expanded && (
        <div className={path !== '' ? 'border-l border-border-subtle ml-2 pl-4 mt-1 space-y-2' : 'space-y-2'}>
          {Object.values(node.folders).map(folder => (
            <FolderNode key={folder.name} node={folder} path={`${path}/${folder.name}`} onPreview={onPreview} onDelete={onDelete} />
          ))}
          
          {node.files.map((file) => (
            <div key={file.id} className="bg-background border border-border-subtle rounded-xl p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white truncate">{file.name.split('/').pop()}</div>
                <div className="text-[10px] text-gray-400">
                  {formatBytes(file.size)} · {new Date(file.uploadedAt).toLocaleString()}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => onPreview(file)} className="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white" title="Preview">
                  <Eye className="w-4 h-4" />
                </button>
                <button
                  onClick={() => { if (file.storageUrl) window.open(file.storageUrl, '_blank'); }}
                  className="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white"
                  title="Download"
                >
                  <Download className="w-4 h-4" />
                </button>
                <button onClick={() => onDelete(file.id)} className="p-2 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400" title="Delete">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminPage() {
  return (
    <RequireAdmin>
      <AdminPageInner />
    </RequireAdmin>
  );
}

function AdminPageInner() {
  const [section, setSection] = useState<AdminSection>('dashboard');
  const [dataTab, setDataTab] = useState<DataTab>('upload');

  const [files, setFiles] = useState<Omit<CMSFileRecord, 'rows'>[]>([]);
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [overrides, setOverrides] = useState<CMSMetricOverride[]>([]);
  const [propertyOverrides, setPropertyOverrides] = useState<CMSPropertyOverride[]>([]);
  const [summary, setSummary] = useState<CMSStoreSummary>({ files: 0, rows: 0, overrides: 0, propertyOverrides: 0, lastUploadAt: null });
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    current: number;
    total: number;
    fileName: string;
    phase: string;
    startedAt: number;
  } | null>(null);
  const [uploadSummary, setUploadSummary] = useState<{
    found: number;
    staged: number;
    skipped: number;
    reasons: Record<string, number>;
    /** Per-file English messages explaining WHY each file was skipped — a
     *  GeoJSON in a data section points the user to the right section, any
     *  other non-CSV document says it cannot be uploaded. */
    skippedFiles: { name: string; message: string }[];
  } | null>(null);
  /** Files whose detected data type doesn't match the section they were
   *  dropped on — the big centered popup explains and offers one-click fixes. */
  const [sectionMisfits, setSectionMisfits] = useState<
    { file: File; relativePath: string; category: CMSFileCategory; evidence: string }[]
  >([]);
  /** Section the misfit popup is glowing on the sidebar/dashboard card. */
  const [highlightSection, setHighlightSection] = useState<AdminSection | null>(null);
  /** "What did you actually upload?" popup — per-file breakdown shown right
   *  after the staging job finishes (see UploadedFileReport). */
  const [uploadReport, setUploadReport] = useState<UploadedFileReport[] | null>(null);
  /** Rows of the report card whose detail ("visualizar") is expanded. */
  const [reportExpanded, setReportExpanded] = useState<Set<number>>(new Set());

  const [confirmAll, setConfirmAll] = useState<ConfirmAllState>({
    open: false,
    totalFiles: 0,
    totalRows: 0,
    sqlFiles: 0,
    sqlRows: 0,
    geoJsonFiles: 0,
    years: [],
  });
  const [dragActive, setDragActive] = useState(false);
  const [previewFile, setPreviewFile] = useState<PreviewState | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [engineLoaded, setEngineLoaded] = useState(getEngine().isLoaded);
  const [engineTick, setEngineTick] = useState(0);

  const [overrideBoundary, setOverrideBoundary] = useState<BoundaryKey>('zipcodes');
  const [overrideBoundaryId, setOverrideBoundaryId] = useState('');
  const [overrideMetric, setOverrideMetric] = useState<MetricKey>('Close Price');
  const [overrideValue, setOverrideValue] = useState('');
  const [overrideNote, setOverrideNote] = useState('');

  const [propFilters, setPropFilters] = useState({ area: '', subdivision: '', marketArea: '' });
  const [selectedPropertyKey, setSelectedPropertyKey] = useState('');
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [propertyEditMode, setPropertyEditMode] = useState<PropertyEditMode>('edit');
  const [createFields, setCreateFields] = useState<Record<string, string>>({});

  const [selectedZip, setSelectedZip] = useState('');
  const [selectedTaxPropertyKey, setSelectedTaxPropertyKey] = useState('');
  const [taxFields, setTaxFields] = useState<Record<string, string>>({});

  const [schoolLevel, setSchoolLevel] = useState<'elementary' | 'middle' | 'high'>('elementary');
  const [schoolName, setSchoolName] = useState('');
  const [schoolScore, setSchoolScore] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [syncLoading, setSyncLoading] = useState(false);
  const [syncSectionTitle, setSyncSectionTitle] = useState('');
  const [sqlStatus, setSqlStatus] = useState<{
    total: number;
    committed: number;
    pending: number;
    lastUpdated: string | null;
    loading: boolean;
    error: string | null;
  }>({
    total: 0,
    committed: 0,
    pending: 0,
    lastUpdated: null,
    loading: true,
    error: null,
  });

  const loadSqlStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/sql/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `Status request failed (${res.status})`);
      }
      const data = await res.json();
      console.log('[admin] loadSqlStatus received', data);
      setSqlStatus({
        total: Number(data.total ?? 0),
        committed: Number(data.committed ?? 0),
        pending: Number(data.pending ?? 0),
        lastUpdated: data.lastUpdated ?? null,
        loading: false,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[admin] loadSqlStatus failed', err);
      setSqlStatus((s) => ({ ...s, loading: false, error: message }));
    }
  }, []);

  const handleHardReload = async () => {
    setToast({ type: 'success', message: 'Cache cleared — reloading the dashboard…' });
    try {
      // Only the app's DATA caches. The guided-tour marker, the cookie-consent
      // answer, closed ads and the Firebase Auth session all survive, so the
      // user never has to redo them.
      const { clearAppDataCaches } = await import('@/lib/cacheBuster');
      await clearAppDataCaches();
    } catch {
      // ignore cleanup errors — the reload below still busts the HTTP cache
    }
    // Give the IndexedDB wipe a beat to finish before the unload — the old
    // version navigated instantly and the deletion never landed.
    await new Promise((r) => setTimeout(r, 400));
    const url = new URL(window.location.href);
    url.searchParams.set('_cb', Date.now().toString());
    window.location.href = url.toString();
  };

  const handleForceCommit = async () => {
    setSqlStatus((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch('/api/sql/force-commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || body.error || `Force commit failed (${res.status})`);
      }
      const data = await res.json();
      setToast({ type: 'success', message: data.message || 'Pending rows are now visible on the map.' });
      await loadSqlStatus();
      await reloadEngine();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[admin] force commit failed', err);
      setToast({ type: 'error', message: `Could not force commit: ${message}` });
      setSqlStatus((s) => ({ ...s, loading: false, error: message }));
    }
  };

  const reloadEngine = useCallback(async () => {
    await getEngine().loadAllCSV(true);
    setEngineLoaded(true);
    setEngineTick((t) => t + 1);
  }, []);

  const loadData = useCallback(async () => {
    await cmsStore.init();
    const [list, ovr, propOvr, s] = await Promise.all([
      cmsStore.listFilesMetadata(),
      cmsStore.listOverrides(),
      cmsStore.listPropertyOverrides(),
      cmsStore.summary(),
    ]);
    setFiles(list);
    setOverrides(ovr);
    setPropertyOverrides(propOvr);
    setSummary(s);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    loadSqlStatus();
    const unsubscribe = cmsStore.subscribe(() => loadData());
    // Refresh SQL counts every 10s so the dashboard never shows stale zeros
    // while rows are being committed in another tab.
    const interval = setInterval(() => loadSqlStatus(), 10000);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [loadData, loadSqlStatus]);

  // Deployment watchdog (env-free) — a browser parked on /admin must never
  // keep running an OLD bundle after a new deploy: that is exactly how stale
  // tabs kept sending uploads without the API-key credential and failed with
  // "invalid authentication credentials" even after the fix was live.
  useEffect(() => {
    return watchFreshDeployments();
  }, []);

  // Self-healing: when the admin opens, verify the published dataset actually
  // matches the CSVs currently in the CMS and rebuild automatically if they
  // diverged (e.g. a rebuild failed while the tab was closed). Runs once per
  // mount, in the background — no buttons, no blocking.
  useEffect(() => {
    let cancelled = false;
    import('@/lib/datasetRebuild/reconcile')
      .then(({ reconcileDatasetWithCms }) => reconcileDatasetWithCms())
      .catch((err) => {
        if (!cancelled) console.warn('[datasetRebuild] Reconcile failed:', err);
      });
    // SQL mirror catch-up: if a previous sync loop died (tab closed before it
    // finished), the admin mount resumes it. The route is idempotent per chunk.
    import('@/lib/sqlSync')
      .then((m) => m.runSqlSync())
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Register files that already exist in Firebase Storage but have no
  // Firestore metadata (uploaded outside the CMS) so they appear in the lists.
  // Runs automatically every time a data section is opened; if it takes longer
  // than 400ms a loading popup is shown.
  const runStorageSync = useCallback(async (sectionKey: AdminSection) => {
    const config = sectionKey === 'dashboard' ? null : SECTION_CONFIG[sectionKey as keyof typeof SECTION_CONFIG];
    if (!config && sectionKey !== 'dashboard') return;
    setSyncSectionTitle(config?.title ?? 'all');
    const popupTimer = setTimeout(() => setSyncLoading(true), 400);
    try {
      const fallback = config ? (Array.isArray(config.category) ? config.category[0] : config.category) : undefined;
      const result = await cmsStore.importExistingStorageFiles({ fallbackCategory: fallback });
      if (result.imported.length > 0) {
        await loadData();
        setToast({
          type: 'success',
          message: `Imported ${result.imported.length} file${result.imported.length !== 1 ? 's' : ''} from Firebase Storage.`,
        });
      }
    } catch (err: unknown) {
      console.error('Firebase Storage sync failed', err);
      setToast({ type: 'error', message: 'Could not load files from Firebase Storage — check storage rules.' });
    } finally {
      clearTimeout(popupTimer);
      setSyncLoading(false);
    }
  }, [loadData]);

  // Sync on section open — including the dashboard, so files are registered
  // as soon as the admin opens. Ads/Users don't touch data files.
  useEffect(() => {
    if (section === 'ads' || section === 'users') return;
    runStorageSync(section);
  }, [section, runStorageSync]);

  useEffect(() => {
    if (!getEngine().isLoaded || getEngine().data.length === 0) {
      reloadEngine().catch((err) => console.error('Engine preload error', err));
    }
  }, [reloadEngine]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    setDataTab('upload');
    setPropFilters({ area: '', subdivision: '', marketArea: '' });
    setSelectedPropertyKey('');
    setEditFields({});
    setPropertyEditMode('edit');
    setCreateFields({});
    setSelectedZip('');
    setSelectedTaxPropertyKey('');
    setTaxFields({});
    setSchoolName('');
    setSchoolScore('');
  }, [section]);

  const handleFiles = async (
    fileList: FileList | File[] | null,
    section: Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>,
    opts?: { ignoreSectionMismatch?: boolean }
  ) => {
    if (!fileList?.length) return;
    setProcessing(true);

    const config = SECTION_CONFIG[section as keyof typeof SECTION_CONFIG];
    const categories = config ? (Array.isArray(config.category) ? config.category : [config.category]) : [];

    const eng = getEngine();
    if (!eng.isLoaded) {
      try {
        await reloadEngine();
      } catch (e) {
        console.error('Engine preload failed', e);
      }
    }

    const dataSection = section as Exclude<AdminSection, 'dashboard' | 'areas' | 'boundaries' | 'ads' | 'users'>;
    const baseKeySet =
      section !== 'boundaries' && section !== 'areas'
        ? await buildDedupeKeySet(dataSection, getEngine(), section === 'tax' || section === 'schools')
        : new Set<string>();

    for (const s of stagedFiles) {
      if (s.section !== section || section === 'boundaries' || section === 'areas') continue;
      const columns = getDedupeColumns(dataSection);
      for (const row of s.record.rows) {
        baseKeySet.add(makeDedupeKey(row, columns));
      }
    }

    const newStaged: StagedFile[] = [];
    const sqlStagingPromises: Promise<void>[] = [];
    const batchKeySet = new Set<string>();

    const inputFiles = Array.from(fileList);
    const acceptedExt =
      section === 'boundaries' || section === 'areas'
        ? ['.geojson', '.json']
        : ['.csv'];

    console.log(`[handleFiles] section=${section}, received ${inputFiles.length} file(s)`, inputFiles.map((f) => ({ name: f.name, path: (f as any).webkitRelativePath || f.name, size: f.size })));

    let skippedCount = 0;
    let skippedReasons: Record<string, number> = {};
    /** One English message per skipped file — rendered in the upload summary
     *  box so the user knows exactly why (wrong section vs. not a CSV). */
    const skippedFileMessages: { name: string; message: string }[] = [];
    const misfitFiles: { file: File; relativePath: string; category: CMSFileCategory; evidence: string }[] = [];

    for (let i = 0; i < inputFiles.length; i++) {
      const file = inputFiles[i];
      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!acceptedExt.includes(ext)) {
        skippedCount++;
        skippedReasons['wrong-extension'] = (skippedReasons['wrong-extension'] || 0) + 1;
        console.log(`[handleFiles] skipping ${file.name}: extension ${ext} not in`, acceptedExt);
        // Say WHY in the summary, per the owner: (1) a geolocation file or a
        // CSV of another data type dropped here → "it doesn't go in this
        // section, please place it where it goes"; (2) any other document →
        // "can't upload it because it is not a CSV".
        const lowerName = file.name.toLowerCase();
        const displayName = (file as any).webkitRelativePath || file.name;
        const sectionTitle = SECTION_CONFIG[section as keyof typeof SECTION_CONFIG]?.title;
        const isGeoSection = section === 'boundaries' || section === 'areas';
        if (lowerName.endsWith('.geojson') || lowerName.endsWith('.json')) {
          // GeoJSON can only land here in a data section (geo sections accept
          // it) — point the user back to Boundaries/Area Metrics.
          skippedFileMessages.push({
            name: displayName,
            message: `"${displayName}" is a geolocation (GeoJSON) file — I'm skipping it because it does not go in ${sectionTitle}. Please place it where it goes: Boundaries.`,
          });
        } else if (isGeoSection) {
          skippedFileMessages.push({
            name: displayName,
            message: `"${displayName}" is not a GeoJSON file — I'm skipping it because ${sectionTitle} only accepts geolocation (GeoJSON) files (they feed the map's polygons). Please place it where it goes.`,
          });
        } else {
          skippedFileMessages.push({
            name: displayName,
            message: `"${displayName}" — I can't upload it because it is not a CSV.`,
          });
        }
        continue;
      }

      const relativePath = (file as any).webkitRelativePath || file.name;
      if (section === 'boundaries' || section === 'areas') {
        const lowerName = file.name.toLowerCase();
        const isGeoJson = lowerName.endsWith('.geojson') || lowerName.endsWith('.json');
        const isCsv = lowerName.endsWith('.csv');

        // Area Metrics and Boundaries are GeoJSON-only: they feed the map's
        // polygon layers directly, and a CSV has no polygon geometry.
        if (!isGeoJson) {
          setToast({ type: 'error', message: `${file.name} is not a GeoJSON file. This section only accepts GeoJSON.` });
          continue;
        }

        try {
          let stagedGeo: GeoJsonFeatureCollection | null = null;
          let csvSkipped: { row: number; reason: string }[] = [];
          let featureCount = 0;
          // Set when the file was auto-simplified: the already-stringified
          // (much smaller) JSON, so the record does not re-stringify the
          // full-resolution geometry.
          let rawJsonOverride: string | null = null;

          if (isCsv) {
            const text = await file.text();
            const converted = csvToFeatureCollection(text);
            csvSkipped = converted.skipped.map((s) => ({ row: s.row, reason: s.reason }));
            if (converted.featureCollection.features.length === 0) {
              const reason = converted.skipped[0]?.reason || 'CSV has no valid rows.';
              setToast({
                type: 'error',
                message: `${file.name}: ${reason}`,
              });
              continue;
            }
            stagedGeo = converted.featureCollection;
            featureCount = stagedGeo.features.length;
          } else {
            const text = await file.text();
            const parsed = JSON.parse(text);
            if (!parsed || parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
              setToast({ type: 'error', message: `${file.name} is not a valid FeatureCollection.` });
              continue;
            }
            stagedGeo = parsed as GeoJsonFeatureCollection;
            featureCount = stagedGeo.features.length;

            // Projected exports (e.g. ArcGIS Web Mercator, coordinates in
            // meters) are converted to WGS84 lon/lat here, so the file stored
            // in Firebase is always directly renderable by Leaflet.
            normalizeGeoJsonCrs(stagedGeo);

            // Very large boundary files (60MB+) blow through the tab's memory
            // during staging (raw text + parsed object + stringified copy) and
            // the upload never lands. Auto-simplify them in place with the same
            // tolerance as scripts/simplify-boundaries.js so the polygons look
            // identical at map zoom levels. The pre-stringified content is kept
            // so the record below does not stringify the huge object twice.
            if (text.length > AUTO_SIMPLIFY_MIN_CHARS) {
              try {
                const { simplify } = await import('@turf/turf');
                let verticesBefore = 0;
                let verticesAfter = 0;
                const simplifiedFeatures: GeoJsonFeature[] = [];
                for (const feat of stagedGeo.features) {
                  verticesBefore += countBoundaryVertices(feat?.geometry);
                  try {
                    const simplified = simplify(feat as any, {
                      tolerance: AUTO_SIMPLIFY_TOLERANCE,
                      highQuality: true,
                      mutate: false,
                    }) as GeoJsonFeature;
                    verticesAfter += countBoundaryVertices(simplified?.geometry);
                    simplifiedFeatures.push(simplified);
                  } catch {
                    // Degenerate geometry: keep the original feature untouched.
                    simplifiedFeatures.push(feat);
                  }
                }
                stagedGeo = { type: 'FeatureCollection', features: simplifiedFeatures };
                rawJsonOverride = JSON.stringify(stagedGeo);
                setToast({
                  type: 'success',
                  message: `${file.name} is large (${formatBytes(text.length)}) and was auto-simplified before upload — ${verticesBefore.toLocaleString()} → ${verticesAfter.toLocaleString()} vertices. Shapes are unchanged at map zoom levels.`,
                });
              } catch (simplifyErr) {
                console.error('Auto-simplify failed; uploading the original geometry', simplifyErr);
              }
            }
          }

          // For Area Metrics we compare against all existing boundary files
          // already in Firebase so the admin can see what's new vs. duplicate.
          let newCount = featureCount;
          let duplicateCount = 0;
          let duplicateNames: string[] = [];
          let newNames: string[] = [];

          if (section === 'areas') {
            const existingFiles = files.filter((f) => f.category === 'boundary');
            const existingFeatures: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };
            for (const existing of existingFiles) {
              if (!existing.storageUrl) continue;
              try {
                const json = await fetchJsonAutoGz<any>(existing.storageUrl);
                if (json && Array.isArray(json.features)) {
                  for (const feat of json.features) existingFeatures.features.push(feat);
                }
              } catch {
                // ignore fetch failures for existing files
              }
            }
            const diff = diffAgainstExisting(stagedGeo, existingFeatures);
            newCount = diff.newFeatures.length;
            duplicateCount = diff.duplicateFeatures.length;
            duplicateNames = diff.duplicateFeatures.map((f) => getFeatureName(f)).filter(Boolean);
            newNames = diff.newFeatures.map((f) => getFeatureName(f)).filter(Boolean);
          }

          const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const record: CMSFileRecord = {
            id,
            name: file.name,
            // Always 'boundary': this is what the map's boundary loader reads,
            // and saveFile marks the CMS as boundary-authoritative on save.
            category: 'boundary',
            rows: [],
            headers: [],
            uploadedAt: Date.now(),
            source: 'upload',
            // When the file was auto-simplified, report the simplified
            // content's size so the admin list reflects what is actually
            // stored, not the original oversized file.
            size: rawJsonOverride ? rawJsonOverride.length : file.size,
            rawContent: rawJsonOverride ?? JSON.stringify(stagedGeo),
          };

          newStaged.push({
            id,
            file,
            section,
            record,
            stats: {
              total: featureCount,
              new: newCount,
              duplicate: duplicateCount,
            },
            geoJson: stagedGeo,
            duplicateNames,
            newNames,
            csvSkipped,
          });
        } catch (err) {
          console.error('GeoJSON/CSV parse error', err);
          setToast({ type: 'error', message: `Error processing ${file.name}` });
        }
        continue;
      }

      if (!file.name.toLowerCase().endsWith('.csv')) {
        setToast({ type: 'error', message: `${file.name} is not a CSV file.` });
        continue;
      }

      try {
        const parsed = await new Promise<Papa.ParseResult<Record<string, string>>>((resolve, reject) => {
          Papa.parse<Record<string, string>>(file, {
            header: true,
            skipEmptyLines: true,
            dynamicTyping: false,
            worker: true,
            complete: (results) => resolve(results),
            error: (error) => reject(error),
          });
        });

        const validation = validateHeaders(parsed.meta.fields || [], config.requiredColumns);
        if (!validation.valid) {
          skippedCount++;
          skippedReasons['missing-columns'] = (skippedReasons['missing-columns'] || 0) + 1;
          setToast({ type: 'error', message: `${file.name} is missing columns: ${validation.missing.join(', ')}` });
          console.log(`[handleFiles] skipping ${file.name}: missing columns`, validation.missing);
          continue;
        }

        // Folder/file-name detection first, then let the CSV's own content
        // (does it carry Close Date values?) settle current vs sold data.
        const detected = detectCategory(relativePath, section);
        const sniff = sniffCloseDate(parsed.meta.fields || [], parsed.data);
        const category = refineCategoryByRows(parsed.meta.fields || [], sniff, detected);

        // Files whose detected category belongs to a different data section
        // are collected for the misfit popup instead of silently skipped —
        // the popup explains where they go, with an example, and offers a
        // one-click fix. This prevents a "Sale 2024.csv" from being stored as
        // Rent data just because the user had the Rent tab open.
        if (!opts?.ignoreSectionMismatch && category !== 'property' && !categories.includes(category)) {
          misfitFiles.push({ file, relativePath, category, evidence: describeCategoryEvidence(sniff, category) });
          skippedCount++;
          skippedReasons['wrong-section'] = (skippedReasons['wrong-section'] || 0) + 1;
          skippedFileMessages.push({
            name: relativePath,
            message: `"${relativePath}" is ${categorySectionName(category)} — I'm skipping it because it does not go in this section. Please place it where it goes: ${categorySectionName(category)}.`,
          });
          console.log(`[handleFiles] misfit ${relativePath}: detected category=${category}, current section=${section}`);
          continue;
        }

        const actualCategory = categories.includes(category) ? category : categories[0];
        const isSqlImport =
          actualCategory !== 'boundary' && actualCategory !== 'custom-area' && !actualCategory.startsWith('school');

        // SQL-bound property CSVs are upserted by mls_number, so local
        // de-duplication only hides valid re-uploads. Keep raw parsed rows.
        const newRows = isSqlImport ? parsed.data : (() => {
          const columns = getDedupeColumns(dataSection);
          const kept: Record<string, string>[] = [];
          let duplicateCount = 0;
          for (const row of parsed.data) {
            const key = makeDedupeKey(row, columns);
            if (baseKeySet.has(key) || batchKeySet.has(key)) {
              duplicateCount++;
            } else {
              kept.push(row);
              batchKeySet.add(key);
            }
          }
          return kept;
        })();
        const duplicateCount = parsed.data.length - newRows.length;

        const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const detectedYear = actualCategory !== 'boundary' && actualCategory !== 'custom-area'
          ? detectDatasetYear(relativePath, newRows)
          : null;
        const record: CMSFileRecord = {
          id,
          name: relativePath,
          size: file.size,
          category: actualCategory,
          rows: newRows,
          headers: parsed.meta.fields || [],
          uploadedAt: Date.now(),
          source: 'upload',
          year: detectedYear,
        };

        const staged: StagedFile = {
          id,
          file,
          section,
          record,
          stats: {
            total: parsed.data.length,
            new: newRows.length,
            duplicate: duplicateCount,
          },
        };

        // Property CSVs go straight to SQL as soon as they are selected.
        // They are tagged with a session id so they stay invisible until Add All.
        if (isSqlImport) {
          const sessionId = `${id}_${Date.now()}`;
          staged.sessionId = sessionId;

          // Zip codes bucketed by whether the row's MLS already lives in the
          // database ("updated") or not ("added") — the upload report card
          // lists them as "Updated: …" / "New: …". Shared with the preview
          // panel so a saved document's Eye reports the same numbers.
          const zipEffect = computeZipEffect(parsed.data);
          const existingCount = zipEffect.existingCount;
          const sampleMlsNumbers = zipEffect.sampleMlsNumbers;
          staged.zipUpdate = { updated: zipEffect.updated, added: zipEffect.added };

          if (existingCount > 0) {
            staged.duplicateWarning = { count: existingCount, sampleMlsNumbers, status: 'pending' };
            staged.importProgress = { loaded: 0, total: newRows.length, status: 'error', error: 'This data is already in the database' };
          } else {
            staged.importProgress = { loaded: 0, total: newRows.length, status: 'running' };
            sqlStagingPromises.push(
              runSqlStaging(id, newRows, actualCategory as any, sessionId, record.year).then(() => {
                setUploadProgress((prev) =>
                  prev && prev.phase === 'Staging CSV rows in SQL…'
                    ? { ...prev, current: Math.min(prev.current + 1, prev.total) }
                    : prev
                );
              })
            );
          }
        }

        newStaged.push(staged);
      } catch (err) {
        skippedCount++;
        skippedReasons['parse-error'] = (skippedReasons['parse-error'] || 0) + 1;
        console.error('File read error', err);
        setToast({ type: 'error', message: `Error processing ${file.name}` });
      }

      // Yield every few files so the GC can reclaim parse buffers when a folder
      // contains many CSVs.
      if ((i + 1) % 5 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    console.log(`[handleFiles] done. ${inputFiles.length} received, ${newStaged.length} staged, ${skippedCount} skipped. Reasons:`, skippedReasons);
    setUploadSummary({
      found: inputFiles.length,
      staged: newStaged.length,
      skipped: skippedCount,
      reasons: skippedReasons,
      skippedFiles: skippedFileMessages,
    });

    // Misfit files get the big centered popup (with the target section
    // highlighted) instead of a one-line toast that scrolls away.
    if (misfitFiles.length > 0) {
      setSectionMisfits(misfitFiles);
      setHighlightSection(CATEGORY_TARGET_SECTION[misfitFiles[0].category] ?? null);
    }

    if (newStaged.length > 0) {
      setStagedFiles((prev) => [...prev, ...newStaged]);
      const totalNew = newStaged.reduce((sum, s) => sum + s.stats.new, 0);
      const totalDup = newStaged.reduce((sum, s) => sum + s.stats.duplicate, 0);
      setToast({
        type: 'success',
        message: `${newStaged.length} file(s) staged: ${totalNew.toLocaleString()} new rows, ${totalDup.toLocaleString()} duplicates skipped.`,
      });
    }

    // Wait for every direct SQL staging job to finish before closing the
    // loading popup. Non-SQL files (GeoJSON, school CSVs) just sit in staged
    // files and need the user to click Add All, so they don't block the popup.
    if (sqlStagingPromises.length > 0) {
      setUploadProgress({
        current: 0,
        total: sqlStagingPromises.length,
        fileName: '',
        phase: 'Staging CSV rows in SQL…',
        startedAt: Date.now(),
      });
      await Promise.all(sqlStagingPromises);
      setUploadProgress(null);
    }

    // Show WHAT was uploaded, per file: data kind, year, row counts and the
    // zip codes/cities the file covers — the toasts never made that clear.
    // Fires for SQL CSVs AND GeoJSON uploads alike. Every document opens
    // EXPANDED — the popup is the "what did I upload" report, so hiding it
    // behind a collapsed eye made it look empty.
    if (newStaged.length > 0) {
      const reportItems = newStaged
        .filter((s) => s.sessionId || s.geoJson)
        .map((s) => buildUploadReportFor(s));
      if (reportItems.length) {
        setUploadReport(reportItems);
        setReportExpanded(new Set(reportItems.map((_, i) => i)));
      }
    }

    setProcessing(false);

    if (newStaged.length > 0) {
      // Trigger a quick dedupe pass so staged rows also honor the same-MCS
      // duplicate detection. This is normally a no-op, but prevents stale state.
      setStagedFiles((prev) =>
        prev.map((s) => ({
          ...s,
          stats: {
            total: s.record.rows.length,
            new: s.record.rows.length,
            duplicate: 0,
          },
        }))
      );
    }
  };

  const dismissMisfits = () => {
    setSectionMisfits([]);
    setHighlightSection(null);
  };

  /** Re-run the misfit files through the section they actually belong to. */
  const sendMisfitsToRightSection = async () => {
    // Plain object — `Map` is shadowed by the react-icons Map component here.
    const groups: Partial<Record<Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>, File[]>> = {};
    for (const m of sectionMisfits) {
      const target = CATEGORY_TARGET_SECTION[m.category] || 'current';
      (groups[target] = groups[target] || []).push(m.file);
    }
    dismissMisfits();
    for (const [target, files] of Object.entries(groups) as [Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>, File[]][]) {
      setSection(target);
      await handleFiles(files, target);
    }
  };

  /** Keep the misfit files in the section they were dropped on. */
  const uploadMisfitsHere = async () => {
    const files = sectionMisfits.map((m) => m.file);
    const droppedSection = section;
    dismissMisfits();
    await handleFiles(files, droppedSection as Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>, {
      ignoreSectionMismatch: true,
    });
  };

  const runSqlStaging = async (
    id: string,
    rows: Record<string, string>[],
    category: any,
    sessionId: string,
    defaultYear?: number | null
  ) => {
    try {
      const { csvRowsToSqlPropertyRows } = await import('@/lib/sqlImport');
      const sqlRows = csvRowsToSqlPropertyRows(rows, category, sessionId, defaultYear);
      await stagePropertyRows(sqlRows, (loaded) => {
        setStagedFiles((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, importProgress: { ...s.importProgress!, loaded, total: sqlRows.length, status: 'running' } } : s
          )
        );
      });
      setStagedFiles((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, importProgress: { ...s.importProgress!, loaded: sqlRows.length, total: sqlRows.length, status: 'done' } } : s
        )
      );
    } catch (err) {
      const message = (err as Error).message || 'SQL import failed';
      console.error('[admin] direct SQL import failed', err);
      setStagedFiles((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, importProgress: { ...s.importProgress!, status: 'error', error: message } } : s
        )
      );
      // Look up may miss if the staged list moved mid-flow — never print a
      // bare "undefined:" prefix to the user.
      const failedName = stagedFiles.find((s) => s.id === id)?.record.name || 'Uploaded file';
      setToast({ type: 'error', message: `${failedName}: ${message}` });
    }
  };

  const handleContinueStaged = async (stagedId: string) => {
    const staged = stagedFiles.find((s) => s.id === stagedId);
    if (!staged || !staged.sessionId) return;
    setStagedFiles((prev) =>
      prev.map((s) =>
        s.id === stagedId
          ? {
              ...s,
              duplicateWarning: s.duplicateWarning ? { ...s.duplicateWarning, status: 'confirmed' } : undefined,
              importProgress: { ...s.importProgress!, loaded: 0, total: s.importProgress?.total ?? s.record.rows.length, status: 'running' },
            }
          : s
      )
    );
    await runSqlStaging(stagedId, staged.record.rows, staged.record.category as any, staged.sessionId, staged.record.year);
  };

  const handleConfirmUpload = async (stagedId: string, mode: 'new' | 'replace' = 'new') => {
    const staged = stagedFiles.find((s) => s.id === stagedId);
    if (!staged) return;

    setProcessing(true);

    const existingFile = files.find((f) => f.name === staged.record.name);

    // Area Metrics: handle the GeoJSON flow separately. We use the parsed
    // FeatureCollection from the staging step, optionally merging with the
    // existing custom-area file in Storage.
    if (staged.section === 'areas' && staged.geoJson) {
      try {
        let featuresToSave = staged.geoJson.features;
        if (mode === 'new') {
          const existingFeatures: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };
          for (const f of files.filter((f) => f.category === 'boundary')) {
            if (!f.storageUrl) continue;
            try {
              const j = await fetchJsonAutoGz<any>(f.storageUrl);
              if (j && Array.isArray(j.features)) {
                for (const feat of j.features) existingFeatures.features.push(feat);
              }
            } catch {
              // ignore
            }
          }
          const diff = diffAgainstExisting(staged.geoJson, existingFeatures);
          featuresToSave = diff.newFeatures;
          if (featuresToSave.length === 0) {
            setToast({ type: 'error', message: `${staged.record.name}: no new areas to upload.` });
            setProcessing(false);
            return;
          }
        }

        const merged = mergeFeaturesReplacing(
          existingFile
            ? { type: 'FeatureCollection', features: [] } // start fresh in merge (we already passed new features)
            : { type: 'FeatureCollection', features: [] },
          featuresToSave
        );

        // When an existing file with the same name is in Storage, fetch it so
        // mergeFeaturesReplacing replaces only the duplicates rather than
        // dropping pre-existing features.
        let combined = merged;
        if (existingFile?.storageUrl && mode === 'replace') {
          try {
            const j = await fetchJsonAutoGz<any>(existingFile.storageUrl);
            if (j && Array.isArray(j.features)) {
              combined = mergeFeaturesReplacing(
                { type: 'FeatureCollection', features: j.features },
                featuresToSave
              );
            }
          } catch {
            // ignore
          }
        } else if (existingFile?.storageUrl && mode === 'new') {
          try {
            const j = await fetchJsonAutoGz<any>(existingFile.storageUrl);
            if (j && Array.isArray(j.features)) {
              combined = mergeFeaturesReplacing(
                { type: 'FeatureCollection', features: j.features },
                featuresToSave
              );
            }
          } catch {
            // ignore
          }
        }

        const json = JSON.stringify(combined);
        const recordToSave: CMSFileRecord = {
          ...staged.record,
          rows: [],
          headers: [],
          rawContent: json,
          size: new Blob([json]).size,
          // Stamp at CONFIRM time, not staging: this timestamp is what the
          // map's freshness probe compares against the build, so it must
          // reflect the moment the new bytes actually landed.
          uploadedAt: Date.now(),
          rowCount: 0,
        };

        // "Replace" must actually replace: remove every existing file with the
        // same name BEFORE saving the new one. Saving first and removing after
        // left the old metadata doc in place (two files with the same name —
        // both pointing at the SAME storage path, since the path is the file
        // name), and the later cleanup deleted the shared object out from
        // under the new file.
        for (const dup of files.filter((f) => f.name === staged.record.name)) {
          await cmsStore.removeFile(dup.id);
        }
        await cmsStore.saveFile(recordToSave);
        setStagedFiles((prev) => prev.filter((s) => s.id !== stagedId));
        await loadData();
        // Wait for any dataset rebuild to finish so the user sees live data.
        const { waitForDatasetRebuild } = await import('@/lib/datasetRebuild/client');
        try {
          await waitForDatasetRebuild();
        } catch (rebuildErr) {
          setToast({ type: 'error', message: (rebuildErr as Error).message || 'Map data update failed.' });
          setProcessing(false);
          return;
        }
        await reloadEngine();
        setToast({
          type: 'success',
          message: `${staged.record.name} uploaded and map data is now available (${combined.features.length.toLocaleString()} areas).`,
        });
      } catch (err) {
        console.error('Upload error', err);
        setToast({ type: 'error', message: `Error uploading ${staged.record.name}` });
      }
      setProcessing(false);
      return;
    }

    // Generic CSV/section upload (sales, rent, current, tax, schools, boundaries).
    let rowsToSave = staged.record.rows || [];

    // Property CSVs go straight to SQL Connect, which upserts by mls_number.
    // Local de-duplication against an existing Storage file is not needed there
    // and can incorrectly collapse a re-upload to zero rows, so skip it for
    // SQL imports. Legacy GeoJSON/Storage CSV flows still de-duplicate locally.
    const dataSection = staged.section as Exclude<AdminSection, 'dashboard' | 'areas' | 'boundaries' | 'ads' | 'users'>;
    const columns = getDedupeColumns(dataSection);
    const isSqlImport =
      staged.record.category !== 'boundary' && staged.record.category !== 'custom-area';
    if (existingFile && columns.length && !isSqlImport) {
      const existingFull = await cmsStore.getFile(existingFile.id);
      const existingRows = existingFull?.rows || [];
      const seen = new Set<string>();
      rowsToSave = [];
      for (const row of [...existingRows, ...staged.record.rows]) {
        const key = makeDedupeKey(row, columns);
        if (!seen.has(key)) {
          seen.add(key);
          rowsToSave.push(row);
        }
      }
    }

    if (!Array.isArray(rowsToSave) || rowsToSave.length === 0) {
      setToast({
        type: 'error',
        message: `No new records to upload for ${staged.record.name}. The file may already be imported or every row is a duplicate.`,
      });
      setProcessing(false);
      return;
    }

    const rawContent = rowsToCsv(staged.record.headers, rowsToSave);
    const recordToSave: CMSFileRecord = {
      ...staged.record,
      rows: rowsToSave,
      rawContent,
      size: new Blob([rawContent]).size,
      // Stamp at CONFIRM time, not staging: the map's freshness probe compares
      // this timestamp against the build's versions.json.
      uploadedAt: Date.now(),
      rowCount: staged.record.category === 'boundary' || staged.record.category === 'custom-area' ? 0 : rowsToSave.length,
    };

    try {
      // Remove any existing file with the same name first so the metadata doc
      // doesn't accumulate duplicates.
      for (const dup of files.filter((f) => f.name === staged.record.name)) {
        await cmsStore.removeFile(dup.id);
      }

      if (isSqlImport) {
        // Rows are already staged in SQL with upload_session_id. Confirming
        // commits this file's session and saves the metadata doc.
        if (staged.sessionId) {
          await commitPendingSession(staged.sessionId);
        }
        // Tax/sale uploads: merge the tax bucket onto the matching sale rows so
        // the tax report + tax map metric work. Idempotent; skipped with a
        // console warning while the mergeTaxIntoSaleRows connector op hasn't
        // been deployed yet.
        if (TAX_MERGE_CATEGORIES.has(staged.record.category)) {
          try {
            await mergeTaxIntoSaleRows();
          } catch (err) {
            console.warn('[admin] mergeTaxIntoSaleRows unavailable yet', err);
          }
        }

        await cmsStore.saveSqlImportMetadata(recordToSave);
        const totalRows = await countCommittedProperties();
        await publishSqlDatasetVersion(totalRows);
        setStagedFiles((prev) => prev.filter((s) => s.id !== stagedId));
        await loadData();
        await reloadEngine();
        setToast({
          type: 'success',
          message: `${staged.record.name} confirmed (${rowsToSave.length.toLocaleString()} rows, ${totalRows.toLocaleString()} total). The map will refresh automatically.`,
        });
      } else {
        // GeoJSON: keep the Storage + Firestore flow.
        await cmsStore.saveFile(recordToSave);
        setStagedFiles((prev) => prev.filter((s) => s.id !== stagedId));
        await loadData();
        // Dataset rebuild is asynchronous; wait for it to publish before
        // refreshing the engine so the user sees the new data immediately.
        const { waitForDatasetRebuild } = await import('@/lib/datasetRebuild/client');
        try {
          await waitForDatasetRebuild();
        } catch (rebuildErr) {
          setToast({ type: 'error', message: (rebuildErr as Error).message || 'Map data update failed.' });
          setProcessing(false);
          return;
        }
        await reloadEngine();
        setToast({
          type: 'success',
          message: `${staged.record.name} added successfully and map data is now available (${rowsToSave.length.toLocaleString()} rows).`,
        });
      }
    } catch (err) {
      console.error('Upload error', err);
      setToast({ type: 'error', message: `Error uploading ${staged.record.name}: ${(err as Error).message}` });
    }
    setProcessing(false);
  };

  const handleDiscardStaged = async (stagedId: string) => {
    const staged = stagedFiles.find((s) => s.id === stagedId);
    if (staged?.sessionId) {
      try {
        await deletePendingSession(staged.sessionId);
      } catch (err) {
        console.warn('[admin] deletePendingSession failed', err);
      }
    }
    setStagedFiles((prev) => prev.filter((s) => s.id !== stagedId));
  };

  const openConfirmAllModal = () => {
    if (stagedFiles.length === 0) return;
    const sqlStaged = stagedFiles.filter((s) => s.sessionId);
    const geoStaged = stagedFiles.filter((s) => !s.sessionId);
    const sqlRows = sqlStaged.reduce((sum, s) => sum + s.stats.new, 0);
    const geoRows = geoStaged.reduce((sum, s) => sum + s.stats.new, 0);
    const years = Array.from(
      new Set(
        stagedFiles.map((s) => s.record.year ?? detectDatasetYear(s.record.name, s.record.rows)).filter(Boolean)
      )
    ) as number[];
    setConfirmAll({
      open: true,
      totalFiles: stagedFiles.length,
      totalRows: sqlRows + geoRows,
      sqlFiles: sqlStaged.length,
      sqlRows,
      geoJsonFiles: geoStaged.length,
      years,
    });
  };

  const closeConfirmAllModal = () => {
    setConfirmAll((s) => ({ ...s, open: false }));
  };

  const handleConfirmAllUploads = async () => {
    if (stagedFiles.length === 0) return;
    closeConfirmAllModal();
    setProcessing(true);

    // Sort staged files by detected year so the admin tree shows them grouped
    // consistently. Property CSVs are already in SQL as pending sessions; GeoJSON
    // still needs the Storage flow.
    const ordered = [...stagedFiles].sort((a, b) => {
      const ya = a.record.year ?? detectDatasetYear(a.record.name, a.record.rows) ?? 9999;
      const yb = b.record.year ?? detectDatasetYear(b.record.name, b.record.rows) ?? 9999;
      if (ya !== yb) return ya - yb;
      return a.record.name.localeCompare(b.record.name);
    });
    setStagedFiles(ordered);

    const readySqlStaged = ordered.filter((s) => s.sessionId && s.importProgress?.status === 'done');
    const pendingSqlStaged = ordered.filter((s) => s.sessionId && s.importProgress?.status !== 'done');
    const otherStaged = ordered.filter((s) => !s.sessionId);

    // Commit every pending SQL session in a single mutation, then save all
    // metadata docs. This avoids multiple round trips to Vercel.
    if (readySqlStaged.length > 0) {
      setUploadProgress({ current: 0, total: readySqlStaged.length, fileName: '', phase: 'Committing to SQL…', startedAt: Date.now() });
      await commitPendingProperties();
      // Merge the tax bucket onto sale rows when the batch touched tax or sale
      // data (idempotent; skipped with a warning if the op isn't deployed yet).
      if (readySqlStaged.some((s) => TAX_MERGE_CATEGORIES.has(s.record.category))) {
        setUploadProgress({ current: 0, total: readySqlStaged.length, fileName: '', phase: 'Merging tax data…', startedAt: Date.now() });
        try {
          await mergeTaxIntoSaleRows();
        } catch (err) {
          console.warn('[admin] mergeTaxIntoSaleRows unavailable yet', err);
        }
      }
      for (let i = 0; i < readySqlStaged.length; i++) {
        const staged = readySqlStaged[i];
        setUploadProgress({ current: i + 1, total: readySqlStaged.length, fileName: staged.record.name, phase: 'Saving metadata…', startedAt: Date.now() });
        const rawContent = rowsToCsv(staged.record.headers, staged.record.rows);
        const recordToSave: CMSFileRecord = {
          ...staged.record,
          rows: staged.record.rows,
          rawContent,
          size: new Blob([rawContent]).size,
          uploadedAt: Date.now(),
          rowCount: staged.record.rows.length,
        };
        for (const dup of files.filter((f) => f.name === staged.record.name)) {
          await cmsStore.removeFile(dup.id);
        }
        await cmsStore.saveSqlImportMetadata(recordToSave);
      }
      const totalRows = await countCommittedProperties();
      await publishSqlDatasetVersion(totalRows);
      setStagedFiles((prev) => prev.filter((s) => !readySqlStaged.some((r) => r.id === s.id)));
      await loadData();
      await reloadEngine();
      setToast({
        type: 'success',
        message: `Confirmed ${readySqlStaged.length.toLocaleString()} SQL file(s). Database now has ${totalRows.toLocaleString()} committed properties.`,
      });
    }

    // Process GeoJSON / non-SQL files one by one (Storage + dataset rebuild).
    for (let i = 0; i < otherStaged.length; i++) {
      const staged = otherStaged[i];
      setUploadProgress({
        current: i,
        total: otherStaged.length,
        fileName: staged.record.name,
        phase: 'Uploading file…',
        startedAt: Date.now(),
      });
      await handleConfirmUpload(staged.id);
    }

    setUploadProgress({
      current: readySqlStaged.length + otherStaged.length,
      total: stagedFiles.length,
      fileName: '',
      phase: 'Finishing up…',
      startedAt: Date.now(),
    });
    setUploadProgress(null);
    setProcessing(false);
  };

  const handleDelete = async (id: string) => {
    const file = files.find((f) => f.id === id);
    await cmsStore.removeFile(id);

    // Deleting the CMS doc alone leaves the rows this file upserted into SQL
    // on the map forever — remove those exact rows too (same primary keys the
    // import mapper wrote when the file was uploaded).
    let sqlError: string | null = null;
    if (file && SQL_BACKED_CATEGORIES.has(file.category)) {
      try {
        const keys = await collectSqlKeysForFile(file);
        if (keys.length > 0) {
          await fetch('/api/sql/delete-property-keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys }),
          });
        }
        const remaining = await countCommittedProperties();
        await publishSqlDatasetVersion(remaining);
      } catch (err) {
        console.error('[admin] SQL row delete failed', err);
        sqlError = err instanceof Error ? err.message : String(err);
      }
    }
    await loadSqlStatus();
    await reloadEngine();
    if (sqlError) {
      setToast({ type: 'error', message: `${file?.name ?? 'File'}: removed from the CMS, but its SQL rows could not be deleted (${sqlError}).` });
    } else {
      setToast({ type: 'success', message: 'File removed and map updated.' });
    }
  };

  /**
   * Preview a CMS file. GeoJSON boundary files (category 'boundary'/'custom-area'
   * or a .geojson/.json name) are parsed as JSON and shown as a feature table;
   * everything else keeps the CSV table preview.
   */
  const handlePreview = async (file: Omit<CMSFileRecord, 'rows'>) => {
    try {
      const isGeoJson =
        file.category === 'boundary' ||
        file.category === 'custom-area' ||
        /\.(geojson|json)(\.gz)?$/i.test(file.name);
      if (isGeoJson) {
        // GeoJSON storage objects may be gzipped (cmsStore.saveFile) — use the
        // sniffing helper instead of a raw text fetch.
        const parsed = await fetchJsonAutoGz<any>(file.storageUrl || '');
        const features: any[] = Array.isArray(parsed?.features) ? parsed.features : [];
        const typeCounts: Record<string, number> = {};
        for (const f of features) {
          const t = f?.geometry?.type || 'Unknown';
          typeCounts[t] = (typeCounts[t] || 0) + 1;
        }
        const headers = ['#', 'id', 'name', 'geometry', 'properties'];
        const rows = features.slice(0, 100).map((f, i) => ({
          '#': String(i + 1),
          id: String(f?.properties?.id ?? f?.id ?? ''),
          name: String(f?.properties?.name ?? f?.properties?.NAME ?? ''),
          geometry: String(f?.geometry?.type ?? ''),
          properties: JSON.stringify(f?.properties ?? {}).slice(0, 160),
        }));
        setPreviewFile({
          ...file,
          headers,
          rows,
          isGeoJson: true,
          totalFeatures: features.length,
          geometryTypes: Object.entries(typeCounts)
            .map(([t, n]) => `${t} × ${n.toLocaleString()}`)
            .join(' · '),
        });
      } else {
        // Read the stored CSV the same robust way the SQL-delete path does
        // (no-store, gzip-sniffed) — a stale cached copy or a gzipped backup
        // would parse into garbage and blank the preview.
        const response = await fetch(file.storageUrl || '', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Preview fetch failed: ${response.status}`);
        const buf = await response.arrayBuffer();
        const head = new Uint8Array(buf.slice(0, 2));
        let text: string;
        if (head[0] === 0x1f && head[1] === 0x8b) {
          const ds = (globalThis as any).DecompressionStream as typeof DecompressionStream | undefined;
          if (!ds) throw new Error('Browser does not support gzip decompression.');
          const stream = new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(buf));
              c.close();
            },
          });
          text = await new Response(stream.pipeThrough(new ds('gzip'))).text();
        } else {
          text = new TextDecoder().decode(buf);
        }
        // Some exports carry a UTF-8 BOM — it must never become a header key.
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
        // Prefer the FRESH headers from the stored content: the metadata's
        // headers could describe an older version of this file (a same-name
        // re-upload overwrote the Storage object), and stale headers would
        // look up the wrong keys and blank every cell.
        setPreviewFile({
          ...file,
          headers: parsed.meta.fields ?? file.headers,
          rows: parsed.data as Record<string, string>[],
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleClearAll = async () => {
    const sectionConfig =
      section === 'dashboard' || section === 'ads' || section === 'users'
        ? null
        : SECTION_CONFIG[section as keyof typeof SECTION_CONFIG];
    const categories = sectionConfig
      ? (Array.isArray(sectionConfig.category) ? sectionConfig.category : [sectionConfig.category])
      : [];
    const scope = sectionConfig?.title.toLowerCase() ?? 'uploaded';
    if (confirm(`Are you sure you want to delete ALL ${scope} files? This cannot be undone.`)) {
      setProcessing(true);
      await cmsStore.clearFiles(categories.length ? categories : undefined);

      // The CMS files are gone, but their rows were already upserted into SQL
      // — those must be deleted too or the map keeps showing them forever.
      // Scope: sales/rent rows always carry a Close Date ('dated'), active
      // listings never do ('undated'), so deleting one section cannot take the
      // other with it. Dashboard wipes the whole table.
      const sqlTypesByCategory: Record<string, { types: string[]; dateMode: 'any' | 'dated' | 'undated' }> = {
        sales: { types: ['sale'], dateMode: 'dated' },
        rent: { types: ['rent'], dateMode: 'dated' },
        'current-sale': { types: ['sale'], dateMode: 'undated' },
        'current-rent': { types: ['rent'], dateMode: 'undated' },
        tax: { types: ['tax'], dateMode: 'any' },
      };
      const sqlScope = { types: [] as string[], dateMode: 'any' as 'any' | 'dated' | 'undated' };
      for (const cat of categories) {
        const mapped = sqlTypesByCategory[cat];
        if (mapped && !sqlScope.types.includes(mapped.types[0])) {
          sqlScope.types.push(...mapped.types);
          if (sqlScope.dateMode === 'any') sqlScope.dateMode = mapped.dateMode;
        }
      }
      if (categories.length === 0) {
        // Dashboard: delete everything in SQL too.
        sqlScope.types = [];
        sqlScope.dateMode = 'any';
      }

      try {
        await fetch('/api/sql/clear-listing-types', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ types: sqlScope.types, dateMode: sqlScope.dateMode }),
        });
        // Bump the dataset version so the map re-queries SQL and every browser
        // picks up the deletion immediately (fresh ETag).
        const remaining = await countCommittedProperties();
        await publishSqlDatasetVersion(remaining);
        await loadSqlStatus();
      } catch (err) {
        console.error('[admin] SQL delete failed', err);
        setToast({ type: 'error', message: 'Files deleted, but the SQL rows could not be removed. Check the console.' });
        setProcessing(false);
        return;
      }

      await reloadEngine();
      setToast({ type: 'success', message: `All ${scope} files have been deleted, including their SQL rows.` });
      setProcessing(false);
    }
  };

  const handleSaveOverride = async () => {
    if (!overrideBoundaryId.trim() || overrideValue === '') {
      setToast({ type: 'error', message: 'Select a boundary ID and enter a value.' });
      return;
    }
    const value = Number(overrideValue);
    if (!isFinite(value)) {
      setToast({ type: 'error', message: 'Value must be a number.' });
      return;
    }
    const id = `override-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const override: CMSMetricOverride = {
      id,
      boundary: overrideBoundary,
      boundaryId: overrideBoundaryId.trim().toUpperCase(),
      metric: overrideMetric,
      value,
      note: overrideNote.trim(),
      updatedAt: Date.now(),
    };
    await cmsStore.saveOverride(override);
    await reloadEngine();
    setOverrideBoundaryId('');
    setOverrideValue('');
    setOverrideNote('');
    setToast({ type: 'success', message: 'Override saved and map updated.' });
  };

  const handleDeleteOverride = async (id: string) => {
    await cmsStore.removeOverride(id);
    await reloadEngine();
    setToast({ type: 'success', message: 'Override removed and map updated.' });
  };

  const getQuickFields = useCallback(
    (key: AdminSection): string[] => {
      if (key === 'rent') return RENT_QUICK_FIELDS;
      if (key === 'current') return CURRENT_QUICK_FIELDS;
      if (key === 'tax') return TAX_QUICK_FIELDS;
      return SALES_QUICK_FIELDS;
    },
    []
  );

  const fillQuickFields = useCallback(
    (property: PropertyData | null, targetSection: AdminSection) => {
      if (!property) return {};
      const raw = property as unknown as Record<string, unknown>;
      const fields = getQuickFields(targetSection);
      const map: Record<string, string> = {};
      fields.forEach((h) => {
        const key = FIELD_TO_PROPERTY_KEY[h] ?? (h as keyof typeof raw);
        if (!key) {
          map[h] = '';
          return;
        }
        const val = raw[key as string];
        map[h] = val != null && val !== '' ? String(val) : '';
      });
      return map;
    },
    [getQuickFields]
  );

  const handleSavePropertyEdit = async (
    fields: Record<string, string>,
    property: PropertyData | null,
    mode: PropertyEditMode = 'edit'
  ) => {
    const mlsNumber = fields['MLS Number']?.trim() || property?.mlsNumber || '';
    const address = fields['Address']?.trim() || property?.address || '';
    const zip = fields['Zip']?.trim() || property?.zip || '';

    if (!address || !zip) {
      setToast({ type: 'error', message: 'Address and Zip are required.' });
      return;
    }

    if (mode === 'create') {
      const required = ['City/Location', 'State Or Province', 'Latitude', 'Longitude'];
      const missing = required.filter((k) => !fields[k]?.trim());
      if (missing.length) {
        setToast({ type: 'error', message: `New record needs: ${missing.join(', ')}` });
        return;
      }
      if (!mlsNumber) {
        setToast({ type: 'error', message: 'MLS Number is required for a new record.' });
        return;
      }
    }

    const existing = property
      ? propertyOverrides.find(
          (o) => o.mlsNumber === property.mlsNumber && o.address === property.address && o.zip === property.zip
        )
      : propertyOverrides.find((o) => o.mlsNumber === mlsNumber && o.address === address && o.zip === zip);
    const id = existing ? existing.id : `prop-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const record: CMSPropertyOverride = {
      id,
      mlsNumber,
      address,
      zip,
      fields,
      updatedAt: Date.now(),
      source: 'manual',
      mode,
    };
    await cmsStore.savePropertyOverride(record);
    await reloadEngine();
    setToast({ type: 'success', message: mode === 'create' ? 'New record created and map updated.' : 'Change saved and map updated.' });
  };

  const handleDeletePropertyEdit = async (id: string) => {
    await cmsStore.removePropertyOverride(id);
    await reloadEngine();
    setToast({ type: 'success', message: 'Edit removed and map updated.' });
  };

  const handleSaveSchoolEdit = async () => {
    if (!schoolName.trim() || schoolScore === '') {
      setToast({ type: 'error', message: 'Enter school name and score.' });
      return;
    }
    const value = Number(schoolScore);
    if (!isFinite(value)) {
      setToast({ type: 'error', message: 'Score must be a number.' });
      return;
    }
    const boundary: BoundaryKey = schoolLevel === 'elementary' ? 'elementary' : schoolLevel === 'middle' ? 'middle' : 'highschools';
    const metric: MetricKey =
      schoolLevel === 'elementary' ? 'Elem ETA Score' : schoolLevel === 'middle' ? 'Middle ETA Score' : 'High ETA Score';
    const id = `override-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const override: CMSMetricOverride = {
      id,
      boundary,
      boundaryId: schoolName.trim().toUpperCase(),
      metric,
      value,
      updatedAt: Date.now(),
    };
    await cmsStore.saveOverride(override);
    await reloadEngine();
    setSchoolName('');
    setSchoolScore('');
    setToast({ type: 'success', message: 'School rating saved and map updated.' });
  };

  const sectionFiles = useMemo(() => {
    if (section === 'dashboard' || section === 'ads' || section === 'users') return [];
    // 'areas' reads SECTION_CONFIG like every other section — its category is
    // 'boundary' (the only category the map reads for polygons), so the map's
    // boundary GeoJSON files appear here.
    const config = SECTION_CONFIG[section as keyof typeof SECTION_CONFIG];
    if (!config) return [];
    const cats = Array.isArray(config.category) ? config.category : [config.category];
    return files.filter((f) => cats.includes(f.category));
  }, [files, section]);

  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return sectionFiles;
    const q = searchQuery.toLowerCase();
    return sectionFiles.filter((f) => f.name.toLowerCase().includes(q));
  }, [sectionFiles, searchQuery]);

  // Per-section data status: what has been uploaded and how many manual edits
  // exist. Duplicates are handled separately below — scanned from THIS
  // section's uploaded files only (the engine's data array mixes all sections,
  // so scanning it would show the same number everywhere).
  const sectionStats = useMemo(() => {
    const fileCount = sectionFiles.length;
    const fileRows = sectionFiles.reduce((a, f) => a + (f.rowCount || 0), 0);
    const fileBytes = sectionFiles.reduce((a, f) => a + (f.size || 0), 0);
    const lastUpload = sectionFiles.length
      ? Math.max(...sectionFiles.map((f) => f.uploadedAt || 0))
      : null;

    const manualEdits =
      section === 'areas'
        ? overrides.length
        : section === 'schools'
        ? overrides.filter((o) => o.metric.endsWith('ETA Score')).length
        : propertyOverrides.length;

    return { fileCount, fileRows, fileBytes, lastUpload, manualEdits };
  }, [sectionFiles, section, overrides, propertyOverrides.length]);

  // ---- Per-section duplicate scan (runs against the section's own files) ----
  const [sectionDupes, setSectionDupes] = useState<SectionDupes>(NO_SECTION_DUPES);
  const dupesScanIdRef = useRef(0);

  const runDupesScan = useCallback(
    async (sectionKey: Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>, fileList: Omit<CMSFileRecord, 'rows'>[]) => {
      const scanId = ++dupesScanIdRef.current;
      if (!fileList.length) {
        setSectionDupes({ ...NO_SECTION_DUPES, status: 'done' });
        return;
      }
      setSectionDupes({ ...NO_SECTION_DUPES, status: 'loading' });
      try {
        let totalRows = 0;
        let duplicateRows = 0;
        let keyLabel = '';
        const samples: { label: string; count: number }[] = [];
        // NOTE: `Map` (lucide-react icon) shadows the global Map in this file,
        // so plain records are used instead of Map instances.
        const counts: Record<string, { count: number; label: string }> = {};
        const bump = (k: string, label: string) => {
          const entry = counts[k];
          if (entry) entry.count++;
          else counts[k] = { count: 1, label };
        };

        if (sectionKey === 'areas') {
          // Custom-area GeoJSON files: a duplicate is the same normalized area
          // name appearing more than once across the uploaded FeatureCollections.
          keyLabel = 'Area name';
          for (const f of fileList) {
            if (!f.storageUrl) continue;
            const json = await fetchJsonAutoGz<any>(f.storageUrl);
            const feats: any[] = Array.isArray(json?.features) ? json.features : [];
            totalRows += feats.length;
            for (const feat of feats) {
              const raw = String(
                feat?.properties?.name ||
                  feat?.properties?.NAME ||
                  feat?.properties?.area ||
                  feat?.properties?.AREA ||
                  ''
              ).trim();
              if (!raw) continue;
              bump(`area|${raw.toUpperCase()}`, raw);
            }
          }
        } else if (sectionKey === 'schools') {
          // School ratings: a duplicate is the same school name appearing more
          // than once within the same level (elementary / middle / high).
          keyLabel = 'School name (per level)';
          const levels: { cat: CMSFileCategory; label: string }[] = [
            { cat: 'school-elementary', label: 'Elementary' },
            { cat: 'school-middle', label: 'Middle' },
            { cat: 'school-high', label: 'High' },
          ];
          for (const { cat, label } of levels) {
            const rows = await cmsStore.getUploadedRowsByCategories([cat]);
            totalRows += rows.length;
            for (const row of rows) {
              const name = String(row['school_name_clean'] ?? '').trim();
              if (!name) continue;
              bump(`school|${cat}|${name.toUpperCase()}`, `${name} (${label})`);
            }
          }
        } else {
          // Property-style sections: scan only the CSVs uploaded to THIS
          // section's categories, using the same dedupe key as the upload flow.
          const config = SECTION_CONFIG[sectionKey as keyof typeof SECTION_CONFIG];
          if (!config) throw new Error('Unknown section');
          const cats = Array.isArray(config.category) ? config.category : [config.category];
          keyLabel =
            sectionKey === 'tax' ? 'MLS # + Parcel ID + Address' : 'MLS Number + Address + ZIP';
          const rows = await cmsStore.getUploadedRowsByCategories(cats);
          totalRows = rows.length;
          const columns = getDedupeColumns(sectionKey as Parameters<typeof getDedupeColumns>[0]);
          for (const row of rows) {
            const parts = columns.map((col) => (row[col] ?? '').trim().toLowerCase());
            if (parts.every((p) => !p)) continue;
            bump(
              parts.join('|'),
              row['Address'] || row['MLS Number'] || row['MLS #'] || parts.join(' · ')
            );
          }
        }

        const dups = Object.values(counts)
          .filter((v) => v.count > 1)
          .sort((a, b) => b.count - a.count);
        duplicateRows = dups.reduce((a, d) => a + d.count, 0);
        if (scanId !== dupesScanIdRef.current) return; // a newer scan superseded this one
        setSectionDupes({
          status: 'done',
          totalRows,
          duplicateRows,
          keyLabel,
          samples: dups.slice(0, 8).map((d) => ({ label: d.label, count: d.count })),
        });
      } catch (err: any) {
        if (scanId !== dupesScanIdRef.current) return;
        setSectionDupes({
          ...NO_SECTION_DUPES,
          status: 'error',
          error: err?.message || 'Failed to analyze files.',
        });
      }
    },
    []
  );

  const sectionFileSig = useMemo(
    () => sectionFiles.map((f) => `${f.id}:${f.uploadedAt || 0}`).join('|'),
    [sectionFiles]
  );

  useEffect(() => {
    if (
      section === 'dashboard' ||
      section === 'ads' ||
      section === 'users' ||
      section === 'boundaries'
    ) {
      setSectionDupes(NO_SECTION_DUPES);
      return;
    }
    runDupesScan(section, sectionFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, sectionFileSig, runDupesScan]);

  const boundaryValueOptions = useMemo(() => {
    const key: keyof PropertyData =
      overrideBoundary === 'zipcodes'
        ? 'zip'
        : overrideBoundary === 'subdivisions'
        ? 'subdivisions'
        : overrideBoundary === 'highschools'
        ? 'highschools'
        : overrideBoundary === 'elementary'
        ? 'elementary'
        : overrideBoundary === 'middle'
        ? 'middle'
        : 'subdivisions';
    const values = getEngine().getUniqueValues(key);
    return values.slice(0, 500);
  }, [overrideBoundary, engineLoaded]);

  const areaOptions = useMemo(() => {
    if (!getEngine().isLoaded) return [];
    return uniqueSorted(getEngine().data.map((d) => d.area));
  }, [getEngine().isLoaded, getEngine().data.length, engineTick]);

  const zipOptions = useMemo(() => {
    if (!getEngine().isLoaded) return [];
    return uniqueSorted(getEngine().data.map((d) => d.zip));
  }, [getEngine().isLoaded, getEngine().data.length, engineTick]);

  const subdivisionOptions = useMemo(() => {
    if (!getEngine().isLoaded || !propFilters.area) return [];
    return uniqueSorted(
      getEngine().data.filter((d) => (d.area || '').trim() === propFilters.area).map((d) => d.subdivisions)
    );
  }, [getEngine().isLoaded, propFilters.area, getEngine().data.length, engineTick]);

  const marketAreaOptions = useMemo(() => {
    if (!getEngine().isLoaded || !propFilters.area) return [];
    return uniqueSorted(
      getEngine().data
        .filter((d) => {
          const areaMatch = (d.area || '').trim() === propFilters.area;
          const subMatch = !propFilters.subdivision || (d.subdivisions || '').trim() === propFilters.subdivision;
          return areaMatch && subMatch;
        })
        .map((d) => d.marketArea)
    );
  }, [getEngine().isLoaded, propFilters.area, propFilters.subdivision, getEngine().data.length, engineTick]);

  const filteredProperties = useMemo(() => {
    if (!getEngine().isLoaded) return [];
    return getEngine().data.filter((d) => {
      const areaMatch = !propFilters.area || (d.area || '').trim() === propFilters.area;
      const subMatch = !propFilters.subdivision || (d.subdivisions || '').trim() === propFilters.subdivision;
      const marketMatch = !propFilters.marketArea || (d.marketArea || '').trim() === propFilters.marketArea;
      return areaMatch && subMatch && marketMatch;
    });
  }, [getEngine().isLoaded, propFilters, getEngine().data.length, engineTick]);

  const propertiesInZip = useMemo(() => {
    if (!getEngine().isLoaded || !selectedZip) return [];
    return getEngine().data.filter((d) => (d.zip || '').trim() === selectedZip);
  }, [getEngine().isLoaded, selectedZip, getEngine().data.length, engineTick]);

  const selectedProperty = useMemo(() => {
    if (!selectedPropertyKey) return null;
    return getEngine().data.find((p) => `${p.mlsNumber}|${p.address}|${p.zip}` === selectedPropertyKey) || null;
  }, [selectedPropertyKey, getEngine().data.length, engineTick]);

  const selectedTaxProperty = useMemo(() => {
    if (!selectedTaxPropertyKey) return null;
    return propertiesInZip.find((p) => `${p.mlsNumber}|${p.address}|${p.zip}` === selectedTaxPropertyKey) || null;
  }, [selectedTaxPropertyKey, propertiesInZip]);

  useEffect(() => {
    if (!selectedProperty) {
      setEditFields({});
      return;
    }
    const existing = propertyOverrides.find(
      (o) => o.mlsNumber === selectedProperty.mlsNumber && o.address === selectedProperty.address && o.zip === selectedProperty.zip
    );
    if (existing) {
      setEditFields(existing.fields);
    } else {
      setEditFields(fillQuickFields(selectedProperty, section));
    }
  }, [selectedProperty, propertyOverrides, section, fillQuickFields]);

  useEffect(() => {
    if (!selectedTaxProperty) {
      setTaxFields({});
      return;
    }
    const existing = propertyOverrides.find(
      (o) => o.mlsNumber === selectedTaxProperty.mlsNumber && o.address === selectedTaxProperty.address && o.zip === selectedTaxProperty.zip
    );
    if (existing) {
      const fields: Record<string, string> = {};
      TAX_QUICK_FIELDS.forEach((f) => (fields[f] = existing.fields[f] ?? ''));
      setTaxFields(fields);
    } else {
      setTaxFields(fillQuickFields(selectedTaxProperty, 'tax'));
    }
  }, [selectedTaxProperty, propertyOverrides, fillQuickFields]);

  const onDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (section !== 'dashboard' && section !== 'ads' && section !== 'users') {
      const files = await collectFilesFromDataTransfer(e.dataTransfer.items);
      handleFiles(files, section as Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>);
    }
  };

  const renderDashboard = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {[
          { icon: <FileSpreadsheet className="w-5 h-5 text-blue-500" />, label: 'Uploaded files', value: summary.files },
          { icon: <Database className="w-5 h-5 text-emerald-500" />, label: 'Uploaded rows', value: formatNumber(summary.rows) },
          { icon: <BarChart3 className="w-5 h-5 text-amber-500" />, label: 'Rows in engine', value: getEngine().isLoaded ? formatNumber(getEngine().data.length) : '—' },
          { icon: <Database className="w-5 h-5 text-cyan-500" />, label: 'SQL committed', value: sqlStatus.loading ? '…' : formatNumber(sqlStatus.committed) },
          { icon: <AlertTriangle className="w-5 h-5 text-orange-500" />, label: 'SQL pending', value: sqlStatus.loading ? '…' : formatNumber(sqlStatus.pending) },
          { icon: <SlidersHorizontal className="w-5 h-5 text-purple-500" />, label: 'Area overrides', value: summary.overrides },
          { icon: <Pencil className="w-5 h-5 text-pink-500" />, label: 'Property edits', value: summary.propertyOverrides },
        ].map((stat, i) => (
          <div key={i} className="bg-surface border border-border-subtle rounded-2xl p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-background flex items-center justify-center">{stat.icon}</div>
            <div>
              <div className="text-2xl font-bold text-white">{stat.value}</div>
              <div className="text-xs text-gray-400">{stat.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-orange-500/10 border border-orange-500/30 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold text-white">
              {sqlStatus.loading
                ? 'Checking SQL status…'
                : sqlStatus.pending > 0
                ? `${sqlStatus.pending.toLocaleString()} pending propert${sqlStatus.pending === 1 ? 'y' : 'ies'} waiting for confirmation`
                : sqlStatus.error
                ? 'Could not check SQL status'
                : 'Emergency tool: confirm pending rows'}
            </div>
            <div className="text-xs text-gray-400 mt-1">
              {sqlStatus.pending > 0
                ? 'These rows are already in the database but the map cannot show them until they are confirmed. Click “Confirm all now”. If you just uploaded files and have not confirmed them yet, this is expected.'
                : 'If the map still shows 0 properties after uploading files, click here to force-confirm any rows waiting in SQL.'}
            </div>
          </div>
        </div>
        <button
          onClick={handleForceCommit}
          disabled={sqlStatus.loading}
          className="shrink-0 px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 text-white text-sm font-medium rounded-xl transition-colors"
        >
          {sqlStatus.loading ? 'Processing…' : 'Confirm all now'}
        </button>
      </div>

      <div className="bg-blue-500/10 border border-blue-500/30 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start gap-3">
          <RefreshCw className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold text-white">Browser cache looks stale?</div>
            <div className="text-xs text-gray-400 mt-1">
              If numbers look wrong after uploading, clear local storage, IndexedDB and reload with a fresh cache key.
            </div>
          </div>
        </div>
        <button
          onClick={handleHardReload}
          className="shrink-0 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-colors"
        >
          Clear cache &amp; reload
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {SECTIONS.filter((s) => s.id !== 'dashboard').map((s) => {
          const config = SECTION_CONFIG[s.id as Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>];
          const count = config
            ? files.filter((f) => (Array.isArray(config.category) ? config.category.includes(f.category) : f.category === config.category)).length
            : overrides.length;
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`text-left bg-surface border rounded-2xl p-5 transition-all group ${
                highlightSection === s.id
                  ? 'border-cyan-400 ring-2 ring-cyan-400 shadow-[0_0_24px_rgba(34,211,238,0.55)] animate-pulse'
                  : 'border-border-subtle hover:border-blue-500/50'
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-xl bg-background group-hover:bg-blue-500/20 flex items-center justify-center text-gray-300 group-hover:text-blue-400 transition-colors">
                  {s.icon}
                </div>
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-background text-gray-400">{count} files</span>
              </div>
              <h3 className="text-base font-bold text-white mb-1">{s.label}</h3>
              <p className="text-xs text-gray-400">{s.desc}</p>
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderQuickFieldInputs = (
    fields: string[],
    values: Record<string, string>,
    onChange: (key: string, value: string) => void
  ) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {fields.map((h) => (
        <div key={h}>
          <label className="text-xs font-medium text-gray-400 block mb-1">{FIELD_LABELS[h] || h}</label>
          <input
            value={values[h] ?? ''}
            placeholder={`Enter ${FIELD_LABELS[h] || h}`}
            onChange={(e) => onChange(h, e.target.value)}
            className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>
      ))}
    </div>
  );

  const SearchableSelect = ({
    options,
    value,
    onChange,
    placeholder = 'Choose…',
    disabled = false,
    optionLabel = (opt: { value: string; label: string; raw?: PropertyData }) => opt.label,
  }: {
    options: { value: string; label: string; raw?: PropertyData }[];
    value: string;
    onChange: (val: string) => void;
    placeholder?: string;
    disabled?: boolean;
    optionLabel?: (opt: { value: string; label: string; raw?: PropertyData }) => string;
  }) => {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (!open) return;
      const handler = (e: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
      };
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    useEffect(() => {
      if (open) {
        setSearch('');
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    }, [open]);

    const selectedLabel = options.find((o) => o.value === value)?.label || placeholder;

    const filtered = useMemo(() => {
      const q = search.trim().toLowerCase();
      if (!q) return options.slice(0, 300);
      return options.filter((o) => optionLabel(o).toLowerCase().includes(q)).slice(0, 300);
    }, [options, search, optionLabel]);

    return (
      <div ref={containerRef} className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className={`w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-left text-white focus:outline-none focus:border-blue-500 flex items-center justify-between ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
        </button>
        {open && (
          <div className="absolute z-50 mt-1 w-full bg-surface border border-border-subtle rounded-lg shadow-xl max-h-72 flex flex-col">
            <div className="p-2 border-b border-border-subtle">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  ref={inputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Type address, MLS or zip…"
                  className="w-full bg-background border border-border-subtle rounded-md pl-8 pr-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
            <div className="overflow-auto p-1">
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-xs text-gray-500">No matches</div>
              )}
              {filtered.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={`w-full text-left px-3 py-2 text-xs rounded-md hover:bg-background ${o.value === value ? 'bg-blue-500/20 text-blue-300' : 'text-gray-300'}`}
                >
                  {optionLabel(o)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderPropertyInfoCard = (property: PropertyData) => (
    <div className="mb-5 p-4 bg-background border border-border-subtle rounded-xl">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-white">{property.address}</div>
          <div className="text-xs text-gray-400">
            {property.city}, {property.state} {property.zip} · MLS {property.mlsNumber}
          </div>
        </div>
        <button
          onClick={() => {
            setSelectedPropertyKey('');
            setEditFields({});
          }}
          className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
        >
          <X className="w-3 h-3" /> Clear
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        {[
          { label: 'Area', value: property.area },
          { label: 'Subdivision', value: property.subdivisions },
          { label: 'Market Area', value: property.marketArea },
          { label: 'Property Type', value: property.propertyType },
          { label: 'Latitude', value: property.lat },
          { label: 'Longitude', value: property.lng },
          { label: 'Bed/Bath', value: `${property.br} / ${property.baths}` },
          { label: 'Sqft', value: property.sqft },
        ]
          .filter((item) => item.value !== '' && item.value != null)
          .map((item) => (
            <div key={item.label} className="bg-surface rounded-lg p-2">
              <div className="text-gray-500 mb-0.5">{item.label}</div>
              <div className="text-white font-medium truncate">{String(item.value)}</div>
            </div>
          ))}
      </div>
    </div>
  );

  const propertyOptions = useMemo(() => {
    if (!getEngine().isLoaded) return [];
    return filteredProperties.map((p) => ({
      value: `${p.mlsNumber}|${p.address}|${p.zip}`,
      label: `${p.address} | ${p.subdivisions || '—'} | Area ${p.area || '—'} | ${p.marketArea || '—'} | MLS ${p.mlsNumber} | ${p.zip}`,
      raw: p,
    }));
  }, [filteredProperties, getEngine().isLoaded, engineTick]);

  const renderPropertyEditor = (mode: 'sales' | 'rent' | 'current') => {
    const property = propertyEditMode === 'edit' ? selectedProperty : null;
    const fields = getQuickFields(mode);
    const sectionName = mode === 'rent' ? 'Rent Data' : mode === 'current' ? 'Current Listings' : 'Sales Data';

    return (
      <div className="bg-surface border border-border-subtle rounded-2xl p-5">
        <div className="mb-5 p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-blue-300 mb-1 flex items-center gap-2">
              <ChevronRight className="w-4 h-4" /> Manual {sectionName} Editor
            </h4>
            <p className="text-xs text-gray-400">
              {propertyEditMode === 'edit'
                ? 'Use the CSV filters to find a record, update its values, then save.'
                : 'Create a new property record. Fill the required CSV fields and the values for this section.'}
            </p>
          </div>
          <div className="flex items-center gap-1 bg-background rounded-xl p-1 border border-border-subtle">
            <button
              onClick={() => {
                setPropertyEditMode('edit');
                setCreateFields({});
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${propertyEditMode === 'edit' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              Edit existing
            </button>
            <button
              onClick={() => {
                setPropertyEditMode('create');
                setSelectedPropertyKey('');
                setEditFields({});
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 ${propertyEditMode === 'create' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              <Plus className="w-3 h-3" /> Create new
            </button>
          </div>
        </div>

        {propertyEditMode === 'edit' && (
          <>
            <div className="grid md:grid-cols-3 gap-4 mb-5">
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">1. Area</label>
                <select
                  value={propFilters.area}
                  onChange={(e) => {
                    setPropFilters((f) => ({ ...f, area: e.target.value, subdivision: '', marketArea: '' }));
                    setSelectedPropertyKey('');
                  }}
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="">All areas</option>
                  {areaOptions.map((a) => (
                    <option key={a} value={a}>Area {a}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">2. Subdivision</label>
                <select
                  value={propFilters.subdivision}
                  onChange={(e) => {
                    setPropFilters((f) => ({ ...f, subdivision: e.target.value, marketArea: '' }));
                    setSelectedPropertyKey('');
                  }}
                  disabled={!propFilters.area}
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
                >
                  <option value="">{propFilters.area ? 'All subdivisions' : 'First choose an area'}</option>
                  {subdivisionOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">3. Market Area</label>
                <select
                  value={propFilters.marketArea}
                  onChange={(e) => {
                    setPropFilters((f) => ({ ...f, marketArea: e.target.value }));
                    setSelectedPropertyKey('');
                  }}
                  disabled={!propFilters.area}
                  className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
                >
                  <option value="">{propFilters.area ? 'All market areas' : 'First choose an area'}</option>
                  {marketAreaOptions.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mb-5">
              <label className="text-xs font-medium text-gray-400 block mb-1.5">4. Select Property (search inside the dropdown)</label>
              <SearchableSelect
                value={selectedPropertyKey}
                onChange={(val) => setSelectedPropertyKey(val)}
                options={propertyOptions}
                placeholder={propFilters.area ? 'Choose a property…' : 'First choose at least an area'}
                disabled={!propFilters.area}
              />
            </div>
          </>
        )}

        {property && renderPropertyInfoCard(property)}

        {(property || propertyEditMode === 'create') && (
          <>
            <div className="mb-3">
              <label className="text-xs font-medium text-blue-300 block mb-1.5">{propertyEditMode === 'create' ? 'Required CSV fields' : 'Values to change'}</label>
              <p className="text-[11px] text-gray-500">
                {propertyEditMode === 'create'
                  ? 'Address, City, State, Zip, Latitude and Longitude are required. Then fill the section values.'
                  : 'Only fill the fields you want to change. Empty fields keep the original CSV value.'}
              </p>
            </div>

            {propertyEditMode === 'create' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                {[
                  { key: 'MLS Number', label: 'MLS Number' },
                  { key: 'Address', label: 'Address' },
                  { key: 'City/Location', label: 'City/Location' },
                  { key: 'State Or Province', label: 'State Or Province' },
                  { key: 'Zip', label: 'Zip' },
                  { key: 'Subdivision', label: 'Subdivision' },
                  { key: 'Area', label: 'Area' },
                  { key: 'Market Area', label: 'Market Area' },
                  { key: 'Latitude', label: 'Latitude' },
                  { key: 'Longitude', label: 'Longitude' },
                ].map((f) => (
                  <div key={f.key}>
                    <label className="text-xs font-medium text-gray-400 block mb-1">{f.label}</label>
                    <input
                      value={createFields[f.key] ?? ''}
                      placeholder={`Enter ${f.label}`}
                      onChange={(e) => setCreateFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                ))}
              </div>
            )}

            {renderQuickFieldInputs(
              fields,
              propertyEditMode === 'create' ? createFields : editFields,
              (key, value) => {
                if (propertyEditMode === 'create') {
                  setCreateFields((prev) => ({ ...prev, [key]: value }));
                } else {
                  setEditFields((prev) => ({ ...prev, [key]: value }));
                }
              }
            )}

            <div className="flex gap-2 mt-5">
              <button
                onClick={() =>
                  handleSavePropertyEdit(
                    propertyEditMode === 'create' ? createFields : editFields,
                    property,
                    propertyEditMode
                  )
                }
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2"
              >
                <Save className="w-4 h-4" /> {propertyEditMode === 'create' ? 'Create on map' : 'Save to map'}
              </button>
              {property && propertyOverrides.find(
                (o) => o.mlsNumber === property.mlsNumber && o.address === property.address && o.zip === property.zip
              ) && (
                <button
                  onClick={() => {
                    const existing = propertyOverrides.find(
                      (o) => o.mlsNumber === property.mlsNumber && o.address === property.address && o.zip === property.zip
                    );
                    if (existing) handleDeletePropertyEdit(existing.id);
                  }}
                  className="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2"
                >
                  <Trash2 className="w-4 h-4" /> Remove edit
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  const renderTaxEditor = () => {
    const property = selectedTaxProperty;
    return (
      <div className="bg-surface border border-border-subtle rounded-2xl p-5">
        <div className="mb-5 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
          <h4 className="text-sm font-bold text-emerald-300 mb-1 flex items-center gap-2">
            <ChevronRight className="w-4 h-4" /> Manual Tax Record Edit
          </h4>
          <p className="text-xs text-gray-400">Pick a ZIP code and property, then type the new tax values.</p>
        </div>

        <div className="grid md:grid-cols-2 gap-4 mb-5">
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1.5">1. Select ZIP Code</label>
            <select
              value={selectedZip}
              onChange={(e) => {
                setSelectedZip(e.target.value);
                setSelectedTaxPropertyKey('');
              }}
              className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
            >
              <option value="">Choose a ZIP…</option>
              {zipOptions.map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1.5">2. Select Property</label>
            <select
              value={selectedTaxPropertyKey}
              onChange={(e) => setSelectedTaxPropertyKey(e.target.value)}
              disabled={!selectedZip}
              className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
            >
              <option value="">{selectedZip ? 'Choose a property…' : 'First choose a ZIP'}</option>
              {propertiesInZip.map((p, idx) => (
                <option key={`${idx}-${p.mlsNumber}|${p.address}|${p.zip}`} value={`${p.mlsNumber}|${p.address}|${p.zip}`}>
                  {p.address} — MLS {p.mlsNumber}
                </option>
              ))}
            </select>
          </div>
        </div>

        {property && (
          <div className="mb-5 p-3 bg-background border border-border-subtle rounded-xl flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-white">{property.address}</div>
              <div className="text-xs text-gray-400">
                {property.city}, {property.state} {property.zip} · MLS {property.mlsNumber}
              </div>
            </div>
            <button
              onClick={() => {
                setSelectedTaxPropertyKey('');
                setTaxFields({});
              }}
              className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          </div>
        )}

        {property && (
          <>
            <div className="mb-3">
              <label className="text-xs font-medium text-emerald-300 block mb-1.5">3. Type the new tax values</label>
              <p className="text-[11px] text-gray-500">Only fill the fields you want to change.</p>
            </div>
            {renderQuickFieldInputs(TAX_QUICK_FIELDS, taxFields, (key, value) => setTaxFields((prev) => ({ ...prev, [key]: value })))}

            <div className="flex gap-2 mt-5">
              <button
                onClick={() => handleSavePropertyEdit(taxFields, property)}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2"
              >
                <Save className="w-4 h-4" /> Save to map
              </button>
              {propertyOverrides.find(
                (o) => o.mlsNumber === property.mlsNumber && o.address === property.address && o.zip === property.zip
              ) && (
                <button
                  onClick={() => {
                    const existing = propertyOverrides.find(
                      (o) => o.mlsNumber === property.mlsNumber && o.address === property.address && o.zip === property.zip
                    );
                    if (existing) handleDeletePropertyEdit(existing.id);
                  }}
                  className="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2"
                >
                  <Trash2 className="w-4 h-4" /> Remove edit
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  const renderSchoolEditor = () => (
    <div className="bg-surface border border-border-subtle rounded-2xl p-5">
      <div className="mb-5 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl">
        <h4 className="text-sm font-bold text-amber-300 mb-1 flex items-center gap-2">
          <ChevronRight className="w-4 h-4" /> Manual School Rating Edit
        </h4>
        <p className="text-xs text-gray-400">Pick a school level and type the school name and new score.</p>
      </div>

      <div className="grid md:grid-cols-3 gap-4 mb-5">
        <div>
          <label className="text-xs font-medium text-gray-400 block mb-1.5">1. School level</label>
          <select
            value={schoolLevel}
            onChange={(e) => setSchoolLevel(e.target.value as 'elementary' | 'middle' | 'high')}
            className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
          >
            <option value="elementary">Elementary</option>
            <option value="middle">Middle</option>
            <option value="high">High</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-400 block mb-1.5">2. School name</label>
          <input
            value={schoolName}
            onChange={(e) => setSchoolName(e.target.value)}
            placeholder="e.g. CYPRESS WOODS HS"
            className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-400 block mb-1.5">3. New overall score</label>
          <input
            type="number"
            value={schoolScore}
            onChange={(e) => setSchoolScore(e.target.value)}
            placeholder="0-100"
            className="w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
          />
        </div>
      </div>

      <button
        onClick={handleSaveSchoolEdit}
        className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2"
      >
        <Save className="w-4 h-4" /> Save school rating
      </button>
    </div>
  );

  const renderDataSection = (key: Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>) => {
    const config = SECTION_CONFIG[key];

    return (
      <div className="space-y-6">
        <div className="bg-gradient-to-r from-blue-900/20 to-transparent border border-blue-500/20 rounded-2xl p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="text-lg font-bold text-white mb-1">{config.title}</h2>
              <p className="text-sm text-gray-400">{config.subtitle}</p>
            </div>
            <div className="flex items-center gap-1 bg-background rounded-xl p-1 border border-border-subtle">
              <button
                onClick={() => setDataTab('upload')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  dataTab === 'upload' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                {key === 'boundaries' || key === 'areas' ? 'Upload GeoJSON' : 'Upload CSV'}
              </button>
              <button
                onClick={() => setDataTab('edit')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 ${
                  dataTab === 'edit' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                <Pencil className="w-3 h-3" /> Edit Manually
              </button>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-background/60 rounded-xl p-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-blue-400 mb-3 flex items-center gap-2">
                <SlidersHorizontal className="w-3 h-3" /> This changes on the map
              </h3>
              <ul className="space-y-2">
                {config.whatItModifies.map((item, i) => (
                  <li key={i} className="text-sm text-gray-300 flex items-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-background/60 rounded-xl p-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400 mb-3 flex items-center gap-2">
                <FileSpreadsheet className="w-3 h-3" />{' '}
                {key === 'boundaries' || key === 'areas' ? 'Expected GeoJSON files' : 'Expected CSV files'}
              </h3>
              <p className="text-sm text-gray-300 mb-3">{config.fileHint}</p>
              {key !== 'boundaries' && key !== 'areas' && (
                <div className="text-xs text-gray-500">
                  Required columns: <span className="text-gray-300">{config.requiredColumns.join(', ')}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Data status: uploads · edits · duplicates for THIS section */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-surface border border-border-subtle rounded-2xl p-4">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-blue-400 mb-2">
              <Upload className="w-3.5 h-3.5" /> Uploaded here
            </div>
            <div className="text-2xl font-bold text-white mb-1">
              {sectionStats.fileCount} <span className="text-sm font-medium text-gray-400">file{sectionStats.fileCount !== 1 ? 's' : ''}</span>
            </div>
            <div className="text-xs text-gray-400 leading-relaxed">
              {sectionStats.fileCount > 0 ? (
                <>
                  {formatNumber(sectionStats.fileRows)} rows · {formatBytes(sectionStats.fileBytes)}
                  <br />
                  Last upload <span className="text-gray-300">{timeAgo(sectionStats.lastUpload)}</span>
                </>
              ) : (
                'Nothing uploaded yet in this section.'
              )}
            </div>
          </div>

          <div className="bg-surface border border-border-subtle rounded-2xl p-4">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-pink-400 mb-2">
              <Pencil className="w-3.5 h-3.5" /> Manual edits
            </div>
            <div className="text-2xl font-bold text-white mb-1">
              {sectionStats.manualEdits.toLocaleString()}
            </div>
            <div className="text-xs text-gray-400 leading-relaxed">
              {section === 'areas'
                ? 'Area metrics overridden by hand — these take priority over uploaded data.'
                : section === 'schools'
                ? 'School scores overridden by hand via “Edit Manually” — these take priority over uploaded ratings.'
                : 'Properties modified by hand via “Edit Manually” — these take priority over uploaded data.'}
            </div>
          </div>

          <div className="bg-surface border border-border-subtle rounded-2xl p-4">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-2">
              <AlertTriangle className="w-3.5 h-3.5" /> Duplicates
            </div>
            {key === 'boundaries' ? (
              <div className="text-xs text-gray-400 leading-relaxed">
                Boundary files are drawn as-is on the map; duplicate features are detected at upload
                time and shown in the staging area.
              </div>
            ) : sectionDupes.status === 'loading' ? (
              <div className="text-xs text-gray-400 leading-relaxed flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing uploaded files…
              </div>
            ) : sectionDupes.status === 'error' ? (
              <div className="text-xs text-red-400 leading-relaxed">
                Could not analyze the files ({sectionDupes.error}).
                <button
                  onClick={() => runDupesScan(key, sectionFiles)}
                  className="block mt-1 text-gray-300 underline hover:text-white"
                >
                  Try again
                </button>
              </div>
            ) : sectionStats.fileCount === 0 ? (
              <div className="text-xs text-gray-400 leading-relaxed">
                Nothing uploaded yet in this section — no duplicates possible.
              </div>
            ) : (
              <>
                <div className="text-2xl font-bold text-white mb-1">
                  {sectionDupes.duplicateRows.toLocaleString()}{' '}
                  <span className="text-sm font-medium text-gray-400">rows</span>
                </div>
                <div className="text-xs text-gray-400 leading-relaxed">
                  {sectionDupes.totalRows > 0 && sectionDupes.duplicateRows > 0 ? (
                    <>
                      {sectionDupes.duplicateRows.toLocaleString()} of{' '}
                      {sectionDupes.totalRows.toLocaleString()} rows in{' '}
                      <span className="text-gray-300">{config.title}</span> share the same{' '}
                      <span className="text-gray-300">{sectionDupes.keyLabel}</span>.
                    </>
                  ) : (
                    <>No duplicates found among the {sectionDupes.totalRows.toLocaleString()} rows uploaded to {config.title}.</>
                  )}
                </div>
                {sectionDupes.samples.length > 0 && (
                  <details className="mt-2 bg-white/[0.03] border border-border-subtle rounded-lg p-2.5 text-xs">
                    <summary className="cursor-pointer text-gray-300 hover:text-white">
                      Top duplicated entries ({sectionDupes.samples.length})
                    </summary>
                    <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                      {sectionDupes.samples.map((d, i) => (
                        <div key={i} className="flex items-center justify-between gap-2">
                          <span className="text-gray-300 truncate" title={d.label}>{d.label}</span>
                          <span className="text-amber-400 font-semibold shrink-0">×{d.count}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </div>
        </div>

        {dataTab === 'upload' ? (
          <>
            <div className="grid lg:grid-cols-3 gap-6">
              <div className="lg:col-span-1">
                <div className="bg-surface border border-border-subtle rounded-2xl p-5 sticky top-4">
                  <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                    <Upload className="w-4 h-4" /> Upload {config.title}
                  </h3>
                  <div
                    onDragEnter={onDrag}
                    onDragLeave={onDrag}
                    onDragOver={onDrag}
                    onDrop={onDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                      dragActive ? 'border-blue-500 bg-blue-500/10' : 'border-border-subtle hover:border-white/30 hover:bg-background/50'
                    }`}
                  >
                    <Upload className="w-8 h-8 text-gray-500 mx-auto mb-2" />
                    <p className="text-sm text-gray-300 mb-1">Drop files or folders here</p>
                    <p className="text-xs text-gray-500 mb-3">or click to browse (folders with subfolders supported)</p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={
                        key === 'boundaries' || key === 'areas'
                          ? '.geojson,.json'
                          : '.csv'
                      }
                      multiple
                      className="hidden"
                      onChange={(e) => handleFiles(e.target.files, key)}
                      {...{ webkitdirectory: '', directory: '' }}
                    />
                    <div className="text-[10px] text-gray-500">
                      {key === 'boundaries' || key === 'areas'
                        ? 'GeoJSON features will be loaded directly onto the map layers.'
                        : 'Duplicate rows are detected and skipped; only new rows are uploaded.'}
                      <div className="text-amber-300/90 mt-1">
                        Remember to clear cache in Dashboard after uploading.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-2">
                {uploadSummary && uploadSummary.skipped > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 mb-4">
                    <div className="text-sm font-semibold text-white mb-1">
                      {uploadSummary.found} file(s) found · {uploadSummary.staged} staged · {uploadSummary.skipped} skipped
                    </div>
                    <div className="text-xs text-gray-400">
                      {Object.entries(uploadSummary.reasons).map(([reason, count]) => {
                        const labels: Record<string, string> = {
                          'wrong-extension': 'wrong file type',
                          'missing-columns': 'missing required columns',
                          'wrong-section': 'belongs to a different section',
                          'parse-error': 'parse/read error',
                        };
                        return <span key={reason} className="mr-3">{count} {labels[reason] || reason}</span>;
                      })}
                    </div>
                    {uploadSummary.skippedFiles.length > 0 && (
                      <ul className="mt-3 space-y-1.5">
                        {uploadSummary.skippedFiles.slice(0, 15).map((f, i) => (
                          <li
                            key={i}
                            className="text-[11px] leading-snug text-amber-200/90 bg-background/60 border border-amber-500/20 rounded-lg px-3 py-1.5 break-all"
                          >
                            {f.message}
                          </li>
                        ))}
                        {uploadSummary.skippedFiles.length > 15 && (
                          <li className="text-[11px] text-amber-200/70 px-3">
                            +{uploadSummary.skippedFiles.length - 15} more file(s) skipped for the reasons above.
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                )}
                {stagedFiles.length > 0 && (
                  <div className="bg-surface border border-blue-500/50 rounded-2xl p-5 mb-6 shadow-[0_0_15px_rgba(59,130,246,0.1)]">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-bold text-white flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-blue-400" /> Staging Area: Review New Rows
                      </h3>
                      {(() => {
                        const readyCount = stagedFiles.filter(
                          (s) => !s.sessionId || s.importProgress?.status === 'done'
                        ).length;
                        return (
                          <button
                            onClick={() => openConfirmAllModal()}
                            disabled={processing || readyCount === 0}
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 disabled:opacity-50"
                          >
                            <Plus className="w-3.5 h-3.5" /> Confirm all ({readyCount})
                          </button>
                        );
                      })()}
                    </div>
                    <div className="space-y-3">
                      {stagedFiles.map((staged) => (
                        <div key={staged.id} className="bg-background border border-border-subtle rounded-xl p-4">
                          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-3">
                            <div>
                              <div className="text-sm font-medium text-white break-all">{staged.record.name}</div>
                              <div className="text-xs text-gray-400">{formatBytes(staged.record.size)}</div>
                            </div>
                            <div className="flex gap-2 shrink-0 flex-wrap">
                              <button onClick={() => handleDiscardStaged(staged.id)} className="px-3 py-1.5 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg text-xs font-medium transition-colors">Discard</button>
                              {staged.section === 'areas' ? (
                                <>
                                  <button
                                    onClick={() => handleConfirmUpload(staged.id, 'new')}
                                    disabled={processing || staged.stats.new === 0}
                                    className="px-3 py-1.5 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 disabled:opacity-50"
                                  >
                                    <Plus className="w-3 h-3" /> Add {staged.stats.new.toLocaleString()} new
                                  </button>
                                  <button
                                    onClick={() => handleConfirmUpload(staged.id, 'replace')}
                                    disabled={processing || staged.stats.total === 0}
                                    className="px-3 py-1.5 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/20 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 disabled:opacity-50"
                                    title="Upload the full file (overwrites existing entries with the same area name)"
                                  >
                                    <Layers className="w-3 h-3" /> Replace all ({staged.stats.total.toLocaleString()})
                                  </button>
                                </>
                              ) : (
                                <button
                                  onClick={() => handleConfirmUpload(staged.id)}
                                  disabled={
                                    processing ||
                                    staged.stats.new === 0 ||
                                    staged.importProgress?.status === 'running' ||
                                    staged.importProgress?.status === 'error'
                                  }
                                  className="px-3 py-1.5 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 disabled:opacity-50"
                                >
                                  <Plus className="w-3 h-3" />
                                  {staged.sessionId ? `Confirm ${staged.stats.new.toLocaleString()}` : `Add ${staged.stats.new.toLocaleString()} new`}
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="grid grid-cols-3 gap-2">
                            <div className="bg-white/5 rounded-lg p-2 text-center">
                              <div className="text-[10px] sm:text-xs text-gray-400 mb-1">Total Rows</div>
                              <div className="text-xs sm:text-sm font-bold text-white">{staged.stats.total.toLocaleString()}</div>
                            </div>
                            <div className="bg-blue-500/10 rounded-lg p-2 text-center border border-blue-500/20">
                              <div className="text-[10px] sm:text-xs text-blue-400 mb-1">New Rows</div>
                              <div className="text-xs sm:text-sm font-bold text-blue-400">{staged.stats.new.toLocaleString()}</div>
                            </div>
                            <div className="bg-amber-500/10 rounded-lg p-2 text-center border border-amber-500/20">
                              <div className="text-[10px] sm:text-xs text-amber-400 mb-1">Already Exists</div>
                              <div className="text-xs sm:text-sm font-bold text-amber-400">{staged.stats.duplicate.toLocaleString()}</div>
                            </div>
                          </div>

                          {staged.sessionId && staged.importProgress ? (
                            <div className="mt-3">
                              {staged.duplicateWarning?.status === 'pending' ? (
                                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                                  <div className="flex items-start gap-2 text-amber-400 text-xs font-semibold mb-1">
                                    <AlertTriangle className="w-4 h-4 shrink-0" />
                                    This data is already in the database
                                  </div>
                                  <div className="text-xs text-gray-300 mb-2">
                                    {staged.duplicateWarning.count.toLocaleString()} existing MLS row(s) were found. Continuing will overwrite them with the new file.
                                    {staged.duplicateWarning.sampleMlsNumbers.length > 0 && (
                                      <div className="mt-1 text-amber-300/80">
                                        Examples: {staged.duplicateWarning.sampleMlsNumbers.join(', ')}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex gap-2">
                                    <button
                                      onClick={() => handleContinueStaged(staged.id)}
                                      className="px-3 py-1.5 bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 border border-amber-500/30 rounded-lg text-xs font-medium transition-colors"
                                    >
                                      Continue anyway
                                    </button>
                                    <button
                                      onClick={() => handleDiscardStaged(staged.id)}
                                      className="px-3 py-1.5 bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 rounded-lg text-xs font-medium transition-colors"
                                    >
                                      Discard
                                    </button>
                                  </div>
                                </div>
                              ) : staged.importProgress.status === 'error' ? (
                                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-xs text-red-400">
                                  Import failed: {staged.importProgress.error || 'unknown error'}
                                </div>
                              ) : staged.importProgress.status === 'running' ? (
                                <div className="text-xs text-gray-400">
                                  Staging in SQL: {staged.importProgress.loaded.toLocaleString()} / {staged.importProgress.total.toLocaleString()} rows
                                </div>
                              ) : (
                                <div className="text-xs text-emerald-400">
                                  Staged in SQL: {staged.importProgress.loaded.toLocaleString()} rows — click Add to confirm
                                </div>
                              )}
                            </div>
                          ) : null}

                          {staged.section === 'areas' && (staged.duplicateNames?.length || staged.newNames?.length || staged.csvSkipped?.length) ? (
                            <details className="mt-3 bg-white/[0.03] border border-border-subtle rounded-lg p-3 text-xs">
                              <summary className="cursor-pointer text-gray-300 hover:text-white">
                                View diff details
                                {staged.csvSkipped?.length ? ` (${staged.csvSkipped.length} CSV row(s) skipped)` : ''}
                              </summary>
                              <div className="mt-2 space-y-2">
                                {staged.newNames && staged.newNames.length > 0 ? (
                                  <div>
                                    <div className="text-blue-400 font-semibold mb-1">New areas ({staged.newNames.length})</div>
                                    <div className="text-gray-300 max-h-24 overflow-auto break-words">
                                      {staged.newNames.slice(0, 50).join(', ')}
                                      {staged.newNames.length > 50 ? ` … (+${staged.newNames.length - 50} more)` : ''}
                                    </div>
                                  </div>
                                ) : null}
                                {staged.duplicateNames && staged.duplicateNames.length > 0 ? (
                                  <div>
                                    <div className="text-amber-400 font-semibold mb-1">Already in Firebase ({staged.duplicateNames.length})</div>
                                    <div className="text-gray-300 max-h-24 overflow-auto break-words">
                                      {staged.duplicateNames.slice(0, 50).join(', ')}
                                      {staged.duplicateNames.length > 50 ? ` … (+${staged.duplicateNames.length - 50} more)` : ''}
                                    </div>
                                  </div>
                                ) : null}
                                {staged.csvSkipped && staged.csvSkipped.length > 0 ? (
                                  <div>
                                    <div className="text-red-400 font-semibold mb-1">Skipped CSV rows ({staged.csvSkipped.length})</div>
                                    <div className="text-gray-300 max-h-24 overflow-auto break-words">
                                      {staged.csvSkipped.slice(0, 20).map((s, i) => (
                                        <div key={i}>Row {s.row}: {s.reason}</div>
                                      ))}
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-surface border border-border-subtle rounded-2xl p-5">
                  <div className="flex flex-col sm:flex-row gap-3 mb-4 items-start sm:items-center justify-between">
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <Database className="w-4 h-4" /> Uploaded {config.title} Files
                    </h3>
                    <div className="flex gap-2 w-full sm:w-auto">
                      <div className="relative flex-1 sm:w-64">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                        <input
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search files…"
                          className="w-full bg-background border border-border-subtle rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                        />
                      </div>
                      <button
                        onClick={handleClearAll}
                        className="px-4 py-2 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                      >
                        <Trash2 className="w-4 h-4" /> Delete {config?.title ?? 'All'} Files
                      </button>
                    </div>
                  </div>

                  {filteredFiles.length === 0 ? (
                    <div className="text-sm text-gray-500 py-8 text-center bg-background/40 rounded-xl border border-border-subtle">
                      No {config.title.toLowerCase()} files uploaded yet.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-[500px] overflow-auto pr-1">
                      {(() => {
                        const rootNode = buildTree(filteredFiles, config.title);
                        return Object.values(rootNode.folders).map(folder => (
                          <FolderNode 
                            key={folder.name} 
                            node={folder} 
                            path={folder.name}
                            onPreview={handlePreview}
                            onDelete={handleDelete}
                          />
                        )).concat(
                          rootNode.files.map(file => (
                            <div key={file.id} className="bg-background border border-border-subtle rounded-xl p-3 flex items-center justify-between gap-3 ml-4 first:ml-0">
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-white truncate">{file.name.split('/').pop()}</div>
                                <div className="text-[10px] text-gray-400">
                                  {formatBytes(file.size)} · {new Date(file.uploadedAt).toLocaleString()}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button onClick={() => handlePreview(file)} className="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white" title="Preview">
                                  <Eye className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => { if (file.storageUrl) window.open(file.storageUrl, '_blank'); }}
                                  className="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white"
                                  title="Download"
                                >
                                  <Download className="w-4 h-4" />
                                </button>
                                <button onClick={() => handleDelete(file.id)} className="p-2 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400" title="Delete">
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          ))
                        );
                      })()}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            {key === 'tax' && renderTaxEditor()}
            {key === 'schools' && renderSchoolEditor()}
            {(key === 'sales' || key === 'rent' || key === 'current') && renderPropertyEditor(key)}
          </>
        )}
      </div>
    );
  };



  return (
    <div className="min-h-screen bg-background text-white flex font-sans">
      <style jsx global>{`
        :root {
          --background: #11131a;
          --surface: #1a1d27;
          --border-subtle: rgba(255, 255, 255, 0.08);
          --brand: #2563eb;
          --brand-hover: #1d4ed8;
        }
      `}</style>
      <aside className="w-64 shrink-0 bg-surface border-r border-border-subtle flex flex-col">
        <div className="p-4 border-b border-border-subtle">
          <Link href="/" className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors mb-4">
            <ArrowLeft className="w-4 h-4" />
            <span className="text-xs font-medium">Back to site</span>
          </Link>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow">
              <span className="text-white font-bold text-lg">K</span>
            </div>
            <div>
              <h1 className="text-sm font-bold text-white leading-tight">CMS</h1>
              <p className="text-[10px] text-gray-500">Data Manager</p>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-auto">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-left ${
                section === s.id
                  ? 'bg-blue-600 text-white shadow'
                  : highlightSection === s.id
                  ? 'bg-cyan-500/15 text-white ring-2 ring-cyan-400 shadow-[0_0_24px_rgba(34,211,238,0.55)] animate-pulse'
                  : 'text-gray-400 hover:bg-background hover:text-white'
              }`}
            >
              {s.icon}
              <span className="flex-1">{s.label}</span>
              {highlightSection === s.id && section !== s.id && (
                <span className="text-[9px] font-bold uppercase bg-cyan-400 text-black rounded-full px-1.5 py-0.5">Here</span>
              )}
            </button>
          ))}
        </nav>
        <div className="p-4 border-t border-border-subtle">
          <Link
            href="/map"
            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg shadow flex items-center justify-center gap-2 font-semibold text-sm transition-all"
          >
            <Map className="w-4 h-4" /> View Map
          </Link>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col relative">
        {processing && (
          <div className="fixed inset-0 z-[9999] bg-[#11131a]/90 backdrop-blur-sm flex flex-col items-center justify-center">
            <div className="bg-surface border border-border-subtle rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-5 max-w-md w-[90%] text-center">
              <div className="relative">
                <div className="w-12 h-12 rounded-full border-2 border-blue-500/30 border-t-blue-500 animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <RefreshCw className="w-5 h-5 text-blue-400 animate-spin" style={{ animationDirection: 'reverse' }} />
                </div>
              </div>

              <div className="w-full">
                <p className="text-base font-bold text-white">
                  {uploadProgress
                    ? uploadProgress.phase || 'Uploading map data…'
                    : 'Reloading map data…'}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {uploadProgress
                    ? uploadProgress.fileName
                      ? `Uploading ${uploadProgress.fileName}`
                      : uploadProgress.phase === 'Staging CSV rows in SQL…'
                        ? 'Rows are being inserted into SQL. The popup will close when all files are ready.'
                        : 'Please wait while the dataset refreshes.'
                    : 'Please wait while the dataset refreshes.'}
                </p>
              </div>

              {uploadProgress && uploadProgress.total > 0 && (
                <div className="w-full">
                  <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                    <span>
                      File {uploadProgress.current + 1} of {uploadProgress.total}
                    </span>
                    <span>{Math.round((uploadProgress.current / uploadProgress.total) * 100)}%</span>
                  </div>
                  <div className="w-full h-2 bg-background rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-300"
                      style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-gray-500 mt-2">
                    {uploadProgress.current < uploadProgress.total
                      ? (() => {
                          const rawMinutes = (uploadProgress.total - uploadProgress.current) * 0.5;
                          const pessimisticLow = Math.max(1, Math.round(rawMinutes * 3));
                          const pessimisticHigh = Math.max(1, Math.round(rawMinutes * 4.5));
                          return pessimisticLow === pessimisticHigh
                            ? `Estimated time remaining: about ${pessimisticLow} minutes`
                            : `Estimated time remaining: about ${pessimisticLow} to ${pessimisticHigh} minutes`;
                        })()
                      : 'Almost done…'}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        <header className="bg-surface border-b border-border-subtle px-6 py-4 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-bold text-white">{SECTIONS.find((s) => s.id === section)?.label}</h2>
            <p className="text-xs text-gray-400">{SECTIONS.find((s) => s.id === section)?.desc}</p>
          </div>
          <div className="text-xs text-gray-500">Engine rows: {getEngine().isLoaded ? formatNumber(getEngine().data.length) : '—'}</div>
        </header>

        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-6xl mx-auto">
            {loading ? (
              <div className="text-sm text-gray-400 py-12 text-center">Loading CMS…</div>
            ) : (
              <>
                {section === 'dashboard' && renderDashboard()}
                {section !== 'dashboard' && section !== 'ads' && section !== 'users' && renderDataSection(section as Exclude<AdminSection, 'dashboard' | 'ads' | 'users'>)}
                {section === 'ads' && <AdminAds />}
                {section === 'users' && <AdminUsers />}
              </>
            )}
          </div>
        </div>
      </main>

      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="bg-surface border border-border-subtle rounded-2xl w-full max-w-4xl max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                {previewFile.isGeoJson ? <Map className="w-4 h-4" /> : <FileSpreadsheet className="w-4 h-4" />} {previewFile.name}
              </h3>
              <button onClick={() => setPreviewFile(null)} className="p-1 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            {previewFile.isGeoJson && (
              <div className="px-5 py-2 border-b border-border-subtle text-xs text-gray-400 flex items-center gap-3 flex-wrap">
                <span className="text-blue-400 font-medium">GeoJSON</span>
                <span>{previewFile.totalFeatures?.toLocaleString() ?? 0} features</span>
                {previewFile.geometryTypes && <span>{previewFile.geometryTypes}</span>}
              </div>
            )}
            {/* Upload-effect summary — this is what the file lists' Eye gives
                the user. For an ALREADY-UPLOADED document the committed status
                is shown FIRST and unconditionally (the file is in the CMS, so
                its rows are in the database) — the zip split then ADDS detail
                whenever the engine can compute it. It must never be empty. */}
            {!previewFile.isGeoJson && (
              <div className="px-5 py-2.5 border-b border-border-subtle bg-cyan-500/[0.06] text-[11px] leading-relaxed">
                <div className="space-y-1">
                  <p className="font-semibold text-white">
                    <Eye className="w-3 h-3 inline mr-1 -mt-0.5" />
                    What this document does to the data:
                  </p>
                  <p className="text-white">
                    📦 Already uploaded — {(() => {
                      const n = previewFile.rows.length > 0 ? previewFile.rows.length : previewFile.rowCount ?? 0;
                      return `${n.toLocaleString()} rows committed in the database`;
                    })()}
                    {previewFile.year ? ` for year ${previewFile.year}` : ''} — this data is live on the map.
                  </p>
                  {(() => {
                    const zipEffect = computeZipEffect(previewFile.rows);
                    return (
                      <>
                        {zipEffect.classified ? (
                          <>
                            {zipEffect.updated.length > 0 && (
                              <p>
                                <span className="text-amber-300 font-semibold">Updates existing rows in:</span>{' '}
                                <span className="text-white">
                                  {zipEffect.updated.slice(0, 12).map((z) => z.name).join(', ')}
                                  {zipEffect.updated.length > 12 ? `, +${zipEffect.updated.length - 12} more` : ''}
                                </span>
                              </p>
                            )}
                            {zipEffect.added.length > 0 && (
                              <p>
                                <span className="text-emerald-400 font-semibold">Adds brand-new rows in:</span>{' '}
                                <span className="text-white">
                                  {zipEffect.added.slice(0, 12).map((z) => z.name).join(', ')}
                                  {zipEffect.added.length > 12 ? `, +${zipEffect.added.length - 12} more` : ''}
                                </span>
                              </p>
                            )}
                            <p className="text-gray-500">
                              {zipEffect.existingCount.toLocaleString()} of {previewFile.rows.length.toLocaleString()} rows{" "}
                              {zipEffect.existingCount > 0 ? 'were already in the database when this preview opened' : 'are brand-new additions'}.
                            </p>
                          </>
                        ) : null}
                        {!zipEffect.classified && zipEffect.fallback.length > 0 && (
                          <p>
                            <span className="text-gray-400">ZIPs covered in this document: </span>
                            <span className="text-white">
                              {zipEffect.fallback.slice(0, 12).map((z) => z.name).join(', ')}
                              {zipEffect.fallback.length > 12 ? `, +${zipEffect.fallback.length - 12} more` : ''}
                            </span>
                          </p>
                        )}
                      </>
                    );
                  })()}
                  <p className="text-gray-500">
                    Nothing is ever deleted — re-uploading this file updates its rows in place.
                  </p>
                </div>
              </div>
            )}
            {previewFile.isGeoJson && previewFile.category && (
              <div className="px-5 py-2.5 border-b border-border-subtle bg-cyan-500/[0.06] text-[11px] leading-relaxed">
                <p>{effectSentenceFor(previewFile.category, previewFile.year ?? null)}</p>
              </div>
            )}
            <div className="overflow-auto p-0 flex-1">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#0e1118] sticky top-0 z-10">
                  <tr>
                    {previewFile.headers.map((h) => (
                      <th key={h} className="px-3 py-2 text-gray-400 font-medium border-b border-border-subtle whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewFile.rows.slice(0, 100).map((row, i) => (
                    <tr key={i} className="hover:bg-white/5">
                      {previewFile.headers.map((h) => (
                        <td key={h} className="px-3 py-2 text-gray-300 border-b border-white/5 whitespace-nowrap">{row[h]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3 border-t border-border-subtle text-xs text-gray-500">
              Showing first 100 of {previewFile.rows.length.toLocaleString()} {previewFile.isGeoJson ? 'features' : 'rows'}
            </div>
          </div>
        </div>
      )}

      {confirmAll.open && (
        <div className="fixed inset-0 z-[10001] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121620] border border-white/[0.08] rounded-2xl shadow-2xl p-6 max-w-md w-full flex flex-col gap-4">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              Confirm all uploads
            </h3>

            <div className="text-sm text-gray-300 space-y-2">
              <p>
                You are about to publish <strong className="text-white">{confirmAll.totalFiles.toLocaleString()}</strong> staged file(s)
                with <strong className="text-white">{confirmAll.totalRows.toLocaleString()}</strong> new row(s).
              </p>
              {confirmAll.sqlFiles > 0 && (
                <p>
                  • <strong className="text-white">{confirmAll.sqlFiles.toLocaleString()}</strong> SQL file(s){' '}
                  ({confirmAll.sqlRows.toLocaleString()} rows) will become visible on the map.
                </p>
              )}
              {confirmAll.geoJsonFiles > 0 && (
                <p>
                  • <strong className="text-white">{confirmAll.geoJsonFiles.toLocaleString()}</strong> GeoJSON file(s) will update the map layers.
                </p>
              )}
              {confirmAll.years.length > 0 && (
                <p>
                  Dataset years detected:{' '}
                  <strong className="text-white">{confirmAll.years.filter((y): y is number => y != null).sort((a, b) => a - b).join(', ')}</strong>.
                  Rows with the same MLS and different year will be kept as history.
                </p>
              )}
              <p className="text-xs text-gray-400">
                This action commits the data to the live database. Existing rows with the same MLS + year will be updated,
                but historical records with other years will not be deleted.
              </p>
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={closeConfirmAllModal}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleConfirmAllUploads()}
                disabled={processing}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-600 text-white transition-colors flex items-center gap-2"
              >
                {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Yes, publish all data
              </button>
            </div>
          </div>
        </div>
      )}

      {syncLoading && (
        <div className="fixed inset-0 z-[10000] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121620] border border-white/[0.08] rounded-2xl shadow-2xl px-8 py-7 flex flex-col items-center gap-3 max-w-xs text-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
            <p className="text-sm font-bold text-white">Loading data from Firebase…</p>
            <p className="text-xs text-gray-400">Checking Firebase Storage for {syncSectionTitle.toLowerCase()} files</p>
          </div>
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium flex items-center gap-2 transition-all ${
            toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
          }`}
        >
          {toast.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toast.message}
        </div>
      )}

      {/* Big centered misfit popup: files whose content belongs to another
          section. Highlights the target section on the sidebar while open. */}
      {sectionMisfits.length > 0 && (
        <div className="fixed inset-0 z-[10001] bg-[#0b0d13]/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-surface border-2 border-cyan-500/40 rounded-3xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-auto p-6 sm:p-8">
            <div className="flex items-start gap-4 mb-4">
              <div className="w-12 h-12 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-6 h-6 text-cyan-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white leading-snug">
                  {sectionMisfits.length} file{sectionMisfits.length > 1 ? 's' : ''} belong{sectionMisfits.length > 1 ? '' : 's'} in a different section
                </h2>
                <p className="text-sm text-gray-400 mt-1">
                  These files were dropped on <span className="font-semibold text-white">{SECTION_CONFIG[section as keyof typeof SECTION_CONFIG]?.title}</span>, but the data inside says otherwise. Nothing was uploaded yet.
                </p>
              </div>
            </div>

            <div className="space-y-2 mb-4 max-h-56 overflow-auto">
              {sectionMisfits.map((m) => (
                <div key={m.relativePath} className="flex items-start gap-3 bg-background border border-border-subtle rounded-xl px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-white truncate">{m.relativePath}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">{m.evidence}</p>
                  </div>
                  <span className="shrink-0 text-[10px] font-bold uppercase bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 rounded-full px-2.5 py-1">
                    {categorySectionName(m.category)}
                  </span>
                </div>
              ))}
            </div>

            {/* Worked example so the rule is obvious. */}
            <div className="bg-cyan-500/[0.07] border border-cyan-500/20 rounded-xl px-4 py-3 mb-6">
              <p className="text-xs text-gray-300 leading-relaxed">
                <span className="font-bold text-cyan-300">How the system knows:</span> it reads the CSV content, not just the folder name. A file with real <span className="font-semibold">Close Date</span> values is sold data (Sales/Rent) even if the folder says &ldquo;Current for Sale Data&rdquo; — e.g. 2025 closings stored there still go to <span className="font-semibold text-white">Sales Data</span>. A file with no Close Date column is an active listing (Current Listings) even if the folder says &ldquo;Sale&rdquo;.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={sendMisfitsToRightSection}
                disabled={processing}
                className="flex-1 px-4 py-3 rounded-xl text-sm font-bold bg-cyan-500 hover:bg-cyan-400 disabled:bg-gray-600 text-black transition-colors"
              >
                Upload in {categorySectionName(sectionMisfits[0].category)} →
              </button>
              <button
                onClick={uploadMisfitsHere}
                disabled={processing}
                className="flex-1 px-4 py-3 rounded-xl text-sm font-semibold bg-white/10 hover:bg-white/20 disabled:bg-gray-600 text-white transition-colors"
              >
                Upload here anyway
              </button>
              <button
                onClick={dismissMisfits}
                className="px-4 py-3 rounded-xl text-sm font-medium text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* "What did you actually upload?" — CENTERED modal (the old corner card
          was too small to read), one full block per document: name, year,
          rows, complete Updated/New zip chips and skip/error explanations. */}
      {uploadReport && uploadReport.length > 0 && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/70">
          <div className="bg-surface border border-emerald-500/40 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-border-subtle shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-base font-bold text-white leading-tight">What you&apos;re uploading</p>
                  <p className="text-[11px] text-gray-400">
                    Staged — visible on the map after &ldquo;Add All&rdquo;.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setUploadReport(null)}
                className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white shrink-0"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-5 space-y-3">
              {/* Skipped files — same place as the uploaded ones so the user
                  sees everything that happened to the folder in one glance. */}
              {uploadSummary && uploadSummary.skippedFiles.length > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
                  <p className="text-xs font-semibold text-amber-200 mb-1.5">
                    Skipped files ({uploadSummary.skippedFiles.length})
                  </p>
                  <ul className="space-y-1">
                    {uploadSummary.skippedFiles.slice(0, 20).map((f, i) => (
                      <li key={i} className="text-[11px] leading-snug text-amber-200/90 break-all">
                        {f.message}
                      </li>
                    ))}
                    {uploadSummary.skippedFiles.length > 20 && (
                      <li className="text-[11px] text-amber-200/70">
                        +{uploadSummary.skippedFiles.length - 20} more file(s) skipped.
                      </li>
                    )}
                  </ul>
                </div>
              )}
              {uploadReport.map((r, idx) => {
                const expanded = reportExpanded.has(idx);
                return (
                  <div key={idx} className="bg-background border border-border-subtle rounded-xl px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white break-all">{r.fileName}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {r.categoryLabel}
                          {r.datasetYear ? ` · ${r.datasetYear}` : ''}
                          {r.rowsStaged > 0 &&
                            ` · ${r.rowsStaged.toLocaleString()} ${r.isGeo ? 'areas' : 'rows'}`}
                          {r.rowsSkipped > 0 && ` · ${r.rowsSkipped.toLocaleString()} skipped`}
                        </p>
                      </div>
                      <button
                        onClick={() =>
                          setReportExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(idx)) next.delete(idx);
                            else next.add(idx);
                            return next;
                          })
                        }
                        className="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white shrink-0"
                        aria-label={expanded ? 'Hide details' : 'View details'}
                        title={expanded ? 'Hide details' : 'View details'}
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="mt-2 text-xs leading-relaxed space-y-1">
                      {r.error ? (
                        r.alreadyInDb > 0 ? (
                          <p className="text-amber-300">
                            Already in the database — nothing changed.
                          </p>
                        ) : (
                          <p className="text-red-300">Failed: {r.error}</p>
                        )
                      ) : (
                        <>
                          {r.updated.length > 0 && (
                            <p>
                              <span className="text-amber-300 font-semibold">Updated:</span>{' '}
                              <span className="text-white">
                                {r.updated.slice(0, 12).map((z) => z.name).join(', ')}
                                {r.updated.length > 12 ? `, +${r.updated.length - 12} more` : ''}
                              </span>
                              <span className="text-gray-500"> ({r.updated.length} ZIPs)</span>
                            </p>
                          )}
                          {r.added.length > 0 && (
                            <p>
                              <span className="text-emerald-400 font-semibold">New:</span>{' '}
                              <span className="text-white">
                                {r.added.slice(0, 12).map((z) => z.name).join(', ')}
                                {r.added.length > 12 ? `, +${r.added.length - 12} more` : ''}
                              </span>
                              <span className="text-gray-500"> ({r.added.length} ZIPs)</span>
                            </p>
                          )}
                          {r.updated.length === 0 && r.added.length === 0 && r.fallbackZips.length > 0 && (
                            <p>
                              <span className="text-gray-400">ZIPs covered: </span>
                              <span className="text-white">{r.fallbackZips.slice(0, 12).map((z) => z.name).join(', ')}</span>
                            </p>
                          )}
                          {r.updated.length === 0 && r.added.length === 0 && r.fallbackZips.length === 0 && (
                            <p className="text-gray-400">
                              {r.isGeo
                                ? `${r.rowsStaged.toLocaleString()} new areas`
                                : `${r.rowsStaged.toLocaleString()} rows uploaded`}
                            </p>
                          )}
                        </>
                      )}
                    </div>

                    {expanded && <UploadDetailContent r={r} />}
                  </div>
                );
              })}
            </div>

            <div className="px-5 py-3.5 border-t border-border-subtle shrink-0">
              <p className="text-[11px] text-amber-300/80">
                Remember to clear cache in Dashboard if the map looks stale.
              </p>
              <div className="flex gap-2 mt-2.5">
                <button
                  onClick={() => {
                    setUploadReport(null);
                    window.location.href = '/map';
                  }}
                  className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold bg-white/10 hover:bg-white/20 text-white transition-colors"
                >
                  View on map →
                </button>
                <button
                  onClick={() => setUploadReport(null)}
                  className="flex-1 px-4 py-2.5 rounded-xl text-sm font-bold bg-emerald-500 hover:bg-emerald-400 text-black transition-colors"
                >
                  Got it
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <DatasetRebuildBanner />
    </div>
  );
}
