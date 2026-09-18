/**
 * teaScores — server-side TEA school score maps for the ETA metrics.
 *
 * The client engine loads TEA rating CSVs (static Storage files + CMS uploads)
 * into per-level name→score maps. /api/query needs the same maps so metrics
 * like "Elem ETA Score" work without any client-side rows. This module builds
 * them on first use and caches the result in module memory (10 min TTL), so
 * repeated queries never re-download the CSVs.
 *
 * Missing files (e.g. TEA CSVs not yet re-uploaded) yield empty maps — the
 * metrics simply score 0 instead of erroring, mirroring the client fallback.
 */
import Papa from 'papaparse';
import { getAdminFirestore, getAdminStorageBucket } from '@/lib/firebaseAdmin';
import { cleanSchoolName, type TeaScoreMap } from '@/lib/engineCore';

const TTL_MS = 10 * 60 * 1000;

const TEA_FILES: Record<'elementary' | 'middle' | 'high', string> = {
  elementary: 'cms_files/csv/TEA_Elem_School_Ratings.csv',
  middle: 'cms_files/csv/TEA_Middle_School_Ratings.csv',
  high: 'cms_files/csv/TEA_High_School_Ratings.csv',
};

const SCHOOL_CATEGORY: Record<'elementary' | 'middle' | 'high', string> = {
  elementary: 'school-elementary',
  middle: 'school-middle',
  high: 'school-high',
};

const FILES_STORE = 'cms_files';

/** Same merge rule as engine.loadSchoolRatings: max score wins per key. */
function mergeRows(map: Record<string, number>, rows: Record<string, unknown>[]) {
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
}

function parseCsv(text: string): Record<string, unknown>[] {
  const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true });
  return (parsed.data || []) as Record<string, unknown>[];
}

async function loadStorageCsv(path: string): Promise<string> {
  const [contents] = await getAdminStorageBucket().file(path).download();
  return contents.toString('utf8');
}

async function loadCmsSchoolRows(level: 'elementary' | 'middle' | 'high'): Promise<Record<string, unknown>[]> {
  const snap = await getAdminFirestore()
    .collection(FILES_STORE)
    .where('category', '==', SCHOOL_CATEGORY[level])
    .get();
  const rows: Record<string, unknown>[] = [];
  await Promise.all(
    snap.docs.map(async (d) => {
      const storageUrl = (d.data() as { storageUrl?: string }).storageUrl;
      if (!storageUrl) return;
      try {
        const res = await fetch(storageUrl, { cache: 'no-store' });
        if (!res.ok) return;
        rows.push(...parseCsv(await res.text()));
      } catch {
        // A single unreadable upload must not break the metric.
      }
    })
  );
  return rows;
}

let cache: { at: number; maps: TeaScoreMap } | null = null;
let loading: Promise<TeaScoreMap> | null = null;

async function buildMaps(): Promise<TeaScoreMap> {
  const maps: TeaScoreMap = { elementary: {}, middle: {}, high: {} };
  const levels = ['elementary', 'middle', 'high'] as const;
  await Promise.all(
    levels.map(async (level) => {
      // Static TEA files in Storage (may not exist — empty map is fine).
      try {
        const text = await loadStorageCsv(TEA_FILES[level]);
        mergeRows(maps[level], parseCsv(text));
      } catch {
        // File missing/unreadable → fall through to CMS uploads only.
      }
      // CMS-uploaded school rating files overlay the static scores.
      try {
        mergeRows(maps[level], await loadCmsSchoolRows(level));
      } catch (err) {
        console.error('[teaScores] CMS school rows failed for', level, err);
      }
    })
  );
  return maps;
}

export async function getTeaScoreMaps(): Promise<TeaScoreMap> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.maps;
  if (!loading) {
    loading = buildMaps()
      .then((maps) => {
        cache = { at: Date.now(), maps };
        return maps;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}