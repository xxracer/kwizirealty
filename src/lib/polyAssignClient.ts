/**
 * polyAssignClient — browser driver for the polygon assignment job.
 *
 * Loops POST /api/sql/assign-poly (one page for one class per call) until
 * the route reports the class done, accumulating the audit (per-polygon
 * counts/medians) locally. Resumable by design: every call carries its
 * cursor, so an interrupted run just continues.
 */
import type { PolyAssignClass } from '@/lib/boundaryFiles';

export interface PolyAssignProgress {
  classKey: string;
  assigned: number;
}

export interface PolyAssignAudit {
  classKey: PolyAssignClass;
  assigned: number;
  unassigned: number;
  distinctPoly: number;
  perPoly: { name: string; count: number; median: number | null }[];
}

interface PageResponse {
  pagesDone?: number;
  assigned?: number;
  nextCursor?: { m: string; y: number } | null;
  perPoly?: Record<string, { count: number; prices: number[] }>;
  error?: string;
  detail?: string;
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 !== 0 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100;
}

async function assignOneClass(
  cls: PolyAssignClass,
  onlyUnassigned: boolean,
  onProgress: ((p: PolyAssignProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<PolyAssignAudit> {
  // Server-side tallies for the audit — filled progressively while paging.
  let assigned = 0;
  const perPoly: Record<string, { count: number; prices: number[] }> = {};
  let cursor: { m: string; y: number } | null = null;
  let guard = 0;

  for (;;) {
    if (signal?.aborted) throw new Error('assign-poly cancelled');
    // Hard ceiling only (echo-stall detection is the equality check below);
    // 2000 pages ≈ 10M rows — a class bigger than that is a different bug.
    if (cursor && ++guard > 2000) throw new Error('assign-poly exceeded the page ceiling');
    const res = await fetch('/api/sql/assign-poly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ class: cls, cursor, onlyUnassigned }),
      signal,
    });
    const body = (await res.json().catch(() => null)) as PageResponse | null;
    if (!res.ok || !body) {
      throw new Error(body?.detail || body?.error || `assign-poly HTTP ${res.status}`);
    }
    if (body.nextCursor && cursor
      && body.nextCursor.m === cursor.m && Number(body.nextCursor.y) === Number(cursor.y)) {
      throw new Error('assign-poly made no progress (cursor echo)');
    }
    assigned += body.assigned ?? 0;
    for (const [name, agg] of Object.entries(body.perPoly ?? {})) {
      const all = (perPoly[name] ?? (perPoly[name] = { count: 0, prices: [] }));
      all.count += agg.count;
      if (agg.prices.length) all.prices.push(...agg.prices);
    }
    onProgress?.({ classKey: cls, assigned });
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }

  // Rows NOT covered for this class: live rows with coords minus assigned
  // (unassigned = no coordinates or outside every polygon of the class).
  // The per-column counters come from the server-side polyAssignmentStatus
  // probe (NO_ACCESS op — only the route can call it).
  let unassigned = 0;
  try {
    const res = await fetch('/api/sql/assign-poly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ class: cls, status: true }),
      signal,
    });
    const body = (await res.json().catch(() => null)) as
      | { status?: Record<string, number> | null }
      | null;
    const status = body?.status ?? null;
    if (status) {
      const colKey = {
        subdivisions: 'assigned_subdivisions',
        zipcodes: 'assigned_zipcodes',
        highschools: 'assigned_highschools',
        elementary: 'assigned_elementary',
        middle: 'assigned_middle',
      }[cls];
      const withCoords = Number(status['with_coords'] ?? 0);
      const assignedNow = Number(status[colKey] ?? 0);
      unassigned = Math.max(0, withCoords - assignedNow);
    }
  } catch {
    // The audit still shows assigned/tallies; the missing unassigned value
    // is non-fatal (the report footer just shows 0).
  }
  return {
    classKey: cls,
    assigned,
    unassigned,
    distinctPoly: Object.keys(perPoly).length,
    perPoly: Object.entries(perPoly)
      .map(([name, a]) => ({ name, count: a.count, median: median(a.prices) }))
      .sort((a, b) => b.count - a.count),
  };
}

export async function runPolyAssignment(
  classes: readonly PolyAssignClass[],
  opts: {
    onlyUnassigned?: boolean;
    onProgress?: (p: PolyAssignProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<PolyAssignAudit[]> {
  const { onlyUnassigned = true, onProgress, signal } = opts;
  const audits: PolyAssignAudit[] = [];
  for (const cls of classes) {
    audits.push(await assignOneClass(cls, onlyUnassigned, onProgress, signal));
  }
  return audits;
}