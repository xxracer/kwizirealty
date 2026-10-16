/**
 * computeGate.ts — single-flight + concurrency cap for the map's heavy
 * /api/query computations (owner: the public map must never choke).
 *
 * THE PROBLEM (measured 2026-10-15): one aggregate takes ~8s alone; with 6-10
 * concurrent visitors each running their own the Postgres queue pushes every
 * op past the 30s Data Connect timeout → the fast path fails → everyone
 * falls to the 200k-row legacy path → DOUBLE timeouts → 500s → the map's
 * auto-retry adds MORE load. A death spiral under exactly the traffic the
 * public map wants.
 *
 * THE FIX here:
 *  - SINGLE-FLIGHT: concurrent requests with the SAME canonical key (same
 *    view) share ONE computation — N visitors pay one compute.
 *  - SEMAPHORE: at most MAX_CONCURRENT=2 heavy computations run at once; the
 *    rest queue FIFO (their users see the loading popup; the result then
 *    lands for everyone).
 *  - Failures do NOT wedge the gate: every slot releases in finally.
 */

const MAX_CONCURRENT = 8;
/** How long a request may WAIT for a compute slot before serving the last
 *  completed result for that key instead (~45s). The OWNER'S rule: the map
 *  must never sit "pending" for minutes — under load it serves the existing
 *  data immediately and the fresh compute lands behind it. */
const WAIT_DEADLINE_MS = 45_000;

interface GateEntry {
  waiters: Array<() => void>;
  active: number;
}

function stateFor(map: Map<string, GateEntry>, key: string): GateEntry {
  const found = map.get(key);
  if (found) return found;
  const fresh: GateEntry = { waiters: [], active: 0 };
  map.set(key, fresh);
  return fresh;
}

const inflight = new Map<string, Promise<unknown>>();
/** The last COMPLETED result per key — served instantly when the compute
 *  slots are saturated (stale-while-revalidate; zero wait for the public). */
const lastResults = new Map<string, unknown>();
interface Waiter { fn: () => void; cancelled: boolean }
const gate = { waiters: [] as Waiter[], active: 0 };

/** Await one shared slot; up to MAX_CONCURRENT compute concurrently. */
function acquire(): { promise: Promise<void>; cancel: () => void } {
  if (gate.active < MAX_CONCURRENT) {
    gate.active++;
    return { promise: Promise.resolve(), cancel: () => {} };
  }
  let cancelled = false;
  const promise = new Promise<void>((resolve) => {
    gate.waiters.push({
      fn: () => {
        if (!cancelled) {
          // Handing off an active slot from the releasing task — do not increment active again
          resolve();
        }
      },
      cancelled: false,
    });
  });
  return {
    promise,
    // SLOT-LEAK FIX (2026-10-15): a waiter that lost the wait-race must leave
    // the queue — otherwise its ghost consumed a slot later and the gate sat
    // permanently at MAX_CONCURRENT (the "everything is busy" 500/503 storm).
    cancel: () => {
      cancelled = true;
    },
  };
}

function release(): void {
  while (gate.waiters.length) {
    const w = gate.waiters.shift()!;
    if (!w.cancelled) {
      w.fn();
      return;
    }
  }
  if (gate.active > 0) gate.active--;
}

/**
 * STALE-WHILE-REVALIDATE COMPUTE for the map's heavy work:
 *  1. same-key concurrent callers share ONE computation (single-flight),
 *  2. at most MAX_CONCURRENT run at once,
 *  3. a caller who waited WAIT_DEADLINE_MS without a slot gets the LAST
 *     completed result for its key immediately (and the running compute
 *     serves the next caller), or a busy flag when there is nothing to serve.
 */
export async function runHeavyComputeStale<T>(
  key: string,
  fn: () => Promise<T>
): Promise<{ ok: boolean; value?: T; stale?: T; staleServed?: boolean }> {
  const running = inflight.get(key);
  if (running) return { ok: true, value: (await running) as T };

  const slot = acquire();
  const acquired = await Promise.race([
    slot.promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), WAIT_DEADLINE_MS)),
  ]);
  if (!acquired) {
    slot.cancel(); // the ghost waiter leaves the queue — no slot leak
  }
  if (!acquired) {
    // Slots saturated: never wait longer — serve the last good result.
    const last = lastResults.get(key);
    if (last !== undefined) return { ok: true, stale: last as T, staleServed: true };
    return { ok: false };
  }
  const runningNow = inflight.get(key);
  if (runningNow) {
    release(); // another caller took this compute while we waited
    return { ok: true, value: (await runningNow) as T };
  }
  const compute = (async () => fn())();
  inflight.set(key, compute);
  try {
    const value = await compute;
    lastResults.set(key, value);
    if (lastResults.size > 24) {
      const first = lastResults.keys().next().value as string | undefined;
      if (first !== undefined) lastResults.delete(first);
    }
    return { ok: true, value };
  } finally {
    inflight.delete(key);
    release();
  }
}

/**
 * Run `fn` for `key`: one shared computation for all same-key callers, and a
 * global cap of MAX_CONCURRENT heavy runs. The returned value is shared but
 * the response may be per-caller (pass a builder if you need per-request
 * headers; for identical responses just reuse the object).
 */
export async function runHeavyCompute<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const compute = (async () => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  })();

  inflight.set(key, compute);
  compute
    .catch(() => {})
    .finally(() => {
      setTimeout(() => {
        if (inflight.get(key) === compute) inflight.delete(key);
      }, 50);
    });
  return compute;
}