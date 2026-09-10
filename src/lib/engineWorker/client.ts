'use client';

/**
 * EngineWorkerClient — lifecycle wrapper around aggregateWorker.
 *
 * - Promise-per-job (jobId map); supersede() bumps a monotonic counter so
 *   superseded jobs resolve null instead of queueing stale work.
 * - loadDataset resolves once and is shared by every caller.
 * - Any worker construction/decoding failure flips `unavailable`, and the map
 *   page falls back to the synchronous engine path (never worse than today).
 */
import * as core from '../engineCore';
import { cacheVersionFor } from '../csvCache';
import type {
  AggregateResult,
  ChatStatsResult,
  DataSourcePlan,
  DatasetUniqueValues,
  WorkerRequest,
} from './protocol';

export interface LoadedDataset {
  count: number;
  uniqueValues: DatasetUniqueValues;
}

type PendingJob = {
  resolve: (value: AggregateResult) => void;
  reject: (reason?: unknown) => void;
};

type PendingSearch = {
  resolve: (ids: string[]) => void;
  reject: (reason?: unknown) => void;
};

type PendingChatStats = {
  resolve: (result: ChatStatsResult) => void;
  reject: (reason?: unknown) => void;
};

export class EngineWorkerClient {
  private worker: Worker | null = null;
  private loadPromise: Promise<LoadedDataset> | null = null;
  private loadedVersion: string | null = null;
  /** False while a dataset load is still in flight, true once it settles. */
  private loadSettled = false;
  private jobs = new Map<number, PendingJob>();
  private searches = new Map<number, PendingSearch>();
  private chatStatsJobs = new Map<number, PendingChatStats>();
  private jobIdCounter = 1;

  /** True when the worker could not be created or crashed fatally. */
  public unavailable = false;
  private onUnavailableCallbacks: (() => void)[] = [];
  private progressHandlers: ((loaded: number, total: number) => void)[] = [];

  public onUnavailable(cb: () => void): () => void {
    this.onUnavailableCallbacks.push(cb);
    return () => {
      this.onUnavailableCallbacks = this.onUnavailableCallbacks.filter((f) => f !== cb);
    };
  }

  public onProgress(cb: (loaded: number, total: number) => void): () => void {
    this.progressHandlers.push(cb);
    return () => {
      this.progressHandlers = this.progressHandlers.filter((f) => f !== cb);
    };
  }

  private markUnavailable() {
    if (this.unavailable) return;
    this.unavailable = true;
    this.loadPromise = null;
    this.jobs.forEach((j) => j.reject(new Error('worker unavailable')));
    this.jobs.clear();
    this.searches.forEach((s) => s.reject(new Error('worker unavailable')));
    this.searches.clear();
    this.chatStatsJobs.forEach((c) => c.reject(new Error('worker unavailable')));
    this.chatStatsJobs.clear();
    this.onUnavailableCallbacks.forEach((cb) => cb());
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (this.unavailable) return null;
    try {
      // The worker is prebundled with esbuild into public/workers/ (Turbopack's
      // production build treats `new URL('./aggregateWorker.ts', import.meta.url)`
      // as a raw asset instead of compiling it). The bundle is rebuilt from
      // source on every `npm run dev` / prebuild, so it can never go stale.
      const w = new Worker('/workers/aggregateWorker.js', { type: 'module' });
      w.onmessage = (event: MessageEvent) => this.handleMessage(event);
      w.onerror = (event) => {
        console.error('[Kwizi WorkerClient] worker error:', event.message || event);
        this.markUnavailable();
      };
      w.onmessageerror = () => {
        console.error('[Kwizi WorkerClient] message serialization error');
        this.markUnavailable();
      };
      this.worker = w;
      return w;
    } catch (err) {
      console.warn('[Kwizi WorkerClient] worker creation failed — falling back to main thread', err);
      this.markUnavailable();
      return null;
    }
  }

  private handleMessage(event: MessageEvent) {
    const msg = event.data as
      | { type: 'datasetReady'; count: number; uniqueValues: DatasetUniqueValues }
      | { type: 'datasetProgress'; loaded: number; total: number }
      | { type: 'datasetError'; message: string }
      | { type: 'result'; result: AggregateResult }
      | { type: 'searchResult'; result: { jobId: number; ids: string[] } }
      | { type: 'chatStatsResult'; result: ChatStatsResult }
      | { type: 'jobError'; jobId: number; message: string }
      | { type: 'log'; message: string };

    switch (msg.type) {
      case 'datasetReady':
        this.resolveLoad({ count: msg.count, uniqueValues: msg.uniqueValues });
        break;
      case 'datasetProgress':
        this.progressHandlers.forEach((cb) => cb(msg.loaded, msg.total));
        break;
      case 'datasetError':
        this.rejectLoad(new Error(msg.message));
        break;
      case 'result': {
        const job = this.jobs.get(msg.result.jobId);
        if (job) {
          this.jobs.delete(msg.result.jobId);
          job.resolve(msg.result);
        }
        break;
      }
      case 'searchResult': {
        const search = this.searches.get(msg.result.jobId);
        if (search) {
          this.searches.delete(msg.result.jobId);
          search.resolve(msg.result.ids);
        }
        break;
      }
      case 'chatStatsResult': {
        const chat = this.chatStatsJobs.get(msg.result.jobId);
        if (chat) {
          this.chatStatsJobs.delete(msg.result.jobId);
          chat.resolve(msg.result);
        }
        break;
      }
      case 'jobError': {
        const job = this.jobs.get(msg.jobId);
        if (job) {
          this.jobs.delete(msg.jobId);
          job.reject(new Error(msg.message));
        }
        const search = this.searches.get(msg.jobId);
        if (search) {
          this.searches.delete(msg.jobId);
          search.reject(new Error(msg.message));
        }
        const chat = this.chatStatsJobs.get(msg.jobId);
        if (chat) {
          this.chatStatsJobs.delete(msg.jobId);
          chat.reject(new Error(msg.message));
        }
        break;
      }
      case 'log':
        console.log(msg.message);
        break;
    }
  }

  private loadResolve: ((value: LoadedDataset) => void) | null = null;
  private loadReject: ((reason?: unknown) => void) | null = null;

  private resolveLoad(value: LoadedDataset) {
    const resolve = this.loadResolve;
    this.loadResolve = null;
    this.loadReject = null;
    this.loadSettled = true;
    resolve?.(value);
  }

  private rejectLoad(err: Error) {
    const reject = this.loadReject;
    this.loadResolve = null;
    this.loadReject = null;
    this.loadSettled = true;
    reject?.(err);
  }

  /** Loads the dataset into the worker (deduped; one in-flight load). */
  public async loadDataset(
    plan: DataSourcePlan,
    schoolScores: core.TeaScoreMap,
    propertyOverrides: core.PropertyOverrideLite[]
  ): Promise<LoadedDataset> {
    if (this.loadPromise) return this.loadPromise;
    const w = this.ensureWorker();
    if (!w) throw new Error('worker unavailable');
    this.loadSettled = false;

    const cacheVersionUrls = ['cms_files/csv/master_cache_chunks.json', `version:${plan.version ?? 'unknown'}`];
    const cacheVersion = await cacheVersionFor(cacheVersionUrls);

    const load = new Promise<LoadedDataset>((resolve, reject) => {
      this.loadResolve = resolve;
      this.loadReject = reject;
    });
    this.loadPromise = load;
    load
      .then(() => {
        this.loadedVersion = cacheVersion;
      })
      .catch(() => {
        this.loadPromise = null;
      });

    const request: WorkerRequest = {
      type: 'loadDataset',
      plan,
      cacheVersion,
      schoolScores,
      propertyOverrides,
    };
    w.postMessage(request);

    return load;
  }

  /** Forces a fresh dataset load (a newer CMS version was detected by the
   *  version watchdog). If a load is already in flight it joins that one
   *  instead of stomping the worker mid-load. */
  public async reloadDataset(
    plan: DataSourcePlan,
    schoolScores: core.TeaScoreMap,
    propertyOverrides: core.PropertyOverrideLite[]
  ): Promise<LoadedDataset> {
    if (this.loadPromise && !this.loadSettled) return this.loadPromise;
    this.loadPromise = null;
    this.loadedVersion = null;
    return this.loadDataset(plan, schoolScores, propertyOverrides);
  }

  /** True once the worker's dataset matches the given cache version. */
  public isDatasetReadyFor(cacheVersion: string): boolean {
    return this.loadPromise !== null && this.loadedVersion === cacheVersion;
  }

  /** Runs an aggregation job. Returns null if the worker is unavailable or the
   *  job was superseded/failed — callers keep their last good result. */
  public aggregate(
    boundary: core.BoundaryKey,
    metric: core.MetricKey,
    filters: core.PropertyFilters,
    cmsOverrides: core.MetricOverrideLite[],
    selectedIds: string[]
  ): Promise<AggregateResult | null> {
    const w = this.ensureWorker();
    if (!w || this.loadPromise === null) return Promise.resolve(null);
    const jobId = this.jobIdCounter++;
    return new Promise<AggregateResult | null>((resolve) => {
      this.jobs.set(jobId, { resolve, reject: () => resolve(null) });
      const request: WorkerRequest = {
        type: 'aggregate',
        jobId,
        boundary,
        metric,
        filters,
        cmsOverrides,
        selectedIds,
      };
      w.postMessage(request);
    });
  }

  public search(boundary: core.BoundaryKey, query: string): Promise<string[] | null> {
    const w = this.ensureWorker();
    if (!w || this.loadPromise === null) return Promise.resolve(null);
    const jobId = this.jobIdCounter++;
    return new Promise<string[] | null>((resolve) => {
      this.searches.set(jobId, { resolve, reject: () => resolve(null) });
      const request: WorkerRequest = { type: 'search', jobId, boundary, query };
      w.postMessage(request);
    });
  }

  /** One-shot chat stats query (area preview or filter preview). */
  public chatStats(
    boundary: core.BoundaryKey,
    filters: core.PropertyFilters,
    ids?: string[],
    marketType?: 'sale' | 'rental'
  ): Promise<ChatStatsResult | null> {
    const w = this.ensureWorker();
    if (!w || this.loadPromise === null) return Promise.resolve(null);
    const jobId = this.jobIdCounter++;
    return new Promise<ChatStatsResult | null>((resolve) => {
      this.chatStatsJobs.set(jobId, { resolve, reject: () => resolve(null) });
      const request: WorkerRequest = { type: 'chatStats', jobId, boundary, filters, ids, marketType };
      w.postMessage(request);
    });
  }

  /** Bumps the job counter so any in-flight aggregate result is skipped. */
  public supersede(): void {
    this.jobIdCounter++;
  }

  public terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.loadPromise = null;
  }
}

// Singleton — one worker per tab, shared by the map page.
const globalStore = typeof globalThis !== 'undefined' ? (globalThis as any) : undefined;
export const engineWorkerClient: EngineWorkerClient = globalStore?.__kwiziEngineWorkerClient || new EngineWorkerClient();
if (globalStore) globalStore.__kwiziEngineWorkerClient = engineWorkerClient;