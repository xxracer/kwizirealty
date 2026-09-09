'use client';

/**
 * Floating status card for the automatic dataset rebuild that runs after a
 * CSV upload/delete in the CMS. Shows only a spinner + phase text — never
 * numeric progress. Success fades out by itself; errors offer a retry.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import {
  getDatasetRebuildState,
  retryDatasetRebuild,
  subscribeDatasetRebuild,
  type DatasetRebuildState,
} from '@/lib/datasetRebuild/client';

const DONE_VISIBLE_MS = 8000;

export default function DatasetRebuildBanner() {
  const [state, setState] = useState<DatasetRebuildState>(() => getDatasetRebuildState());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const unsub = subscribeDatasetRebuild(() => setState(getDatasetRebuildState()));
    setState(getDatasetRebuildState());
    return unsub;
  }, []);

  // Tick while a finished rebuild is still visible so it can auto-hide.
  useEffect(() => {
    if (state.phase !== 'done') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);

  const doneAge = state.doneAt ? now - state.doneAt : Infinity;
  const visible = state.active || state.phase === 'error' || (state.phase === 'done' && doneAge < DONE_VISIBLE_MS);
  if (!visible) return null;

  if (state.phase === 'error') {
    return (
      <div className="fixed bottom-6 left-6 z-[9999] max-w-sm bg-[#1a1215] border border-red-500/30 rounded-xl shadow-2xl px-5 py-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-white">Could not update the dataset</p>
            <p className="text-xs text-gray-400 mt-1 break-words">{state.error}</p>
            <button
              onClick={() => retryDatasetRebuild()}
              className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === 'done') {
    return (
      <div className="fixed bottom-6 left-6 z-[9999] bg-[#0f1a14] border border-emerald-500/30 rounded-xl shadow-2xl px-5 py-4 flex items-center gap-3">
        <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
        <p className="text-sm font-medium text-white">{state.message}</p>
      </div>
    );
  }

  return (
    <div className="fixed bottom-6 left-6 z-[9999] bg-[#10141d] border border-blue-500/25 rounded-xl shadow-2xl px-5 py-4 flex items-center gap-3">
      <Loader2 className="w-5 h-5 animate-spin text-blue-400 shrink-0" />
      <div>
        <p className="text-sm font-bold text-white">Updating map data</p>
        <p className="text-xs text-gray-400 mt-0.5">{state.message || 'Preparing data update…'}</p>
      </div>
    </div>
  );
}