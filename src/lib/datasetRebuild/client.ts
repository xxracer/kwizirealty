'use client';

/**
 * Client singleton that drives the dataset-rebuild worker.
 *
 * Every CSV save/delete in the CMS calls requestDatasetRebuild() with the row
 * delta it produced. Requests are COALESCED: while a rebuild is running, new
 * deltas accumulate and a single follow-up rebuild runs when the current one
 * finishes — so a bulk upload (save → save → …) or the replace flow
 * (save new file → delete old one) never spawns parallel heavy jobs, which
 * is what keeps memory pressure low.
 */

import type { RebuildPhase } from './phases';

export interface DatasetRebuildState {
  active: boolean;
  phase: 'idle' | RebuildPhase;
  message: string;
  error: string | null;
  version: number | null;
  doneAt: number | null;
}

type Listener = () => void;

let worker: Worker | null = null;
let active = false;
let pendingAdded = 0;
let pendingRemoved = 0;

// If the worker goes silent for this long (crash without an 'error' event,
// network stall, etc.) we surface an error instead of spinning forever.
const WATCHDOG_MS = 5 * 60 * 1000;
const WATCHDOG_TICK_MS = 30_000;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastWorkerActivity = 0;

// Bulk re-uploads fire one request per file. Rebuilding after each file
// would fail the safety gate (the dataset is only complete once ALL files
// are in Storage), so wait for a quiet window before starting a rebuild.
const REBUILD_DEBOUNCE_MS = 45_000;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRun() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runNow();
  }, REBUILD_DEBOUNCE_MS);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function startWatchdog() {
  stopWatchdog();
  lastWorkerActivity = Date.now();
  watchdogTimer = setInterval(() => {
    if (!active) {
      stopWatchdog();
      return;
    }
    if (Date.now() - lastWorkerActivity > WATCHDOG_MS) {
      stopWatchdog();
      active = false;
      try {
        worker?.terminate();
      } catch {}
      worker = null;
      pendingAdded = 0;
      pendingRemoved = 0;
      setState({
        active: false,
        phase: 'error',
        message: '',
        error: 'The data update timed out. You can retry.',
        doneAt: null,
      });
    }
  }, WATCHDOG_TICK_MS);
}

let state: DatasetRebuildState = {
  active: false,
  phase: 'idle',
  message: '',
  error: null,
  version: null,
  doneAt: null,
};

const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((fn) => fn());
}

function setState(patch: Partial<DatasetRebuildState>) {
  state = { ...state, ...patch };
  notify();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./rebuildWorker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as
      | { type: 'progress'; phase: RebuildPhase; message: string }
      | { type: 'done'; version: number; totalRows: number }
      | { type: 'error'; message: string };
    if (data.type === 'progress') {
      lastWorkerActivity = Date.now();
      setState({ phase: data.phase, message: data.message });
    } else if (data.type === 'done') {
      stopWatchdog();
      active = false;
      setState({
        active: false,
        phase: 'done',
        message: 'Map data updated successfully.',
        error: null,
        version: data.version,
        doneAt: Date.now(),
      });
      // Changes requested while this rebuild ran get their own rebuild.
      if (pendingAdded > 0 || pendingRemoved > 0) {
        scheduleRun();
      }
    } else if (data.type === 'error') {
      stopWatchdog();
      active = false;
      setState({
        active: false,
        phase: 'error',
        message: '',
        error: data.message,
        doneAt: null,
      });
    }
  };

  worker.onerror = () => {
    stopWatchdog();
    active = false;
    setState({
      active: false,
      phase: 'error',
      message: '',
      error: 'Could not run the data update.',
      doneAt: null,
    });
  };

  return worker;
}

function runNow() {
  if (active) return;
  active = true;
  startWatchdog();
  setState({
    active: true,
    phase: 'preparing',
    message: 'Preparing data update…',
    error: null,
    doneAt: null,
  });
  const addedRows = pendingAdded;
  const removedRows = pendingRemoved;
  pendingAdded = 0;
  pendingRemoved = 0;
  try {
    ensureWorker().postMessage({ type: 'start', addedRows, removedRows });
  } catch {
    active = false;
    setState({
      active: false,
      phase: 'error',
      message: '',
      error: 'Could not start the data update.',
      doneAt: null,
    });
  }
}

/**
 * Called by cmsStore after a CSV upload/delete. Safe to call any number of
 * times — deltas accumulate and rebuilds stay strictly sequential.
 */
export function requestDatasetRebuild(delta: { addedRows?: number; removedRows?: number } = {}) {
  if (typeof window === 'undefined') return;
  pendingAdded += delta.addedRows ?? 0;
  pendingRemoved += delta.removedRows ?? 0;
  if (active) return;
  scheduleRun();
}

/** Manual retry from the error banner (also picks up any pending deltas). */
export function retryDatasetRebuild() {
  if (typeof window === 'undefined' || active) return;
  runNow();
}

export function getDatasetRebuildState(): DatasetRebuildState {
  return state;
}

export function subscribeDatasetRebuild(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Resolves once no dataset rebuild is active and no pending deltas remain.
 * Rejects if the rebuild enters the error state. Used after uploads to
 * ensure the engine reloads the latest published data or surfaces a failure.
 */
export function waitForDatasetRebuild(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!active && pendingAdded === 0 && pendingRemoved === 0) {
      resolve();
      return;
    }
    const unsubscribe = subscribeDatasetRebuild(() => {
      const s = getDatasetRebuildState();
      if (s.phase === 'error') {
        unsubscribe();
        reject(new Error(s.error || 'Dataset update failed'));
        return;
      }
      if (!s.active && s.phase === 'done' && pendingAdded === 0 && pendingRemoved === 0) {
        unsubscribe();
        resolve();
      }
    });
  });
}