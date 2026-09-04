'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, GripVertical, ArrowUp, ArrowDown, Activity, Clock, TrendingUp, BarChart3, Building, Ruler, Home } from 'lucide-react';
import type { MetricKey, BoundaryKey } from '@/lib/engine';
import {
  QuickStatsCard,
  MarketHealthCard,
  TimeSeriesCard,
  ForecastCard,
  YearBuiltCard,
  TopAreasCard,
  ForecastComparisonCard,
  type MarketHealth,
  type Forecast,
  type ForecastRow,
  type ReportStats,
} from './report/ReportCards';

export type WindowType =
  | 'quick-stats'
  | 'market-health'
  | 'time-series'
  | 'forecast'
  | 'year-built'
  | 'top-areas'
  | 'forecast-comparison';

interface WindowDef {
  key: WindowType;
  title: string;
  icon: React.ReactNode;
  defaultWidth: number;
  color: string;
}

export const WINDOW_DEFS: WindowDef[] = [
  { key: 'quick-stats', title: 'Quick Stats', icon: <Activity className="w-4 h-4" />, defaultWidth: 280, color: 'text-blue-400' },
  { key: 'market-health', title: 'Market Health', icon: <Activity className="w-4 h-4" />, defaultWidth: 280, color: 'text-pink-400' },
  { key: 'time-series', title: 'Time Series', icon: <Clock className="w-4 h-4" />, defaultWidth: 340, color: 'text-cyan-400' },
  { key: 'forecast', title: '5-Year Forecast', icon: <TrendingUp className="w-4 h-4" />, defaultWidth: 340, color: 'text-emerald-400' },
  { key: 'year-built', title: 'Year Built', icon: <Building className="w-4 h-4" />, defaultWidth: 320, color: 'text-cyan-400' },
  { key: 'top-areas', title: 'Top Areas', icon: <BarChart3 className="w-4 h-4" />, defaultWidth: 320, color: 'text-amber-400' },
  { key: 'forecast-comparison', title: 'Forecast Comparison', icon: <Ruler className="w-4 h-4" />, defaultWidth: 380, color: 'text-purple-400' },
];

const STORAGE_KEY = 'kwizi-map-windows';

interface DraggableMapWindowsProps {
  metric: MetricKey;
  metricLabel: string;
  reportStats: ReportStats;
  marketHealth: MarketHealth | null;
  timeSeries: { period: string; value: number; n: number }[];
  forecast: Forecast | null;
  forecastComparison: ForecastRow[];
  chartData: { name: string; value: number }[];
  yearBuiltData: { name: string; value: number }[];
  boundary: BoundaryKey;
  active: WindowType[];
  visible?: boolean;
  isLoading?: boolean;
  onClose?: (key: WindowType) => void;
  period?: string;
  onSetPeriod?: (p: string) => void;
}

export function useDraggableWindows() {
  const [active, setActive] = useState<WindowType[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
      if (Array.isArray(saved) && saved.every((k: unknown) => WINDOW_DEFS.some((d) => d.key === k))) {
        setActive(saved.slice(0, 3));
      }
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(active));
  }, [active, hydrated]);

  return { active, setActive };
}

export default function DraggableMapWindows({
  metric,
  metricLabel,
  reportStats,
  marketHealth,
  timeSeries,
  forecast,
  forecastComparison,
  chartData,
  yearBuiltData,
  boundary,
  active,
  visible = true,
  isLoading,
  onClose,
  period,
  onSetPeriod,
}: DraggableMapWindowsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [constraints, setConstraints] = useState({ left: 0, top: 0, right: 0, bottom: 0 });

  useEffect(() => {
    const updateConstraints = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // Keep the window's top-left handle visible; allow it to slide but stay on screen.
      setConstraints({
        left: -rect.left + 8,
        top: -rect.top + 8,
        right: rect.width - 80,
        bottom: rect.height - 80,
      });
    };
    updateConstraints();
    window.addEventListener('resize', updateConstraints);
    return () => window.removeEventListener('resize', updateConstraints);
  }, []);

  const ordered = useMemo(
    () => active.slice(0, 3).map((key) => WINDOW_DEFS.find((d) => d.key === key)!).filter(Boolean),
    [active]
  );

  const initialPosition = (index: number) => {
    const defs = [
      { left: '2%', top: '2%' },
      { right: '2%', top: '2%' },
      { left: '2%', bottom: '2%' },
    ];
    return defs[index] || { left: '2%', top: '2%' };
  };

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none z-[700]">
      <AnimatePresence>
        {visible && ordered.map((def, index) => (
          <motion.div
            key={def.key}
            drag
            dragMomentum={false}
            dragConstraints={constraints}
            dragElastic={0.05}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.25, delay: index * 0.08 }}
            className="absolute pointer-events-auto rounded-2xl flex flex-col"
            style={{ width: def.defaultWidth, maxWidth: 'min(90vw, 380px)', maxHeight: 'min(55vh, 420px)', overflow: 'hidden', ...initialPosition(index) }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerMove={(e) => {
              if (e.buttons > 0) e.stopPropagation();
            }}
            onWheel={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
          >
            <div className="relative">
              {/* floating close button */}
              {onClose && (
                <button
                  onClick={() => onClose(def.key)}
                  title="Close window"
                  className="absolute -top-2 -right-2 z-10 w-6 h-6 rounded-full bg-rose-500 text-white shadow-lg flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}

              {def.key === 'quick-stats' && (
                <QuickStatsCard
                  stats={reportStats}
                  isLoading={isLoading}
                  compact
                  dragHandle={<div className="p-1 rounded bg-white/5 text-gray-500 cursor-move"><GripVertical className="w-3.5 h-3.5" /></div>}
                />
              )}
              {def.key === 'market-health' && (
                <MarketHealthCard
                  marketHealth={marketHealth}
                  timeSeries={timeSeries}
                  isLoading={isLoading}
                  compact
                  period={period}
                  onSetPeriod={onSetPeriod}
                  dragHandle={<div className="p-1 rounded bg-white/5 text-gray-500 cursor-move"><GripVertical className="w-3.5 h-3.5" /></div>}
                />
              )}
              {def.key === 'time-series' && (
                <TimeSeriesCard
                  metric={metric}
                  metricLabel={metricLabel}
                  timeSeries={timeSeries}
                  isLoading={isLoading}
                  compact
                  dragHandle={<div className="p-1 rounded bg-white/5 text-gray-500 cursor-move"><GripVertical className="w-3.5 h-3.5" /></div>}
                />
              )}
              {def.key === 'forecast' && (
                <ForecastCard
                  metric={metric}
                  metricLabel={metricLabel}
                  timeSeries={timeSeries}
                  forecast={forecast}
                  isLoading={isLoading}
                  compact
                  dragHandle={<div className="p-1 rounded bg-white/5 text-gray-500 cursor-move"><GripVertical className="w-3.5 h-3.5" /></div>}
                />
              )}
              {def.key === 'year-built' && (
                <YearBuiltCard
                  yearBuiltData={yearBuiltData}
                  isLoading={isLoading}
                  compact
                  dragHandle={<div className="p-1 rounded bg-white/5 text-gray-500 cursor-move"><GripVertical className="w-3.5 h-3.5" /></div>}
                />
              )}
              {def.key === 'top-areas' && (
                <TopAreasCard
                  metric={metric}
                  chartData={chartData}
                  isLoading={isLoading}
                  compact
                  dragHandle={<div className="p-1 rounded bg-white/5 text-gray-500 cursor-move"><GripVertical className="w-3.5 h-3.5" /></div>}
                />
              )}
              {def.key === 'forecast-comparison' && (
                <ForecastComparisonCard
                  metric={metric}
                  forecastComparison={forecastComparison}
                  boundary={boundary}
                  isLoading={isLoading}
                  compact
                  dragHandle={<div className="p-1 rounded bg-white/5 text-gray-500 cursor-move"><GripVertical className="w-3.5 h-3.5" /></div>}
                />
              )}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function WindowSelector({
  active,
  onChange,
}: {
  active: WindowType[];
  onChange: (next: WindowType[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const toggle = (key: WindowType) => {
    if (active.includes(key)) {
      onChange(active.filter((k) => k !== key));
    } else if (active.length < 3) {
      onChange([...active, key]);
    }
  };

  const move = (key: WindowType, dir: -1 | 1) => {
    const idx = active.indexOf(key);
    if (idx < 0) return;
    const next = idx + dir;
    if (next < 0 || next >= active.length) return;
    const arr = [...active];
    [arr[idx], arr[next]] = [arr[next], arr[idx]];
    onChange(arr);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-9 h-9 rounded-lg border shadow bg-[#121620] border-white/[0.06] text-gray-300 hover:bg-[#1f2937] flex items-center justify-center transition-colors"
        title="Floating report windows"
        data-tour="map-windows"
      >
        <BarChart3 className="w-4 h-4" />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-2 w-72 bg-[#121620] border border-white/[0.06] rounded-2xl shadow-2xl p-4 z-[700]">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Floating windows (max 3)</div>
            <div className="text-[10px] text-gray-500">{active.length}/3 active</div>
          </div>
          <div className="grid grid-cols-2 gap-2 max-h-80 overflow-y-auto pr-0.5">
            {WINDOW_DEFS.map((def) => {
              const checked = active.includes(def.key);
              const disabled = !checked && active.length >= 3;
              const idx = active.indexOf(def.key);
              return (
                <button
                  key={def.key}
                  onClick={() => toggle(def.key)}
                  disabled={disabled}
                  className={`
                    relative text-left p-2.5 rounded-xl border transition-all
                    ${checked ? 'bg-white/10 border-white/20' : 'bg-black/30 border-white/[0.06] hover:bg-white/5'}
                    ${disabled ? 'opacity-40 cursor-not-allowed' : ''}
                  `}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      readOnly
                      className="rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500 disabled:opacity-40"
                    />
                    <div className={`w-6 h-6 rounded-lg bg-white/5 flex items-center justify-center ${def.color}`}>{def.icon}</div>
                    <span className="text-[10px] font-semibold text-gray-300">{def.title}</span>
                  </div>
                  {checked && active.length > 1 && (
                    <div className="flex items-center justify-end gap-0.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); move(def.key, -1); }}
                        disabled={idx === 0}
                        className="p-1 rounded hover:bg-white/10 disabled:opacity-30 text-gray-400"
                      >
                        <ArrowUp className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); move(def.key, 1); }}
                        disabled={idx === active.length - 1}
                        className="p-1 rounded hover:bg-white/10 disabled:opacity-30 text-gray-400"
                      >
                        <ArrowDown className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
