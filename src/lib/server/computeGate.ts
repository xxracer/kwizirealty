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

const MAX_CONCURRENT = 2;

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
const gate: GateEntry = { waiters: [], active: 0 };

/** Await one shared slot; up to MAX_CONCURRENT compute concurrently. */
function acquire(): Promise<void> {
  if (gate.active < MAX_CONCURRENT) {
    gate.active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    gate.waiters.push(() => {
      gate.active++;
      resolve();
    });
  });
}

function release(): void {
  const next = gate.waiters.shift();
  if (next) next();
  else if (gate.active > 0) gate.active--;
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