'use client';

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  Clock,
  TrendingUp,
  BarChart3,
  Ruler,
  Layers,
  Home,
  Building,
  Printer,
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
  Download,
  AlertTriangle,
  Pin,
  GripVertical,
  Info,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  LineChart,
  Line,
  ReferenceLine,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import type { MetricKey, BoundaryKey } from '@/lib/engine';

function formatMoney(num: number): string {
  if (!num || !isFinite(num)) return '$0';
  if (num >= 1e6) return '$' + (num / 1e6).toFixed(1) + 'M';
  if (num >= 1e3) return '$' + (num / 1e3).toFixed(0) + 'K';
  return '$' + num.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatNumberCompact(num: number): string {
  if (!num || !isFinite(num)) return '0';
  if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(0) + 'K';
  return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatMetricValue(metric: MetricKey, value: number): string {
  if (!isFinite(value)) return '-';
  if (metric === 'Days on Market' || metric === 'Rental Days On Market') return Math.round(value).toLocaleString() + ' d';
  if (metric === 'List-to-Sale Ratio') return value.toFixed(1) + '%';
  if (metric === 'Appreciation Rate') return value.toFixed(2) + '%';
  if (metric === 'Investor Index') return value.toFixed(0);
  if (metric === 'Rent-to-Sale Ratio') return value.toFixed(3);
  if (metric === 'Lot Size') return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (metric === 'Last Year Tax Rate') return value.toFixed(2) + '%';
  if (metric === 'Elem ETA Score' || metric === 'Middle ETA Score' || metric === 'High ETA Score') return value.toFixed(0);
  return formatMoney(value);
}

function r2Color(r2: number): string {
  if (!isFinite(r2)) return 'text-gray-400';
  if (r2 >= 0.7) return 'text-emerald-400';
  if (r2 >= 0.4) return 'text-amber-400';
  return 'text-rose-400';
}

function r2Label(r2: number): string {
  if (!isFinite(r2)) return 'No data';
  if (r2 >= 0.7) return 'Excellent fit';
  if (r2 >= 0.4) return 'Moderate fit';
  return 'Poor fit';
}

function R2Tooltip() {
  return (
    <div className="absolute bottom-full mb-2 right-0 w-56 bg-gray-900 border border-gray-700 text-gray-200 text-xs p-2.5 rounded-lg shadow-lg opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 font-normal text-left tracking-normal normal-case">
      <div className="font-semibold text-white mb-1">R² (coefficient of determination)</div>
      <p className="mb-1.5">Measures how well the forecast fits the historical data.</p>
      <ul className="space-y-0.5 text-[10px]">
        <li><span className="text-emerald-400">≥ 0.7</span> · Excellent fit</li>
        <li><span className="text-amber-400">0.4–0.7</span> · Moderate fit</li>
        <li><span className="text-rose-400">&lt; 0.4</span> · Poor fit / unreliable</li>
      </ul>
    </div>
  );
}

const PIE_COLORS = ['#2c7be5', '#00d4ff', '#7c3aed', '#f59e0b', '#10b981'];

export interface MarketHealth {
  score: number;
  label: string;
  color: string;
  dom: number | null;
  l2s: number | null;
  moi: number | null;
}

export interface Forecast {
  periods: string[];
  fitted: number[];
  forecast: number[];
  baseline: number;
  annualDelta: number;
  forecast3yr: number;
  r2: number;
  annualPct: number;
}

export interface ForecastRow {
  region: string;
  baseline: number;
  annualDelta: number;
  annualPct: number;
  r2: number;
  forecast3yr: number;
}

export interface ReportStats {
  count: number;
  avgSale: number;
  avgSqft: number;
  avgDom: number;
  totalVolume: number;
  avgList: number;
  avgLotSize: number;
}

interface CardShellProps {
  title: string;
  icon: React.ReactNode;
  iconColor?: string;
  children: React.ReactNode;
  className?: string;
  delay?: number;
  compact?: boolean;
  headerExtra?: React.ReactNode;
  dragHandle?: React.ReactNode;
  pinned?: boolean;
  onTogglePin?: () => void;
}

function CardShell({
  title,
  icon,
  iconColor = 'text-blue-400',
  children,
  className = '',
  delay = 0,
  compact = false,
  headerExtra,
  dragHandle,
  pinned,
  onTogglePin,
}: CardShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, delay, ease: 'easeOut' }}
      className={`
        relative group overflow-hidden
        bg-gradient-to-br from-[#161b26] to-[#10141d]
        border border-white/[0.08]
        rounded-2xl
        ${compact ? 'shadow-xl' : 'shadow-lg hover:shadow-2xl'}
        ${compact ? '' : 'transition-shadow duration-300'}
        print:bg-white print:border-gray-200 print:break-inside-avoid
        ${className}
      `}
    >
      {/* subtle top accent line */}
      <div className={`absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-current to-transparent opacity-40 ${iconColor}`} />
      <div className={`flex items-center justify-between ${compact ? 'px-3 py-2.5' : 'px-4 py-3.5'} border-b border-white/[0.06]`}>
        <div className="flex items-center gap-2">
          {dragHandle}
          <div className={`${compact ? 'w-6 h-6' : 'w-7 h-7'} rounded-lg bg-white/5 flex items-center justify-center ${iconColor}`}>
            {icon}
          </div>
          <h3 className={`font-bold uppercase tracking-wider text-gray-200 ${compact ? 'text-[10px]' : 'text-xs'}`}>{title}</h3>
        </div>
        <div className="flex items-center gap-2">
          {onTogglePin && <PinHandle pinned={!!pinned} onClick={onTogglePin} />}
          {headerExtra}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={`${compact ? 'w-5 h-5' : 'w-6 h-6'} rounded bg-white/5 hover:bg-white/10 flex items-center justify-center text-gray-400 hover:text-white transition-colors`}
            title={collapsed ? "Expand" : "Collapse"}
            aria-label={collapsed ? "Expand window" : "Collapse window"}
          >
            <ArrowDown className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} transition-transform ${collapsed ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>
      
      {/* Content wrapper with collapse animation */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className={compact ? 'p-3' : 'p-4'}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function SkeletonPulse({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`animate-pulse ${className}`}>{children}</div>;
}

// ---------- Quick Stats ----------

export function QuickStatsCard({
  stats,
  isLoading,
  compact = false,
  pinned,
  onTogglePin,
  headerExtra,
}: {
  stats: ReportStats;
  isLoading?: boolean;
  compact?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  headerExtra?: React.ReactNode;
  dragHandle?: React.ReactNode;
}) {
  const items = [
    { label: 'Properties', value: formatNumberCompact(stats.count), color: 'text-white' },
    { label: 'Avg Price', value: formatMoney(stats.avgSale), color: 'text-[#2c7be5]' },
    { label: '$/SqFt', value: formatMoney(stats.avgSqft), color: 'text-[#00d4ff]' },
    { label: 'Avg DOM', value: `${Math.round(stats.avgDom)}d`, color: 'text-[#a855f7]' },
  ];

  return (
    <CardShell
      title="Quick Stats"
      icon={<Activity className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
      iconColor="text-blue-400"
      compact={compact}
      pinned={pinned}
      onTogglePin={onTogglePin}
      headerExtra={headerExtra}
    >
      {isLoading ? (
        <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-4'}`}>
          {[...Array(compact ? 4 : 4)].map((_, i) => (
            <div key={i} className={`bg-white/5 rounded-xl ${compact ? 'p-2' : 'p-3'}`}>
              <div className={`bg-white/10 rounded mb-2 ${compact ? 'h-2 w-12' : 'h-3 w-16'}`} />
              <div className={`bg-white/10 rounded ${compact ? 'h-5 w-16' : 'h-7 w-20'}`} />
            </div>
          ))}
        </div>
      ) : (
        <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-4'}`}>
          {items.map((item) => (
            <div
              key={item.label}
              className={`
                relative overflow-hidden
                bg-[#0b0e14] border border-white/[0.06]
                rounded-xl
                ${compact ? 'p-2.5' : 'p-3.5'}
              `}
            >
              <span className={`block text-gray-500 uppercase font-bold ${compact ? 'text-[9px] mb-0.5' : 'text-[10px] mb-1'}`}>{item.label}</span>
              <span className={`block font-bold ${compact ? 'text-base' : 'text-xl'} ${item.color}`}>{item.value}</span>
            </div>
          ))}
          <div
            className={`
              relative overflow-hidden
              bg-gradient-to-r from-emerald-500/10 to-transparent
              border border-emerald-500/20
              rounded-xl
              ${compact ? 'col-span-2 p-2.5' : 'col-span-2 lg:col-span-4 p-3.5'}
            `}
          >
            <span className={`block text-emerald-400/80 uppercase font-bold ${compact ? 'text-[9px] mb-0.5' : 'text-[10px] mb-1'}`}>Total Volume</span>
            <span className={`block font-bold text-emerald-400 ${compact ? 'text-base' : 'text-xl'}`}>{formatMoney(stats.totalVolume)}</span>
          </div>
        </div>
      )}
    </CardShell>
  );
}

// ---------- Market Health ----------

function MarketHealthGauge({ score, label, color, compact = false }: { score: number; label: string; color: string; compact?: boolean }) {
  const radius = compact ? 48 : 70;
  const stroke = compact ? 8 : 12;
  const normalized = Math.max(0, Math.min(100, score));
  const circumference = Math.PI * radius;
  const offset = circumference - (normalized / 100) * circumference;
  return (
    <div className="flex flex-col items-center">
      <div className={compact ? 'relative w-28 h-16' : 'relative w-44 h-24'}>
        <svg viewBox={compact ? '0 0 140 80' : '0 0 180 100'} className="w-full h-full">
          <path
            d={compact ? 'M 20 70 A 50 50 0 0 1 120 70' : 'M 20 90 A 70 70 0 0 1 160 90'}
            fill="none"
            stroke="#ffffff12"
            strokeWidth={stroke}
          />
          <path
            d={compact ? 'M 20 70 A 50 50 0 0 1 120 70' : 'M 20 90 A 70 70 0 0 1 160 90'}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute bottom-0 left-0 right-0 text-center">
          <div className={`font-bold ${compact ? 'text-lg' : 'text-2xl'}`} style={{ color }}>{score.toFixed(0)}</div>
        </div>
      </div>
      <div className={`font-bold ${compact ? 'text-[10px]' : 'text-sm'}`} style={{ color }}>{label}</div>
      {!compact && (
        <div className="flex justify-between w-40 text-[10px] text-gray-500 mt-1">
          <span>Buyer&apos;s</span>
          <span>Neutral</span>
          <span>Seller&apos;s</span>
        </div>
      )}
    </div>
  );
}

export function MarketHealthCard({
  marketHealth,
  timeSeries,
  isLoading,
  compact = false,
  pinned,
  onTogglePin,
  headerExtra,
  onSet90Days,
  is90Days,
}: {
  marketHealth: MarketHealth | null;
  timeSeries: { period: string; value: number; n: number }[];
  isLoading?: boolean;
  compact?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  headerExtra?: React.ReactNode;
  dragHandle?: React.ReactNode;
  onSet90Days?: () => void;
  is90Days?: boolean;
}) {
  const volumeTrend = useMemo(() => {
    if (timeSeries.length < 2) return null;
    const first = timeSeries[0].n || 1;
    const last = timeSeries[timeSeries.length - 1].n || 0;
    const change = ((last - first) / first) * 100;
    return { change, first, last };
  }, [timeSeries]);

  return (
    <CardShell
      title="Market Health"
      icon={<Activity className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
      iconColor="text-pink-400"
      compact={compact}
      pinned={pinned}
      onTogglePin={onTogglePin}
      headerExtra={
        <>
          {onSet90Days && (
            <div className="relative flex items-center bg-white/5 border border-white/10 rounded-md overflow-hidden">
              <button
                onClick={() => { if (is90Days) onSet90Days(); }}
                className={`text-[10px] px-1.5 py-0.5 font-semibold transition-colors ${
                  !is90Days ? 'bg-blue-500/30 text-blue-300' : 'text-gray-400 hover:text-white'
                }`}
                title="Last 30 days"
              >
                30d
              </button>
              <button
                onClick={() => { if (!is90Days) onSet90Days(); }}
                className={`text-[10px] px-1.5 py-0.5 font-semibold transition-colors ${
                  is90Days ? 'bg-blue-500/30 text-blue-300' : 'text-gray-400 hover:text-white'
                }`}
                title="Last 90 days"
              >
                90d
              </button>
            </div>
          )}
          {headerExtra}
        </>
      }
    >
      {isLoading ? (
        <SkeletonPulse className={compact ? 'space-y-2' : 'space-y-3'}>
          <div className={`bg-white/10 rounded-xl mx-auto ${compact ? 'w-24 h-14' : 'w-44 h-24'}`} />
          <div className={`bg-white/10 rounded mx-auto ${compact ? 'h-3 w-24' : 'h-4 w-32'}`} />
          <div className={`space-y-2 ${compact ? '' : 'mt-2'}`}>
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex justify-between">
                <div className={`bg-white/10 rounded ${compact ? 'h-2.5 w-20' : 'h-3 w-24'}`} />
                <div className={`bg-white/10 rounded ${compact ? 'h-2.5 w-10' : 'h-3 w-12'}`} />
              </div>
            ))}
          </div>
        </SkeletonPulse>
      ) : marketHealth ? (
        <div className={compact ? 'space-y-2' : 'space-y-1'}>
          <MarketHealthGauge score={marketHealth.score} label={marketHealth.label} color={marketHealth.color} compact={compact} />
          <div className={`grid ${compact ? 'grid-cols-3 gap-1 mt-2' : 'grid-cols-2 gap-x-4 gap-y-2 mt-4'}`}>
            {marketHealth.moi !== null && (
              <div className="bg-[#0b0e14] border border-white/[0.06] rounded-lg p-2 text-center">
                <div className={`text-gray-500 uppercase font-bold ${compact ? 'text-[8px]' : 'text-[10px]'}`}>Months Inv.</div>
                <div className={`font-semibold text-white ${compact ? 'text-xs' : 'text-sm'}`}>{marketHealth.moi.toFixed(1)}</div>
              </div>
            )}
            {marketHealth.dom !== null && (
              <div className="bg-[#0b0e14] border border-white/[0.06] rounded-lg p-2 text-center">
                <div className={`text-gray-500 uppercase font-bold ${compact ? 'text-[8px]' : 'text-[10px]'}`}>Days on Mkt.</div>
                <div className={`font-semibold text-white ${compact ? 'text-xs' : 'text-sm'}`}>{marketHealth.dom.toFixed(0)}d</div>
              </div>
            )}
            {marketHealth.l2s !== null && (
              <div className="bg-[#0b0e14] border border-white/[0.06] rounded-lg p-2 text-center">
                <div className={`text-gray-500 uppercase font-bold ${compact ? 'text-[8px]' : 'text-[10px]'}`}>List/Sale %</div>
                <div className={`font-semibold text-white ${compact ? 'text-xs' : 'text-sm'}`}>{marketHealth.l2s.toFixed(1)}%</div>
              </div>
            )}
            {volumeTrend && !compact && (
              <div className="bg-[#0b0e14] border border-white/[0.06] rounded-lg p-2 text-center">
                <div className="text-gray-500 uppercase font-bold text-[10px]">Volume Trend</div>
                <div className={`font-semibold text-sm ${volumeTrend.change >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {volumeTrend.change >= 0 ? '+' : ''}{volumeTrend.change.toFixed(1)}%
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={`text-gray-500 text-center ${compact ? 'text-[10px] py-3' : 'text-xs py-4'}`}>Select one or more areas to calculate market health.</div>
      )}
    </CardShell>
  );
}

// ---------- Map Layers ----------

export function MapLayersCard({
  layerSales,
  layerRentals,
  setLayerSales,
  setLayerRentals,
  isLoading,
  compact = false,
  pinned,
  onTogglePin,
  headerExtra,
}: {
  layerSales: boolean;
  layerRentals: boolean;
  setLayerSales: (v: boolean) => void;
  setLayerRentals: (v: boolean) => void;
  isLoading?: boolean;
  compact?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  headerExtra?: React.ReactNode;
  dragHandle?: React.ReactNode;
}) {
  const buttons = [
    { icon: <Home className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />, label: 'Current Sales', active: layerSales, set: setLayerSales, color: 'emerald' },
    { icon: <Building className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />, label: 'Est. Rentals', active: layerRentals, set: setLayerRentals, color: 'orange' },
  ];

  return (
    <CardShell
      title="Map Layers"
      icon={<Layers className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
      iconColor="text-rose-400"
      compact={compact}
      pinned={pinned}
      onTogglePin={onTogglePin}
      headerExtra={headerExtra}
    >
      {isLoading ? (
        <div className="space-y-2 animate-pulse">
          {[...Array(2)].map((_, i) => (
            <div key={i} className={`w-full bg-white/10 rounded-xl ${compact ? 'h-10' : 'h-12'}`} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {buttons.map((btn) => (
            <button
              key={btn.label}
              onClick={() => btn.set(!btn.active)}
              className={`
                w-full flex items-center gap-3 px-4 rounded-xl border transition-all
                ${btn.active
                  ? `bg-${btn.color}-500/15 border-${btn.color}-500/40 text-white shadow-[0_0_16px_-6px_rgba(255,255,255,0.1)]`
                  : 'bg-black/30 border-white/[0.06] text-gray-400 hover:bg-white/5'}
                ${compact ? 'py-2.5 text-xs' : 'py-3 text-sm'}
              `}
            >
              <span className={btn.active ? `text-${btn.color}-400` : 'text-gray-400'}>{btn.icon}</span>
              <span className="font-semibold">{btn.label}</span>
            </button>
          ))}
        </div>
      )}
    </CardShell>
  );
}

// ---------- Time Series ----------

export function TimeSeriesCard({
  metric,
  metricLabel,
  timeSeries,
  isLoading,
  compact = false,
  pinned,
  onTogglePin,
  headerExtra,
}: {
  metric: MetricKey;
  metricLabel: string;
  timeSeries: { period: string; value: number; n: number }[];
  isLoading?: boolean;
  compact?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  headerExtra?: React.ReactNode;
  dragHandle?: React.ReactNode;
}) {
  return (
    <CardShell
      title="Time Series"
      icon={<Clock className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
      iconColor="text-cyan-400"
      compact={compact}
      pinned={pinned}
      onTogglePin={onTogglePin}
      headerExtra={headerExtra}
    >
      {isLoading ? (
        <div className={`w-full animate-pulse bg-white/5 rounded-xl ${compact ? 'h-40' : 'h-64'}`} />
      ) : timeSeries.length >= 3 ? (
        <div className={compact ? 'h-44 w-full' : 'h-64 w-full'}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={timeSeries}>
              <defs>
                <linearGradient id={compact ? 'tsMiniGradient' : 'tsGradient'} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2c7be5" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#2c7be5" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
              <XAxis dataKey="period" tick={{ fill: '#6b7280', fontSize: compact ? 8 : 9 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: '#6b7280', fontSize: compact ? 8 : 9 }} axisLine={false} tickLine={false} tickFormatter={(v) => formatMetricValue(metric, v)} />
              <RechartsTooltip
                contentStyle={{ backgroundColor: '#161a24', border: '1px solid #374151', borderRadius: '8px' }}
                formatter={(val: any) => [formatMetricValue(metric, Number(val)), metricLabel]}
                labelStyle={{ color: '#9ca3af' }}
              />
              <Area type="monotone" dataKey="value" stroke="#2c7be5" fill={`url(#${compact ? 'tsMiniGradient' : 'tsGradient'})`} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className={`flex flex-col items-center justify-center text-center text-gray-500 ${compact ? 'h-40 text-[10px] px-2' : 'h-64 text-xs px-3'}`}>
          <Clock className="w-5 h-5 mb-2 opacity-40" />
          {timeSeries.length === 0 ? (
            <span>Select an area to see its time series.</span>
          ) : (
            <span>Not enough periods for a trend — try a longer time range.</span>
          )}
        </div>
      )}
    </CardShell>
  );
}

// ---------- 5-Year Forecast ----------

export function ForecastCard({
  metric,
  metricLabel,
  timeSeries,
  forecast,
  isLoading,
  compact = false,
  pinned,
  onTogglePin,
  headerExtra,
}: {
  metric: MetricKey;
  metricLabel: string;
  timeSeries: { period: string; value: number; n: number }[];
  forecast: Forecast | null;
  isLoading?: boolean;
  compact?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  headerExtra?: React.ReactNode;
  dragHandle?: React.ReactNode;
}) {
  const forecastChartData = useMemo(() => {
    if (!forecast) return [];
    return forecast.periods.map((p, i) => ({
      period: p,
      fitted: isFinite(forecast.fitted[i]) ? forecast.fitted[i] : null,
      forecast: isFinite(forecast.forecast[i]) ? forecast.forecast[i] : null,
    }));
  }, [forecast]);

  return (
    <CardShell
      title="5-Year Forecast"
      icon={<TrendingUp className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
      iconColor="text-emerald-400"
      compact={compact}
      pinned={pinned}
      onTogglePin={onTogglePin}
      headerExtra={headerExtra}
    >
      {isLoading ? (
        <div className={`w-full animate-pulse bg-white/5 rounded-xl ${compact ? 'h-36 mb-2' : 'h-48 mb-3'}`} />
      ) : forecast ? (
        <>
          <div className={compact ? 'h-36 w-full' : 'h-48 w-full'}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={forecastChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                <XAxis dataKey="period" tick={{ fill: '#6b7280', fontSize: compact ? 8 : 8 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: '#6b7280', fontSize: compact ? 8 : 9 }} axisLine={false} tickLine={false} tickFormatter={(v) => formatMetricValue(metric, v)} />
                <RechartsTooltip
                  contentStyle={{ backgroundColor: '#161a24', border: '1px solid #374151', borderRadius: '8px' }}
                  formatter={(val: any, name: any) => [val != null ? formatMetricValue(metric, Number(val)) : '-', name]}
                  labelStyle={{ color: '#9ca3af' }}
                />
                <ReferenceLine x={timeSeries[timeSeries.length - 1]?.period} stroke="#ffffff40" />
                <Line type="monotone" dataKey="fitted" stroke="#2c7be5" strokeWidth={2} dot={false} name="Fitted" />
                <Line type="monotone" dataKey="forecast" stroke="#00d4ff" strokeWidth={2} strokeDasharray="5 5" dot={false} name="Forecast" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className={`grid gap-2 mt-3 ${compact ? 'grid-cols-3' : 'grid-cols-3'}`}>
            <div className="bg-[#0b0e14] border border-white/[0.06] rounded-lg p-2 text-center">
              <div className={`text-gray-500 uppercase font-bold ${compact ? 'text-[8px]' : 'text-[10px]'}`}>Baseline</div>
              <div className={`font-bold text-white ${compact ? 'text-xs' : 'text-sm'}`}>{formatMetricValue(metric, forecast.baseline)}</div>
            </div>
            <div className="bg-[#0b0e14] border border-white/[0.06] rounded-lg p-2 text-center">
              <div className={`text-gray-500 uppercase font-bold ${compact ? 'text-[8px]' : 'text-[10px]'}`}>Annual Δ</div>
              <div className={`font-bold ${forecast.annualDelta >= 0 ? 'text-emerald-400' : 'text-rose-400'} ${compact ? 'text-xs' : 'text-sm'}`}>
                {formatMetricValue(metric, forecast.annualDelta)}/yr
              </div>
            </div>
            <div className="bg-[#0b0e14] border border-white/[0.06] rounded-lg p-2 text-center">
              <div className={`text-gray-500 uppercase font-bold ${compact ? 'text-[8px]' : 'text-[10px]'}`}>3-Yr</div>
              <div className={`font-bold text-white ${compact ? 'text-xs' : 'text-sm'}`}>{formatMetricValue(metric, forecast.forecast3yr)}</div>
            </div>
          </div>
          {!compact && (
            <div className="text-center mt-2 flex items-center justify-center gap-2">
              <span className={`text-[10px] font-semibold ${r2Color(forecast.r2)}`}>
                R² = {forecast.r2.toFixed(2)} · {r2Label(forecast.r2)}
              </span>
              <div className="relative group">
                <Info className="w-3 h-3 text-gray-500 group-hover:text-white transition-colors cursor-help" />
                <R2Tooltip />
              </div>
              <span className="text-[10px] text-gray-500">· Annual % = {forecast.annualPct.toFixed(2)}%</span>
            </div>
          )}
        </>
      ) : (
        <div className={`flex flex-col items-center justify-center text-center text-gray-500 ${compact ? 'h-44 text-[10px] px-2' : 'h-64 text-xs px-3'}`}>
          <TrendingUp className="w-5 h-5 mb-2 opacity-40" />
          {timeSeries.length === 0 ? (
            <span>Select areas and a forecastable metric.</span>
          ) : timeSeries.length === 1 ? (
            <span>Only one historical point — at least 2 are needed for a forecast.</span>
          ) : (
            <span>Forecast unavailable. Try a longer time period or different metric.</span>
          )}
        </div>
      )}
    </CardShell>
  );
}

// ---------- Year Built ----------

export function YearBuiltCard({
  yearBuiltData,
  isLoading,
  compact = false,
  pinned,
  onTogglePin,
  headerExtra,
}: {
  yearBuiltData: { name: string; value: number }[];
  isLoading?: boolean;
  compact?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  headerExtra?: React.ReactNode;
  dragHandle?: React.ReactNode;
}) {
  return (
    <CardShell
      title="Year Built"
      icon={<Building className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
      iconColor="text-cyan-400"
      compact={compact}
      pinned={pinned}
      onTogglePin={onTogglePin}
      headerExtra={headerExtra}
    >
      {isLoading ? (
        <div className={`w-full animate-pulse bg-white/5 rounded-xl ${compact ? 'h-44' : 'h-64'}`} />
      ) : yearBuiltData.length ? (
        <div className={compact ? 'h-44 w-full' : 'h-64 w-full'}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={yearBuiltData}
                dataKey="value"
                nameKey="name"
                innerRadius={compact ? 45 : 60}
                outerRadius={compact ? 65 : 90}
                paddingAngle={2}
              >
                {yearBuiltData.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Legend verticalAlign="bottom" height={compact ? 16 : 24} iconType="circle" />
              <RechartsTooltip contentStyle={{ backgroundColor: '#161a24', border: '1px solid #374151', borderRadius: '8px' }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className={`flex items-center justify-center text-gray-500 ${compact ? 'h-44 text-[10px]' : 'h-64 text-xs'}`}>No year-built data available.</div>
      )}
    </CardShell>
  );
}

// ---------- Top Areas ----------

export function TopAreasCard({
  metric,
  chartData,
  isLoading,
  compact = false,
  pinned,
  onTogglePin,
  headerExtra,
}: {
  metric: MetricKey;
  chartData: { name: string; value: number }[];
  isLoading?: boolean;
  compact?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  headerExtra?: React.ReactNode;
  dragHandle?: React.ReactNode;
}) {
  return (
    <CardShell
      title="Top Areas"
      icon={<BarChart3 className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
      iconColor="text-amber-400"
      compact={compact}
      pinned={pinned}
      onTogglePin={onTogglePin}
      headerExtra={headerExtra}
    >
      {isLoading ? (
        <div className="space-y-2 animate-pulse">
          {[...Array(compact ? 3 : 5)].map((_, i) => (
            <div key={i} className={`bg-white/5 rounded-xl ${compact ? 'h-10' : 'h-14'}`} />
          ))}
        </div>
      ) : chartData.length ? (
        <div className={`space-y-2 overflow-y-auto pr-1 ${compact ? 'max-h-52' : 'max-h-80'}`}>
          {chartData.map((entry, index) => {
            const max = chartData[0].value;
            const pct = max > 0 ? (entry.value / max) * 100 : 0;
            const isTop3 = index < 3;
            return (
              <motion.div
                key={entry.name}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: index * 0.05 }}
                className={`
                  rounded-xl bg-white/[0.03] border border-white/[0.06]
                  hover:border-white/[0.12] transition-colors
                  ${compact ? 'p-2' : 'p-3'}
                `}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`shrink-0 rounded-lg flex items-center justify-center font-bold ${
                      isTop3
                        ? 'bg-gradient-to-br from-amber-400 to-orange-500 text-black'
                        : 'bg-white/10 text-gray-400'
                    } ${compact ? 'w-5 h-5 text-[10px]' : 'w-7 h-7 text-xs'}`}
                  >
                    {index + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className={`font-semibold text-white truncate pr-2 ${compact ? 'text-[10px]' : 'text-sm'}`} title={entry.name}>
                        {entry.name}
                      </span>
                      <span className={`font-bold text-blue-400 whitespace-nowrap ${compact ? 'text-[10px]' : 'text-sm'}`}>
                        {formatMetricValue(metric, entry.value)}
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.6, delay: index * 0.05 }}
                        className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400"
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      ) : (
        <div className={`flex items-center justify-center text-gray-500 ${compact ? 'h-40 text-[10px]' : 'h-64 text-xs'}`}>No data to rank.</div>
      )}
    </CardShell>
  );
}

// ---------- Forecast Comparison ----------

export function ForecastComparisonCard({
  metric,
  forecastComparison,
  boundary,
  isLoading,
  compact = false,
  pinned,
  onTogglePin,
  headerExtra,
}: {
  metric: MetricKey;
  forecastComparison: ForecastRow[];
  boundary: BoundaryKey;
  isLoading?: boolean;
  compact?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  headerExtra?: React.ReactNode;
  dragHandle?: React.ReactNode;
}) {
  const [forecastSort, setForecastSort] = useState<{
    key: 'annualPct' | 'annualDelta' | 'r2' | 'baseline' | 'forecast3yr';
    asc: boolean;
  }>({ key: 'annualPct', asc: false });

  const sortedComparison = useMemo(() => {
    const rows = [...forecastComparison];
    rows.sort((a, b) => {
      const v1 = a[forecastSort.key];
      const v2 = b[forecastSort.key];
      return forecastSort.asc ? v1 - v2 : v2 - v1;
    });
    return rows;
  }, [forecastComparison, forecastSort]);

  const lowR2Count = useMemo(() => forecastComparison.filter((r) => r.r2 < 0.4).length, [forecastComparison]);

  const handleSort = (key: typeof forecastSort.key) => {
    setForecastSort((prev) => ({ key, asc: prev.key === key ? !prev.asc : false }));
  };

  const downloadCSV = () => {
    if (!forecastComparison.length) return;
    const header = ['Region', 'Baseline', 'Annual Delta', 'Annual %', 'R2', '3-Year Forecast'];
    const rows = forecastComparison.map((r) => [r.region, r.baseline, r.annualDelta, r.annualPct, r.r2, r.forecast3yr]);
    const csv = [header, ...rows].map((row) => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forecast-comparison-${boundary}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const renderSortIcon = (active: boolean, asc: boolean) => {
    if (!active) return <ArrowUpDown className="w-3 h-3 text-gray-600" />;
    return asc ? <ArrowUp className="w-3 h-3 text-blue-400" /> : <ArrowDown className="w-3 h-3 text-blue-400" />;
  };

  return (
    <CardShell
      title="Forecast Comparison"
      icon={<Ruler className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
      iconColor="text-purple-400"
      compact={compact}
      pinned={pinned}
      onTogglePin={onTogglePin}
      headerExtra={
        <div className="flex items-center gap-2">
          {!compact && lowR2Count > 0 && (
            <div className="relative group flex items-center">
              <span className="flex items-center gap-1 text-[10px] text-rose-400 cursor-help">
                <AlertTriangle className="w-3 h-3" />
                {lowR2Count} low R²
              </span>
              <R2Tooltip />
            </div>
          )}
          {!compact && (
            <button
              onClick={downloadCSV}
              disabled={!forecastComparison.length}
              className="flex items-center gap-1 text-[10px] bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-white/5 px-2 py-1 rounded-md transition-colors"
            >
              <Download className="w-3 h-3" /> CSV
            </button>
          )}
          {headerExtra}
        </div>
      }
    >
      {isLoading ? (
        <div className="space-y-2 animate-pulse">
          {[...Array(compact ? 3 : 4)].map((_, i) => (
            <div key={i} className={`bg-white/5 rounded-lg ${compact ? 'h-6' : 'h-8'}`} />
          ))}
        </div>
      ) : forecastComparison.length ? (
        <div className={`overflow-x-auto ${compact ? 'overflow-y-auto pr-1' : ''}`} style={{ maxHeight: compact ? '280px' : undefined }}>
          <table className={`w-full ${compact ? 'text-[9px]' : 'text-xs'}`}>
            <thead>
              <tr className="text-gray-400 border-b border-white/[0.06]">
                <th className="text-left py-1.5 pl-1">Region</th>
                <th className="text-right py-1.5 cursor-pointer hover:text-white" onClick={() => handleSort('baseline')}>
                  <span className="inline-flex items-center gap-1">Score {renderSortIcon(forecastSort.key === 'baseline', forecastSort.asc)}</span>
                </th>
                <th className="text-right py-1.5 cursor-pointer hover:text-white" onClick={() => handleSort('annualDelta')}>
                  <span className="inline-flex items-center gap-1">Δ {renderSortIcon(forecastSort.key === 'annualDelta', forecastSort.asc)}</span>
                </th>
                {!compact && (
                  <th className="text-right py-1.5 cursor-pointer hover:text-white" onClick={() => handleSort('annualPct')}>
                    <span className="inline-flex items-center gap-1">% {renderSortIcon(forecastSort.key === 'annualPct', forecastSort.asc)}</span>
                  </th>
                )}
                {!compact && (
                  <th className="text-right py-1.5 cursor-pointer hover:text-white" onClick={() => handleSort('r2')}>
                    <span className="inline-flex items-center gap-1">R² {renderSortIcon(forecastSort.key === 'r2', forecastSort.asc)}</span>
                  </th>
                )}
                <th className="text-right py-1.5 pr-1 cursor-pointer hover:text-white" onClick={() => handleSort('forecast3yr')}>
                  <span className="inline-flex items-center gap-1">3-Yr {renderSortIcon(forecastSort.key === 'forecast3yr', forecastSort.asc)}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedComparison.slice(0, compact ? undefined : undefined).map((row, i) => (
                <motion.tr
                  key={i}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, delay: i * 0.03 }}
                  className="border-b border-white/[0.06] last:border-0"
                >
                  <td className="py-1.5 pl-1 text-white font-medium truncate max-w-[100px]" title={row.region}>{row.region.slice(0, 18)}</td>
                  <td className="py-1.5 text-right text-gray-300">{formatMetricValue(metric, row.baseline)}</td>
                  <td className={`py-1.5 text-right font-semibold ${row.annualDelta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {row.annualDelta >= 0 ? '+' : ''}{formatMetricValue(metric, row.annualDelta)}/yr
                  </td>
                  {!compact && (
                    <td className={`py-1.5 text-right font-semibold ${row.annualPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {row.annualPct >= 0 ? '+' : ''}{row.annualPct.toFixed(2)}%
                    </td>
                  )}
                  {!compact && (
                    <td className={`py-1.5 text-right ${r2Color(row.r2)} font-semibold`}>
                      <span className="inline-flex items-center gap-1">
                        {row.r2.toFixed(2)}
                        <div className="relative group flex items-center cursor-help">
                          <Info className="w-3 h-3 opacity-60 group-hover:opacity-100" />
                          <R2Tooltip />
                        </div>
                        {row.r2 < 0.4 && (
                          <AlertTriangle className="w-3 h-3 text-rose-400" />
                        )}
                      </span>
                    </td>
                  )}
                  <td className="py-1.5 pr-1 text-right text-gray-300">{formatMetricValue(metric, row.forecast3yr)}</td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={`flex items-center justify-center text-gray-500 ${compact ? 'h-36 text-[10px]' : 'py-4 text-xs'}`}>Select multiple areas to compare forecasts.</div>
      )}
    </CardShell>
  );
}

// ---------- Pin / drag handle helpers ----------

export function PinHandle({ pinned, onClick, title }: { pinned: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title || (pinned ? 'Unpin from map' : 'Move to the map')}
      className={`
        flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-semibold transition-colors
        ${pinned ? 'bg-blue-500/20 text-blue-400' : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'}
      `}
    >
      <Pin className={`w-3.5 h-3.5 ${pinned ? 'fill-current' : ''}`} />
      {pinned ? 'On map' : 'Move to map'}
    </button>
  );
}

export function DragHandle() {
  return (
    <div className="p-1 rounded-lg bg-white/5 text-gray-500 cursor-move">
      <GripVertical className="w-3.5 h-3.5" />
    </div>
  );
}
