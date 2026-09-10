'use client';

/**
 * useWorkerAggregates — React binding for the aggregation worker.
 *
 * Keeps the LAST GOOD aggregate result while a new job runs, exposes an
 * `updating` pill flag, and flips `workerUnavailable` when the worker cannot
 * be created or crashes — the page then falls back to the synchronous engine
 * memos (identical numbers, just back on the main thread).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { engineWorkerClient } from '@/lib/engineWorker/client';
import type {
  AggregateResult,
  ChatStatsResult,
  DataSourcePlan,
  DatasetUniqueValues,
} from '@/lib/engineWorker/protocol';
import type { BoundaryKey, MetricKey, PropertyFilters, TeaScoreMap, MetricOverrideLite, PropertyOverrideLite } from '@/lib/engineCore';

export interface WorkerAggregates {
  /** Last successfully computed aggregate (null until the first one lands). */
  result: AggregateResult | null;
  /** True while a newer request is still computing. */
  updating: boolean;
  /** True when the worker cannot run — page must fall back to sync memos. */
  workerUnavailable: boolean;
  datasetCount: number | null;
  uniqueValues: DatasetUniqueValues | null;
  loadDataset: (
    plan: DataSourcePlan,
    schoolScores: TeaScoreMap,
    propertyOverrides: PropertyOverrideLite[]
  ) => Promise<boolean>;
  /** Same as loadDataset but forces the worker to re-fetch even if a dataset
   *  was already loaded (used by the version watchdog after a CMS rebuild). */
  reloadDataset: (
    plan: DataSourcePlan,
    schoolScores: TeaScoreMap,
    propertyOverrides: PropertyOverrideLite[]
  ) => Promise<boolean>;
  requestAggregate: (
    boundary: BoundaryKey,
    metric: MetricKey,
    filters: PropertyFilters,
    cmsOverrides: MetricOverrideLite[],
    selectedIds: string[]
  ) => void;
  /** Text search over the worker's dataset (ids matching the query). */
  search: (boundary: BoundaryKey, query: string) => Promise<string[] | null>;
  /** One-shot chat stats (area preview or filter preview). */
  chatStats: (
    boundary: BoundaryKey,
    filters: PropertyFilters,
    ids?: string[],
    marketType?: 'sale' | 'rental'
  ) => Promise<ChatStatsResult | null>;
  supersede: () => void;
}

export function useWorkerAggregates(): WorkerAggregates {
  const [result, setResult] = useState<AggregateResult | null>(null);
  const [updating, setUpdating] = useState(false);
  const [workerUnavailable, setWorkerUnavailable] = useState(engineWorkerClient.unavailable);
  const [datasetCount, setDatasetCount] = useState<number | null>(null);
  const [uniqueValues, setUniqueValues] = useState<DatasetUniqueValues | null>(null);

  // Monotonic request counter: only the newest request is allowed to write
  // state (stale responses from superseded jobs are dropped).
  const requestSeq = useRef(0);
  const inFlight = useRef(false);
  const pending = useRef<{
    boundary: BoundaryKey;
    metric: MetricKey;
    filters: PropertyFilters;
    cmsOverrides: MetricOverrideLite[];
    selectedIds: string[];
  } | null>(null);

  useEffect(() => {
    const unsubscribe = engineWorkerClient.onUnavailable(() => setWorkerUnavailable(true));
    return unsubscribe;
  }, []);

  const doLoad = useCallback(
    async (
      force: boolean,
      plan: DataSourcePlan,
      schoolScores: TeaScoreMap,
      propertyOverrides: PropertyOverrideLite[]
    ): Promise<boolean> => {
      try {
        const offProgress = engineWorkerClient.onProgress((loaded, total) => {
          window.dispatchEvent(
            new CustomEvent('kwizi:worker-load-progress', { detail: { loaded, total } })
          );
        });
        const res = force
          ? await engineWorkerClient.reloadDataset(plan, schoolScores, propertyOverrides)
          : await engineWorkerClient.loadDataset(plan, schoolScores, propertyOverrides);
        offProgress();
        setDatasetCount(res.count);
        setUniqueValues(res.uniqueValues);
        return true;
      } catch (err) {
        console.warn('[Kwizi Map] worker load failed — falling back to engine', err);
        setWorkerUnavailable(true);
        return false;
      }
    },
    []
  );

  const loadDataset = useCallback(
    (plan: DataSourcePlan, schoolScores: TeaScoreMap, propertyOverrides: PropertyOverrideLite[]) =>
      doLoad(false, plan, schoolScores, propertyOverrides),
    [doLoad]
  );

  const reloadDataset = useCallback(
    (plan: DataSourcePlan, schoolScores: TeaScoreMap, propertyOverrides: PropertyOverrideLite[]) =>
      doLoad(true, plan, schoolScores, propertyOverrides),
    [doLoad]
  );

  const drain = useCallback(() => {
    const next = pending.current;
    if (!next || inFlight.current) return;
    if (engineWorkerClient.unavailable) return;
    inFlight.current = true;
    setUpdating(true);
    const seq = ++requestSeq.current;
    engineWorkerClient
      .aggregate(next.boundary, next.metric, next.filters, next.cmsOverrides, next.selectedIds)
      .then((agg) => {
        if (seq === requestSeq.current && agg) {
          setResult(agg);
        }
      })
      .finally(() => {
        inFlight.current = false;
        setUpdating(false);
        if (pending.current) {
          pending.current = null;
          drain();
        }
      });
    pending.current = null;
  }, []);

  const requestAggregate = useCallback(
    (
      boundary: BoundaryKey,
      metric: MetricKey,
      filters: PropertyFilters,
      cmsOverrides: MetricOverrideLite[],
      selectedIds: string[]
    ) => {
      if (engineWorkerClient.unavailable) return;
      // Coalesce bursts into the newest request only.
      pending.current = { boundary, metric, filters, cmsOverrides, selectedIds };
      if (inFlight.current) {
        // The running job is now stale; let the worker know so it can skip.
        engineWorkerClient.supersede();
        return;
      }
      drain();
    },
    [drain]
  );

  const supersede = useCallback(() => {
    requestSeq.current++;
    engineWorkerClient.supersede();
  }, []);

  const search = useCallback(
    (boundary: BoundaryKey, query: string) => engineWorkerClient.search(boundary, query),
    []
  );

  const chatStats = useCallback(
    (
      boundary: BoundaryKey,
      filters: PropertyFilters,
      ids?: string[],
      marketType?: 'sale' | 'rental'
    ) => engineWorkerClient.chatStats(boundary, filters, ids, marketType),
    []
  );

  return {
    result,
    updating,
    workerUnavailable,
    datasetCount,
    uniqueValues,
    loadDataset,
    reloadDataset,
    requestAggregate,
    search,
    chatStats,
    supersede,
  };
}