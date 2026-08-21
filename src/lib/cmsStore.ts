'use client';

import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { ref, uploadString, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
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

const listeners = new Set<() => void>();

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

  async saveFile(record: CMSFileRecord): Promise<void> {
    const fileContent = record.rawContent || rowsToCsv(record.headers, record.rows);
    
    // Create organized storage path preserving original folders
    const cleanName = record.name.replace(/[^a-zA-Z0-9.\-_ /]/g, '');
    // If the name already has a path (from migration), use it. Otherwise, put it in root.
    const storagePath = `cms_files/${cleanName}`;
    const storageRef = ref(storage, storagePath);
    
    const uploadMetadata = { contentType: record.category === 'boundary' ? 'application/geo+json' : 'text/csv' };
    const blob = new Blob([fileContent], { type: uploadMetadata.contentType });
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
    emit();
  },

  async removeFile(id: string): Promise<void> {
    try {
      const docSnap = await getDoc(doc(db, FILES_STORE, id));
      if (docSnap.exists()) {
        const metadata = docSnap.data() as CMSFileRecord;
        const pathToDelete = metadata.storagePath || `cms_files/${id}.csv`;
        const storageRef = ref(storage, pathToDelete);
        await deleteObject(storageRef);
      }
    } catch (e) {
      console.warn("Could not delete from storage, it might not exist.", e);
    }
    await deleteDoc(doc(db, FILES_STORE, id));
    emit();
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

  async clearFiles(): Promise<void> {
    const querySnapshot = await getDocs(collection(db, FILES_STORE));
    const batch = writeBatch(db);
    querySnapshot.docs.forEach((docSnap) => {
      batch.delete(docSnap.ref);
      try {
         const storageRef = ref(storage, `cms_files/${docSnap.id}.csv`);
         deleteObject(storageRef).catch(() => {});
      } catch (e) {}
    });
    await batch.commit();
    emit();
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
