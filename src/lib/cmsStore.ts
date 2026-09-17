'use client';

import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, writeBatch, query as fsQuery, where } from 'firebase/firestore';
import { ref, uploadString, uploadBytes, getDownloadURL, deleteObject, listAll, getMetadata, type StorageReference } from 'firebase/storage';
import { db, storage } from './firebase';
import type { BoundaryKey, MetricKey } from './engine';
import Papa from 'papaparse';

export type CMSFileCategory =
  | 'property'
  | 'sales'
  | 'rent'
  | 'current-sale'
  | 'current-rent'
  | 'tax'
  | 'school-elementary'
  | 'school-middle'
  | 'school-high'
  | 'boundary'
  | 'custom-area';

export interface CMSFileRecord {
  id: string;
  name: string;
  size: number;
  category: CMSFileCategory;
  rows: Record<string, string>[];
  headers: string[];
  uploadedAt: number;
  source: 'upload' | 'manual';
  storageUrl?: string;
  storagePath?: string;
  rowCount?: number;
  rawContent?: string;
}

export interface CMSMetricOverride {
  id: string;
  boundary: BoundaryKey;
  boundaryId: string;
  metric: MetricKey;
  value: number;
  note?: string;
  updatedAt: number;
}

export interface CMSPropertyOverride {
  id: string;
  mlsNumber: string;
  address: string;
  zip: string;
  fields: Record<string, string>;
  updatedAt: number;
  source: 'manual';
  mode?: 'edit' | 'create';
}

export interface CMSStoreSummary {
  files: number;
  rows: number;
  overrides: number;
  propertyOverrides: number;
  lastUploadAt: number | null;
}

const FILES_STORE = 'cms_files';
const OVERRIDES_STORE = 'cms_overrides';
const PROPERTY_OVERRIDES_STORE = 'cms_property_overrides';
// Single-flag marker: once any boundary GeoJSON is managed through the CMS,
// the CMS is the authority for polygons — an empty CMS list then means
// "deleted everywhere", while a never-initialized project keeps serving the
// bundled /geojson copies.
const BOUNDARY_META_STORE = 'cms_meta';
const BOUNDARY_META_DOC = 'boundaries';

const listeners = new Set<() => void>();

/**
 * Categories whose rows feed the map dataset (boundary-chunked cache).
 * Tax/school CSVs are dropped by the normalizer (no lat/lng) and boundary
 * geojson goes live immediately, so none of those trigger a rebuild.
 */
const DATASET_CATEGORIES = new Set<CMSFileCategory>(['property', 'sales', 'rent', 'current-sale', 'current-rent']);

/**
 * Fires the automatic dataset rebuild in the admin's browser. Dynamic import
 * keeps the rebuild code (and its worker chunk) out of every page that
 * imports cmsStore. Deltas accumulate in the client singleton, so several
 * saves/deletes in a row produce ONE sequential rebuild — never parallel
 * heavy jobs (memory care).
 */
function triggerDatasetRebuild(delta: { addedRows?: number; removedRows?: number } = {}) {
  void import('./datasetRebuild/client')
    .then((m) => m.requestDatasetRebuild(delta))
    .catch(() => {});
}

/** Files that live in Storage only as engine caches — never shown as uploads. */
const STORAGE_SKIP_PATTERN = /(master_cache|property-manifest|manifest|chunk|\.gz$)/i;

/** Detect the CMS category of a Storage file from its path/name. */
function detectStorageCategory(name: string, fallback?: CMSFileCategory): CMSFileCategory {
  const lower = name.toLowerCase();
  if (lower.endsWith('.geojson')) {
    // GeoJSON always feeds the map's boundary layers — the map only reads
    // 'boundary' metadata, so a 'custom-area' geojson (the old classification,
    // e.g. "Mapped Subdivisions.geojson") was invisible to it and left the map
    // serving the bundled local polygons instead.
    return 'boundary';
  }
  if (lower.includes('tax')) return 'tax';
  if (lower.includes('school') || lower.includes('tea')) {
    if (lower.includes('elem')) return 'school-elementary';
    if (lower.includes('middle')) return 'school-middle';
    if (lower.includes('high')) return 'school-high';
    return 'school-elementary';
  }
  if (lower.includes('current')) {
    if (lower.includes('rent')) return 'current-rent';
    if (lower.includes('sale')) return 'current-sale';
  }
  if (lower.includes('rent')) return 'rent';
  if (lower.includes('sale') || lower.includes('sold')) return 'sales';
  // Generic displayGrid filenames from the data provider carry no category clue.
  // Do NOT fall back to the shared 'property' bucket — that makes them appear
  // in every property-data section. Only tag them when a fallback is provided
  // from the active admin section.
  if (fallback) return fallback;
  return 'property';
}

function emit() {
  listeners.forEach((fn) => fn());
}

function rowsToCsv(headers: string[], rows: Record<string, string>[]): string {
  const escapeCell = (v: unknown) => {
    const s = String(v ?? '').replace(/"/g, '""');
    return `"${s}"`;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(','))].join('\n');
}

export const cmsStore = {
  async init(): Promise<void> {
    return Promise.resolve();
  },

  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  /** True once any boundary GeoJSON has been managed through the CMS. */
  async isBoundaryAuthority(): Promise<boolean> {
    try {
      const snap = await getDoc(doc(db, BOUNDARY_META_STORE, BOUNDARY_META_DOC));
      if (!snap.exists()) return false;
      return (snap.data() as { authoritative?: boolean }).authoritative === true;
    } catch {
      return false;
    }
  },

  async markBoundaryAuthority(): Promise<void> {
    try {
      await setDoc(
        doc(db, BOUNDARY_META_STORE, BOUNDARY_META_DOC),
        { authoritative: true, at: Date.now() },
        { merge: true }
      );
    } catch (err) {
      console.warn('[CMS Store] Could not mark boundary authority:', err);
    }
  },

  async saveFile(record: CMSFileRecord): Promise<void> {
    const fileContent = record.rawContent || rowsToCsv(record.headers, record.rows);
    
    // Create organized storage path preserving original folders
    const cleanName = record.name.replace(/[^a-zA-Z0-9.\-_ /]/g, '');
    // CSV uploads must live under cms_files/csv/ — the dataset rebuild
    // (build-cache-from-cms.js) lists that folder recursively, so a CSV at
    // the cms_files/ root would silently never reach the map. Boundaries and
    // other geojson keep their root location (resolved via metadata URLs).
    const isCsvUpload =
      cleanName.toLowerCase().endsWith('.csv') &&
      record.category !== 'boundary' &&
      record.category !== 'custom-area';
    const storagePath =
      isCsvUpload && !cleanName.startsWith('csv/')
        ? `cms_files/csv/${cleanName}`
        : `cms_files/${cleanName}`;
    const storageRef = ref(storage, storagePath);
    
    // GeoJSON uploads are gzipped in the browser: a 44MB FeatureCollection
    // (e.g. Mapped Subdivisions) transfers as ~1MB, and every geojson consumer
    // reads CMS storage URLs through fetchJsonAutoGz (which sniffs gzip).
    const isGeoUpload = record.category === 'boundary' || record.category === 'custom-area';
    let blob: Blob;
    if (isGeoUpload && typeof CompressionStream !== 'undefined') {
      const gzipped = new Blob([fileContent]).stream().pipeThrough(new CompressionStream('gzip'));
      blob = new Blob([await new Response(gzipped).arrayBuffer()], { type: 'application/gzip' });
    } else {
      blob = new Blob([fileContent], { type: isGeoUpload ? 'application/geo+json' : 'text/csv' });
    }
    await uploadBytes(storageRef, blob);
    const downloadUrl = await getDownloadURL(storageRef);

    const { rows, rawContent, ...recordWithoutRows } = record;
    const metadata = {
      ...recordWithoutRows,
      storageUrl: downloadUrl,
      storagePath: storagePath,
      rowCount: record.category === 'boundary' ? 0 : rows.length,
    };

    await setDoc(doc(db, FILES_STORE, record.id), metadata);
    // From the first boundary upload on, the CMS decides which polygons exist.
    if (record.category === 'boundary') await this.markBoundaryAuthority();
    emit();

    // Auto-rebuild: this CSV feeds the map dataset, so its rows go live once
    // the worker finishes. For a replace flow the following removeFile of the
    // old file adds its removedRows to the same coalesced rebuild.
    if (isCsvUpload && DATASET_CATEGORIES.has(record.category)) {
      triggerDatasetRebuild({ addedRows: record.rows.length });
    } else if (isCsvUpload && record.category === 'tax') {
      // Tax CSVs reach the map through the rebuild's MLS merge and add zero
      // property rows, so the safety-gate delta stays at zero.
      triggerDatasetRebuild({});
    }
  },

  async removeFile(id: string): Promise<void> {
    let removedRowCount = 0;
    let removedCategory: CMSFileCategory | null = null;
    try {
      const docSnap = await getDoc(doc(db, FILES_STORE, id));
      if (docSnap.exists()) {
        const metadata = docSnap.data() as CMSFileRecord;
        removedRowCount = metadata.rowCount || 0;
        removedCategory = metadata.category;
        const pathToDelete = metadata.storagePath || `cms_files/${id}.csv`;
        // Two files with the same name share ONE storage object (the path is
        // the file name). A replace flow saves the new file first and then
        // removes the old doc — deleting the shared path here would destroy
        // the NEW upload's bytes. Skip the storage delete whenever another
        // metadata doc still references the same path.
        let sharedPath = false;
        try {
          const dupSnap = await getDocs(
            fsQuery(collection(db, FILES_STORE), where('storagePath', '==', pathToDelete))
          );
          sharedPath = dupSnap.docs.some((d) => d.id !== id);
        } catch {
          sharedPath = true; // fail-safe: never delete when the check fails
        }
        if (!sharedPath) {
          const storageRef = ref(storage, pathToDelete);
          await deleteObject(storageRef);
        }
      }
    } catch (e) {
      console.warn("Could not delete from storage, it might not exist.", e);
    }
    await deleteDoc(doc(db, FILES_STORE, id));
    emit();

    if (removedCategory && DATASET_CATEGORIES.has(removedCategory)) {
      triggerDatasetRebuild({ removedRows: removedRowCount });
    } else if (removedCategory === 'tax') {
      // Removing a tax source only drops the merged tax fields (no property
      // rows disappear), so the rebuild runs with a zero delta.
      triggerDatasetRebuild({});
    }
  },

  async getFile(id: string): Promise<CMSFileRecord | undefined> {
    const docSnap = await getDoc(doc(db, FILES_STORE, id));
    if (!docSnap.exists()) return undefined;
    
    const metadata = docSnap.data() as Omit<CMSFileRecord, 'rows'>;
    
    let rows: Record<string, string>[] = [];
    if (metadata.storageUrl) {
      try {
        const response = await fetch(metadata.storageUrl);
        const csvText = await response.text();
        const parsed = Papa.parse<Record<string, string>>(csvText, {
          header: true,
          skipEmptyLines: true,
        });
        rows = parsed.data;
      } catch (err) {
        console.error("Failed to download CSV for file:", metadata.id, err);
      }
    }
    
    return { ...metadata, rows } as CMSFileRecord;
  },

  async listFiles(): Promise<CMSFileRecord[]> {
    const querySnapshot = await getDocs(collection(db, FILES_STORE));
    const metadatas = querySnapshot.docs.map(d => d.data() as Omit<CMSFileRecord, 'rows'>);
    
    const fullFiles = await Promise.all(metadatas.map(async (metadata) => {
      let rows: Record<string, string>[] = [];
      if (metadata.storageUrl) {
        try {
          const response = await fetch(metadata.storageUrl);
          const csvText = await response.text();
          const parsed = Papa.parse<Record<string, string>>(csvText, {
            header: true,
            skipEmptyLines: true,
          });
          rows = parsed.data;
        } catch (err) {
          console.error("Failed to download CSV for file:", metadata.id, err);
        }
      }
      return { ...metadata, rows } as CMSFileRecord;
    }));

    return fullFiles.sort((a, b) => b.uploadedAt - a.uploadedAt);
  },

  async listFilesByCategory(category: CMSFileCategory): Promise<CMSFileRecord[]> {
    const all = await this.listFiles();
    return all.filter((f) => f.category === category);
  },

  async listFilesMetadata(): Promise<Omit<CMSFileRecord, 'rows'>[]> {
    const querySnapshot = await getDocs(collection(db, FILES_STORE));
    return querySnapshot.docs.map(d => d.data() as Omit<CMSFileRecord, 'rows'>).sort((a, b) => b.uploadedAt - a.uploadedAt);
  },

  async listFilesMetadataByCategory(category: CMSFileCategory): Promise<Omit<CMSFileRecord, 'rows'>[]> {
    const all = await this.listFilesMetadata();
    return all.filter((f) => f.category === category);
  },

  /**
   * Discover files that already exist in Firebase Storage under `cms_files/`
   * but have no metadata document in Firestore (e.g. uploaded outside the CMS)
   * and register them so they appear in the admin file lists. Idempotent —
   * files that already have metadata (matched by storagePath or doc id) are skipped.
   *
   * Fast path: only lists Storage objects and writes metadata (no downloads),
   * so the file list appears immediately. Row counts are then filled in
   * gradually in the background (see countRowsInBackground).
   */
  async importExistingStorageFiles(options: { fallbackCategory?: CMSFileCategory } = {}): Promise<{
    imported: Omit<CMSFileRecord, 'rows'>[];
    skipped: number;
  }> {
    // Recursively list every object under cms_files/
    const items: StorageReference[] = [];
    const walk = async (dir: StorageReference): Promise<void> => {
      const res = await listAll(dir);
      items.push(...res.items);
      for (const prefix of res.prefixes) await walk(prefix);
    };
    await walk(ref(storage, 'cms_files'));

    const existingSnap = await getDocs(collection(db, FILES_STORE));
    const knownPaths = new Set<string>();
    const knownIds = new Set<string>();
    existingSnap.docs.forEach((d) => {
      knownIds.add(d.id);
      const p = (d.data() as { storagePath?: string }).storagePath;
      if (p) knownPaths.add(p);
    });

    const imported: Omit<CMSFileRecord, 'rows'>[] = [];
    let skipped = 0;

    for (const item of items) {
      const storagePath = item.fullPath;
      const name = storagePath.replace(/^cms_files\//, '');
      const docId = storagePath.replace(/\//g, '__');

      if (STORAGE_SKIP_PATTERN.test(name) || knownPaths.has(storagePath) || knownIds.has(docId)) {
        skipped += 1;
        continue;
      }

      try {
        const [downloadUrl, meta] = await Promise.all([getDownloadURL(item), getMetadata(item)]);
        const metadata: Omit<CMSFileRecord, 'rows'> = {
          id: docId,
          name,
          size: Number(meta.size) || 0,
          category: detectStorageCategory(name, options.fallbackCategory),
          headers: [],
          uploadedAt: Date.parse(meta.timeCreated) || Date.now(),
          source: 'manual',
          storageUrl: downloadUrl,
          storagePath,
          rowCount: 0,
        };
        imported.push(metadata);
      } catch (err) {
        console.warn('[CMS Store] Could not import storage file:', storagePath, err);
        skipped += 1;
      }
    }

    if (imported.length > 0) {
      const batch = writeBatch(db);
      imported.forEach((m) => batch.set(doc(db, FILES_STORE, m.id), m));
      if (imported.some((m) => m.category === 'boundary')) {
        batch.set(
          doc(db, BOUNDARY_META_STORE, BOUNDARY_META_DOC),
          { authoritative: true, at: Date.now() },
          { merge: true }
        );
      }
      await batch.commit();
      emit();

      // Fill in row counts / headers without blocking the UI.
      void this.countRowsInBackground(imported);
    }

    return { imported, skipped };
  },

  /**
   * Background pass that downloads each registered CSV (one at a time, small
   * files only) to compute rowCount + headers, updating the metadata doc.
   */
  async countRowsInBackground(files: Omit<CMSFileRecord, 'rows'>[]): Promise<void> {
    for (const metadata of files) {
      const name = metadata.name.toLowerCase();
      const isCsv = name.endsWith('.csv');
      const isGeo = metadata.category === 'boundary' || metadata.category === 'custom-area';
      if (!isCsv || isGeo || metadata.size > 30 * 1024 * 1024) continue;
      try {
        const response = await fetch(metadata.storageUrl || '');
        const csvText = await response.text();
        const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true });
        const rowCount = parsed.data.length;
        const headers = parsed.data.length > 0 ? Object.keys(parsed.data[0]) : [];
        await setDoc(doc(db, FILES_STORE, metadata.id), { rowCount, headers }, { merge: true });
        emit();
      } catch (err) {
        console.warn('[CMS Store] Background row count failed for:', metadata.name, err);
      }
    }
  },

  /**
   * Delete all files whose category belongs to `categories`. If omitted,
   * deletes every file in the CMS (legacy global behaviour).
   */
  async clearFiles(categories?: CMSFileCategory[]): Promise<void> {
    const querySnapshot = await getDocs(collection(db, FILES_STORE));
    const batch = writeBatch(db);
    let removedRows = 0;
    querySnapshot.docs.forEach((docSnap) => {
      const data = docSnap.data() as CMSFileRecord;
      if (categories && !categories.includes(data.category)) return;
      if (DATASET_CATEGORIES.has(data.category)) removedRows += data.rowCount || 0;
      batch.delete(docSnap.ref);
      // Files live at their descriptive storagePath (e.g. cms_files/csv/<name>.csv),
      // not at cms_files/<docId>.csv — deleting the doc-id path silently no-ops.
      try {
        const pathToDelete = data.storagePath || `cms_files/${docSnap.id}.csv`;
        deleteObject(ref(storage, pathToDelete)).catch(() => {});
      } catch (e) {}
    });
    await batch.commit();
    emit();
    if (removedRows > 0) triggerDatasetRebuild({ removedRows });
  },

  async saveOverride(override: CMSMetricOverride): Promise<void> {
    await setDoc(doc(db, OVERRIDES_STORE, override.id), override);
    emit();
  },

  async removeOverride(id: string): Promise<void> {
    await deleteDoc(doc(db, OVERRIDES_STORE, id));
    emit();
  },

  async listOverrides(): Promise<CMSMetricOverride[]> {
    const querySnapshot = await getDocs(collection(db, OVERRIDES_STORE));
    const all = querySnapshot.docs.map(d => d.data() as CMSMetricOverride);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async clearOverrides(): Promise<void> {
    const querySnapshot = await getDocs(collection(db, OVERRIDES_STORE));
    const batch = writeBatch(db);
    querySnapshot.docs.forEach((docSnap) => {
      batch.delete(docSnap.ref);
    });
    await batch.commit();
    emit();
  },

  async getAllUploadedRows(): Promise<Record<string, string>[]> {
    const metadatas = await this.listFilesMetadata();
    const rows: Record<string, string>[] = [];
    for (const metadata of metadatas) {
      if (metadata.storageUrl && metadata.category !== 'boundary') {
        try {
          const response = await fetch(metadata.storageUrl);
          const csvText = await response.text();
          const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true });
          rows.push(...parsed.data);
        } catch (err) {}
      }
    }
    return rows;
  },

  async getUploadedRowsByCategories(categories: CMSFileCategory[]): Promise<Record<string, string>[]> {
    const metadatas = await this.listFilesMetadata();
    const filtered = metadatas.filter((f) => categories.includes(f.category));
    const rows: Record<string, string>[] = [];
    for (const metadata of filtered) {
      if (metadata.storageUrl) {
        try {
          const response = await fetch(metadata.storageUrl);
          const csvText = await response.text();
          const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true });
          rows.push(...parsed.data);
        } catch (err) {}
      }
    }
    return rows;
  },

  async getUploadedSchoolRows(level: 'elementary' | 'middle' | 'high'): Promise<Record<string, string>[]> {
    const map: Record<typeof level, CMSFileCategory> = {
      elementary: 'school-elementary',
      middle: 'school-middle',
      high: 'school-high',
    };
    return this.getUploadedRowsByCategories([map[level]]);
  },

  async savePropertyOverride(override: CMSPropertyOverride): Promise<void> {
    await setDoc(doc(db, PROPERTY_OVERRIDES_STORE, override.id), override);
    emit();
  },

  async removePropertyOverride(id: string): Promise<void> {
    await deleteDoc(doc(db, PROPERTY_OVERRIDES_STORE, id));
    emit();
  },

  async listPropertyOverrides(): Promise<CMSPropertyOverride[]> {
    const querySnapshot = await getDocs(collection(db, PROPERTY_OVERRIDES_STORE));
    const all = querySnapshot.docs.map(d => d.data() as CMSPropertyOverride);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async getAllPropertyOverrideRows(): Promise<Record<string, string>[]> {
    const overrides = await this.listPropertyOverrides();
    return overrides.map((o) => o.fields);
  },

  async clearPropertyOverrides(): Promise<void> {
    const querySnapshot = await getDocs(collection(db, PROPERTY_OVERRIDES_STORE));
    const batch = writeBatch(db);
    querySnapshot.docs.forEach((docSnap) => {
      batch.delete(docSnap.ref);
    });
    await batch.commit();
    emit();
  },

  async summary(): Promise<CMSStoreSummary> {
    const [filesSnap, overridesSnap, propertyOverridesSnap] = await Promise.all([
      getDocs(collection(db, FILES_STORE)),
      getDocs(collection(db, OVERRIDES_STORE)),
      getDocs(collection(db, PROPERTY_OVERRIDES_STORE)),
    ]);
    
    const overrides = overridesSnap.docs.length;
    const propertyOverrides = propertyOverridesSnap.docs.length;
    
    let rows = 0;
    let lastUploadAt: number | null = null;
    
    filesSnap.docs.forEach((d) => {
      const data = d.data() as Omit<CMSFileRecord, 'rows'>;
      rows += (data.rowCount || 0);
      if (lastUploadAt === null || data.uploadedAt > lastUploadAt) {
        lastUploadAt = data.uploadedAt;
      }
    });
    
    return {
      files: filesSnap.docs.length,
      rows,
      overrides,
      propertyOverrides,
      lastUploadAt,
    };
  },

  buildStaticBundle(files: CMSFileRecord[]): { name: string; csv: string }[] {
    return files.map((f) => {
      const csv = [
        f.headers.join(','),
        ...f.rows.map((row) => f.headers.map((h) => `"${(row[h] ?? '').replace(/"/g, '""')}"`).join(',')),
      ].join('\n');
      return { name: f.name, csv };
    });
  },

  async saveMasterCache(cache: { data: any[]; signature: string }): Promise<void> {
    const json = JSON.stringify(cache);
    const blob = new Blob([json], { type: 'application/json' });
    const storageRef = ref(storage, 'cms_files/master_cache.json');
    await uploadBytes(storageRef, blob);
  },

  async loadMasterCache(): Promise<any | null> {
    try {
      const storageRef = ref(storage, `master_cache/master_cache.json`);
      const downloadUrl = await getDownloadURL(storageRef);
      const response = await fetch(downloadUrl);
      if (!response.ok) return null;
      return await response.json();
    } catch (err) {
      console.warn('[CMS Store] No master cache found or failed to load:', err);
      return null;
    }
  },

  /**
   * Merge `newFeatures` into an existing custom-area GeoJSON file, replacing
   * any features that share a normalized name. When `newFeatures` is empty
   * (or `replaceAll` is true) the entire file is overwritten with the input.
   * Returns the updated FeatureCollection that was written.
   */
  async mergeCustomAreaFeatures(
    fileName: string,
    newFeatures: { type: 'Feature'; geometry: any; properties: any }[],
    options: { replaceAll?: boolean } = {}
  ): Promise<{ type: 'FeatureCollection'; features: any[] } | null> {
    const { replaceAll = false } = options;
    const safeName = fileName.replace(/[^a-zA-Z0-9.\-_ /]/g, '');
    const storagePath = `cms_files/${safeName}`;
    const storageRef = ref(storage, storagePath);

    let merged: { type: 'FeatureCollection'; features: any[] } | null = null;
    try {
      const downloadUrl = await getDownloadURL(storageRef);
      const res = await fetch(downloadUrl);
      if (res.ok) {
        const parsed = await res.json();
        if (parsed && parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
          merged = parsed;
        }
      }
    } catch {
      // File does not exist yet; will be created below.
    }

    const replaceFeatures = replaceAll ? [] : newFeatures;
    if (merged && !replaceAll) {
      const byName = new Map<string, any>();
      const norm = (f: any) => String(
        f?.properties?.name ||
          f?.properties?.NAME ||
          f?.properties?.area ||
          f?.properties?.AREA ||
          ''
      ).toUpperCase().trim();
      for (const feat of merged.features) {
        const key = norm(feat);
        if (key) byName.set(key, feat);
      }
      for (const feat of replaceFeatures) {
        const key = norm(feat);
        if (key) byName.set(key, feat);
      }
      merged.features = Array.from(byName.values());
    } else {
      merged = { type: 'FeatureCollection', features: [...replaceFeatures] };
    }

    const blob = new Blob([JSON.stringify(merged)], { type: 'application/geo+json' });
    await uploadBytes(storageRef, blob, { contentType: 'application/geo+json' });

    return merged;
  }
};
