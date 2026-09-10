'use client';

/**
 * Automatic CMS ↔ dataset reconciliation.
 *
 * The published dataset lives in Storage (manifest + chunks) and the source
 * CSVs live in the CMS. Uploads and deletes normally trigger a rebuild, but
 * if one ever fails (old code, closed tab, network drop), the published
 * dataset silently drifts away from what the CMS actually contains and
 * NOTHING re-triggers it — visitors keep loading stale rows forever.
 *
 * This module closes that hole: on admin mount it lists the CSVs currently
 * in Storage and compares them against the source list stamped into the
 * manifest. Any mismatch fires a zero-delta rebuild, which recomputes the
 * whole dataset from the current CMS contents — including publishing an
 * EMPTY dataset when every CSV was deleted. No buttons, no manual steps.
 */

import { ref, getDownloadURL, listAll } from 'firebase/storage';
import { storage } from '../firebase';
import { getDatasetRebuildState, requestDatasetRebuild } from './client';

const MANIFEST_PATH = 'cms_files/csv/master_cache_chunks.json';
const CSV_LIST_ROOT = 'cms_files/csv';
// Must stay in sync with rebuildWorker.ts — these are engine artifacts, not
// source data.
const SKIP_PATTERN = /(master_cache|property-manifest|chunk_area_index|^boundary_|^master_cache_chunk_)/i;

async function listAllRecursive(
  dirRef: ReturnType<typeof ref>
): Promise<{ name: string; fullPath: string }[]> {
  const res = await listAll(dirRef);
  const items = res.items.map((i) => ({ name: i.name, fullPath: i.fullPath }));
  for (const prefix of res.prefixes) {
    items.push(...(await listAllRecursive(prefix)));
  }
  return items;
}

interface ManifestWithSources {
  version?: number;
  totalRows?: number;
  sources?: string[];
}

async function fetchManifest(): Promise<ManifestWithSources | null> {
  try {
    const url = await getDownloadURL(ref(storage, MANIFEST_PATH));
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as ManifestWithSources;
  } catch {
    return null;
  }
}

/**
 * Compares the live CMS CSV list with the manifest's consumed sources and
 * fires a rebuild when they diverge. Safe to call on every admin mount:
 * when everything matches it is two cheap Storage reads and no rebuild.
 */
export async function reconcileDatasetWithCms(): Promise<void> {
  if (typeof window === 'undefined') return;
  // A rebuild already running (or about to run) will consume the current
  // CMS state on its own — reconciling now would only duplicate work.
  if (getDatasetRebuildState().active) return;

  let csvPaths: string[] = [];
  try {
    const allItems = await listAllRecursive(ref(storage, CSV_LIST_ROOT));
    csvPaths = allItems
      .filter(
        (item) =>
          item.name.toLowerCase().endsWith('.csv') &&
          !SKIP_PATTERN.test(item.name) &&
          !item.name.toLowerCase().startsWith('tea_')
      )
      .map((i) => i.fullPath)
      .sort();
  } catch (err) {
    console.warn('[datasetRebuild] Reconcile: could not list CMS files.', err);
    return;
  }

  const manifest = await fetchManifest();

  // No manifest at all: dataset was never built (or was cleared). Rebuild
  // only when there is something to build from — an empty CMS needs no data.
  if (!manifest) {
    if (csvPaths.length > 0) {
      console.log('[datasetRebuild] Reconcile: CSVs exist but no dataset is published — rebuilding.');
      requestDatasetRebuild({});
    }
    return;
  }

  if (!Array.isArray(manifest.sources)) {
    // Legacy manifest without a source stamp: fall back to the coarse rule —
    // rebuild only when "CMS emptiness" and "dataset emptiness" disagree
    // (e.g. every CSV was deleted but the old dataset is still published).
    const datasetHasRows = (manifest.totalRows ?? 0) > 0;
    if ((csvPaths.length === 0) !== !datasetHasRows) {
      console.log(
        `[datasetRebuild] Reconcile: CMS has ${csvPaths.length} CSVs but the published dataset has ${manifest.totalRows ?? 0} rows — rebuilding.`
      );
      requestDatasetRebuild({});
    }
    return;
  }

  const manifestSources = [...manifest.sources].sort();
  const inSync =
    manifestSources.length === csvPaths.length &&
    manifestSources.every((p, i) => p === csvPaths[i]);
  if (!inSync) {
    console.log(
      `[datasetRebuild] Reconcile: published dataset was built from ${manifestSources.length} CSVs but the CMS now holds ${csvPaths.length} — rebuilding.`
    );
    requestDatasetRebuild({});
  }
}