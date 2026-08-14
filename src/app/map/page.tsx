'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import ReportPanel from '@/components/ReportPanel';
import TourModal from '@/components/TourModal';
import AccountModal from '@/components/AccountModal';
import CollapsibleFilterSection from '@/components/CollapsibleFilterSection';
import DraggableMapWindows, { WindowSelector, useDraggableWindows } from '@/components/DraggableMapWindows';
import {
  PropertyData,
  BoundaryKey,
  MetricKey,
  PropertyFilters,
  DEFAULT_FILTERS,
  engine,
  cleanBoundaryName,
} from '@/lib/engine';
import dynamic from 'next/dynamic';
import {
  Search,
  SlidersHorizontal,
  Map as MapIcon,
  CalendarDays,
  Bed,
  Bath,
  ChevronDown,
  DollarSign,
  BarChart3,
  ArrowLeft,
  TrendingUp,
  Building,
  Waves,
  School,
  MapPin,
  RotateCcw,
  HelpCircle,
  MousePointer2,
  AlertTriangle,
  Lock,
  User,
  Save,
  MessageSquare,
  PanelLeft,
  Printer,
  X,
  Check,
  Star,
} from 'lucide-react';

const MapComponent = dynamic(() => import('@/components/MapComponent'), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full flex items-center justify-center text-sm text-slate-400">
      Loading map…
    </div>
  ),
});

const BOUNDARIES: { key: BoundaryKey; name: string; short: string; premium?: boolean }[] = [
  { key: 'subdivisions', name: 'Subdivisions', short: 'Subdivisions', premium: true },
  { key: 'zipcodes', name: 'Zip Codes', short: 'Zip Codes', premium: false },
  { key: 'highschools', name: 'School Districts', short: 'Districts', premium: true },
  { key: 'elementary', name: 'Elementary', short: 'Elementary', premium: true },
  { key: 'middle', name: 'Middle Schools', short: 'Middle', premium: true },
  { key: 'neighborhoods', name: 'Neighborhoods', short: 'Neighborhoods', premium: true },
];

const METRICS: { key: MetricKey; label: string; category: 'sale' | 'rental' | 'market' | 'school' | 'cost' }[] = [
  { key: 'Close Price', label: 'Sales Price', category: 'sale' },
  { key: 'Price per Sqft', label: 'Sale Price / Sq.Ft.', category: 'sale' },
  { key: 'List-to-Sale Ratio', label: 'List-to-Sale Ratio', category: 'market' },
  { key: 'Days on Market', label: 'Sale Days on Market', category: 'market' },
  { key: 'Est. Rental Price', label: 'Rental Price', category: 'rental' },
  { key: 'Rent-to-Sale Ratio', label: 'Rent-to-Sale Ratio', category: 'rental' },
  { key: 'Rental Price per Sqft', label: 'Rental Price / Sq.Ft.', category: 'rental' },
  { key: 'Rental Days On Market', label: 'Rent Days on Market', category: 'rental' },
  { key: 'Lot Size', label: 'Lot Size', category: 'sale' },
  { key: 'Appreciation Rate', label: 'Appreciation Rate', category: 'market' },
  { key: 'Investor Index', label: "Investor's Index", category: 'market' },
  { key: 'Annual HOA Fee', label: 'Annual HOA Fee', category: 'cost' },
  { key: 'Last Year Tax Rate', label: 'Last Year Tax Rate', category: 'cost' },
  { key: 'Elem ETA Score', label: 'Elementary ETA Score', category: 'school' },
  { key: 'Middle ETA Score', label: 'Middle ETA Score', category: 'school' },
  { key: 'High ETA Score', label: 'High School District ETA', category: 'school' },
];

const PERIODS: { key: PropertyFilters['period']; label: string }[] = [
  { key: 'all', label: 'All data' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: '6m', label: 'Last 6 months' },
  { key: 'ytd', label: 'Year-to-Date' },
  { key: '1y', label: '1 year' },
  { key: '3y', label: '3 years' },
  { key: '5y', label: '5 years' },
];

const FIXED_PALETTE = ['#93c5fd', '#60a5fa', '#3b82f6', '#4f46e5', '#7c3aed'];

const RATING_OPTIONS = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'];

type InitialMetricsSnapshot = { values: Record<string, number>; counts: Record<string, number> };

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

function generateColorStops(
  values: Record<string, number>,
  metric: MetricKey,
  reverse: boolean,
  customMin?: number,
  customMax?: number
): [number, string][] {
  const colors = reverse ? [...FIXED_PALETTE].reverse() : FIXED_PALETTE;
  const vals = Object.values(values).filter(
    (v) => isFinite(v) && (v > 0 || metric === 'Appreciation Rate' || metric === 'Investor Index' || metric === 'Last Year Tax Rate')
  );
  if (!vals.length) {
    return metric === 'Days on Market' || metric === 'Rental Days On Market'
      ? ([[0, colors[0]], [30, colors[1]], [60, colors[2]], [90, colors[3]], [120, colors[4]]] as [number, string][])
      : ([[150000, colors[0]], [300000, colors[1]], [450000, colors[2]], [600000, colors[3]], [800000, colors[4]]] as [number, string][]);
  }
  let min = customMin ?? Math.min(...vals);
  let max = customMax ?? Math.max(...vals);
  if (min >= max) {
    return [[min, colors[2]], [min + 1, colors[4]]] as [number, string][];
  }
  const step = (max - min) / (colors.length - 1);
  return colors.map((c, i) => [min + step * i, c]) as [number, string][];
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

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    setMatches(m.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    m.addEventListener('change', handler);
    return () => m.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

export default function MapPage() {
  const [boundary, setBoundary] = useState<BoundaryKey>('subdivisions');
  const [metric, setMetric] = useState<MetricKey>('Close Price');
  const [loadingCSV, setLoadingCSV] = useState(true);
  const [csvProgress, setCsvProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [initialMetrics, setInitialMetrics] = useState<
    Partial<Record<BoundaryKey, { values: Record<string, number>; counts: Record<string, number> }>> | null
  >(null);
  const csvStartedRef = useRef(false);

  const [filters, setFilters] = useState<PropertyFilters>(DEFAULT_FILTERS);

  const [layerSales, setLayerSales] = useState(false);
  const [layerRentals, setLayerRentals] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [multiSelect, setMultiSelect] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [showTour, setShowTour] = useState(false);
  const [reportGenerated, setReportGenerated] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [reversePalette, setReversePalette] = useState(false);
  const [autoScale, setAutoScale] = useState(true);
  const [customMin, setCustomMin] = useState<number>(0);
  const [customMax, setCustomMax] = useState<number>(0);
  const [fillOpacity] = useState(0.50);
  const [showChatbot, setShowChatbot] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountModalMode, setAccountModalMode] = useState<'account' | 'save'>('account');

  const { active: activeWindows, setActive: setActiveWindows } = useDraggableWindows();

  const isMobile = useMediaQuery('(max-width: 1024px)');

  const startCsvLoad = useCallback(() => {
    if (csvStartedRef.current) return;
    csvStartedRef.current = true;
    engine
      .loadAllCSV(false, (loaded, total) => setCsvProgress({ loaded, total }))
      .then((result) => {
        setLoadingCSV(false);
        if (!result.ok) {
          setCsvError(result.error || 'No se pudieron cargar los datos del mapa.');
        }
      })
      .catch((err) => {
        setLoadingCSV(false);
        setCsvError(err?.message || 'Error inesperado cargando datos del mapa.');
      });
  }, []);

  // Start the heavy CSV load as soon as the active boundary snapshot is ready,
  // but always fall back to starting it after 2 seconds so a missing snapshot
  // never blocks the map.
  const activeMetricsReady = useMemo(
    () => !!initialMetrics && !!initialMetrics[boundary],
    [initialMetrics, boundary]
  );

  useEffect(() => {
    if (activeMetricsReady) startCsvLoad();
  }, [activeMetricsReady, startCsvLoad]);

  useEffect(() => {
    const fallback = setTimeout(() => {
      if (!csvStartedRef.current) startCsvLoad();
    }, 2000);
    return () => clearTimeout(fallback);
  }, [startCsvLoad]);

  const loadMetricsForBoundary = useCallback(
    async (key: BoundaryKey) => {
      if (initialMetrics?.[key]) return;
      try {
        const data = await engine.fetchGzJson<InitialMetricsSnapshot>(`/cache/initial_metrics_${key}.json.gz`);
        setInitialMetrics((prev) => ({ ...(prev || {}), [key]: data }));
      } catch (err) {
        console.error(`[Kwizi Map] failed to load initial metrics for ${key}`, err);
      }
    },
    [initialMetrics]
  );

  useEffect(() => {
    loadMetricsForBoundary(boundary);
  }, [boundary, loadMetricsForBoundary]);

  useEffect(() => {
    // Preload the remaining boundary snapshots in the background once the active
    // one is available. They are tiny compared to the CSV and make switching
    // boundaries feel instant.
    if (!activeMetricsReady) return;
    for (const b of BOUNDARIES) {
      if (b.key !== boundary && !initialMetrics?.[b.key]) {
        loadMetricsForBoundary(b.key);
      }
    }
  }, [activeMetricsReady, boundary, initialMetrics, loadMetricsForBoundary]);

  useEffect(() => {
    const seen = typeof window !== 'undefined' ? window.localStorage.getItem('kwizi-tour-seen') : 'true';
    if (seen !== 'true') {
      const t = setTimeout(() => setShowTour(true), 800);
      return () => clearTimeout(t);
    }
  }, []);

  useEffect(() => {
    // Prefetch the map component chunk as early as possible so Leaflet and the
    // polygon rendering code are ready by the time the initial snapshot arrives.
    import('@/components/MapComponent');
  }, []);

  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
    else setSidebarOpen(true);
  }, [isMobile]);

  useEffect(() => {
    if (selectedIds.length === 0) setReportGenerated(false);
  }, [selectedIds]);

  useEffect(() => {
    if (reportGenerated && reportRef.current) {
      reportRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [reportGenerated]);

  const filteredData = useMemo(() => {
    if (loadingCSV) return [];
    return engine.filterProperties(filters);
  }, [loadingCSV, filters]);

  const { values: metricValues, counts: sampleCounts, names: nameMap } = useMemo(() => {
    return engine.getMapValues(filteredData, boundary, metric);
  }, [filteredData, boundary, metric]);

  const dataReady = !loadingCSV && filteredData.length > 0;

  // Use the lightweight pre-computed snapshot for instant map coloring while
  // the full CSV dataset is still loading in the background.
  const effectiveMetricValues = dataReady
    ? metricValues
    : initialMetrics?.[boundary]?.values ?? {};
  const effectiveSampleCounts = dataReady
    ? sampleCounts
    : initialMetrics?.[boundary]?.counts ?? {};
  const effectiveNameMap = dataReady ? nameMap : {};

  useEffect(() => {
    const vals = Object.values(effectiveMetricValues).filter((v) => isFinite(v));
    if (vals.length) {
      setCustomMin(Math.min(...vals));
      setCustomMax(Math.max(...vals));
    }
  }, [effectiveMetricValues]);

  const colorStops = useMemo(() => {
    return generateColorStops(
      effectiveMetricValues,
      metric,
      reversePalette,
      autoScale ? undefined : customMin,
      autoScale ? undefined : customMax
    );
  }, [effectiveMetricValues, metric, reversePalette, autoScale, customMin, customMax]);

  const emptyStats = useMemo(() => ({
    count: 0, avgSale: 0, avgSqft: 0, avgDom: 0, totalVolume: 0, avgList: 0, avgLotSize: 0,
  }), []);

  const reportStats = useMemo(() => {
    if (!dataReady) return emptyStats;
    return engine.getStatsForSelection(filteredData, boundary, selectedIds);
  }, [filteredData, selectedIds, boundary, dataReady, emptyStats]);

  const marketHealth = useMemo(() => {
    if (!dataReady) return null;
    const isRental =
      metric === 'Est. Rental Price' ||
      metric === 'Rental Price per Sqft' ||
      metric === 'Rental Days On Market' ||
      metric === 'Rent-to-Sale Ratio';
    return engine.getMarketHealth(filteredData, boundary, selectedIds, isRental ? 'rental' : 'sale');
  }, [filteredData, selectedIds, boundary, metric, dataReady]);

  const timeSeries = useMemo(() => {
    if (!dataReady) return [];
    return engine.getTimeSeries(filteredData, boundary, metric, selectedIds);
  }, [filteredData, boundary, metric, selectedIds, dataReady]);

  const forecast = useMemo(() => {
    if (!timeSeries.length) return null;
    return engine.buildForecast(timeSeries);
  }, [timeSeries]);

  const forecastComparison = useMemo(() => {
    if (!dataReady) return [];
    return engine.getForecastForSelection(filteredData, boundary, metric, selectedIds);
  }, [filteredData, boundary, metric, selectedIds, dataReady]);

  const chartData = useMemo(() => {
    if (!dataReady) return [];
    return Object.entries(metricValues)
      .filter(([k]) => selectedIds.length === 0 || selectedIds.includes(k))
      .map(([name, value]) => ({ name: cleanBoundaryName(name), value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [metricValues, selectedIds, dataReady]);

  const yearBuiltData = useMemo(() => {
    if (!dataReady) return [];
    const buckets: Record<string, number> = {
      'Before 1970': 0,
      '1970–1989': 0,
      '1990–2009': 0,
      '2010+': 0,
    };
    const selectedSet = new Set(selectedIds);
    const selected = selectedIds.length
      ? filteredData.filter((d) => selectedSet.has(engine.getBoundaryKey(boundary, d)))
      : filteredData;
    selected.forEach((d) => {
      if (!d.yearBuilt) return;
      if (d.yearBuilt < 1970) buckets['Before 1970']++;
      else if (d.yearBuilt < 1990) buckets['1970–1989']++;
      else if (d.yearBuilt < 2010) buckets['1990–2009']++;
      else buckets['2010+']++;
    });
    return Object.entries(buckets)
      .map(([name, value]) => ({ name, value }))
      .filter((d) => d.value > 0);
  }, [filteredData, selectedIds, boundary, dataReady]);

  const handleFilterChange = useCallback(
    (key: keyof PropertyFilters, value: number | string | string[]) => {
      setFilters((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const handleMultiSelectChange = useCallback(
    (key: keyof PropertyFilters, value: string, checked: boolean) => {
      setFilters((prev) => {
        const current = prev[key] as string[];
        const next = checked ? [...current, value] : current.filter((v) => v !== value);
        return { ...prev, [key]: next };
      });
    },
    []
  );

  const applySearch = useCallback(() => {
    if (!searchQuery.trim()) {
      setSelectedIds([]);
      return;
    }
    const q = searchQuery.trim().toUpperCase();
    const matches = filteredData
      .filter((d) => {
        const pid = engine.getBoundaryKey(boundary, d);
        return (
          pid.includes(q) ||
          d.address.toUpperCase().includes(q) ||
          d.zip.includes(q) ||
          d.city.toUpperCase().includes(q)
        );
      })
      .map((d) => engine.getBoundaryKey(boundary, d));
    const unique = Array.from(new Set(matches));
    setSelectedIds(unique);
  }, [searchQuery, filteredData, boundary]);

  const uniquePropertyTypes = useMemo(() => engine.getUniqueValues('propertyType'), [loadingCSV]);
  const uniqueCities = useMemo(() => engine.getUniqueValues('city').slice(0, 120), [loadingCSV]);
  const uniqueDistricts = useMemo(() => engine.getUniqueValues('schoolDistrict').slice(0, 80), [loadingCSV]);
  const uniqueElementary = useMemo(() => engine.getUniqueValues('elementary').slice(0, 80), [loadingCSV]);
  const uniqueMiddle = useMemo(() => engine.getUniqueValues('middle').slice(0, 80), [loadingCSV]);
  const uniqueHigh = useMemo(() => engine.getUniqueValues('highschools').slice(0, 80), [loadingCSV]);

  const selectedNames = useMemo(() => {
    return selectedIds.map((id) => nameMap[id] || id);
  }, [selectedIds, nameMap]);

  const activeFilterSummary = useMemo(() => {
    const parts: string[] = [];
    if (filters.elementary.length) parts.push(`${filters.elementary.length} elementary`);
    if (filters.middle.length) parts.push(`${filters.middle.length} middle`);
    if (filters.highschools.length) parts.push(`${filters.highschools.length} district`);
    if (filters.elementaryRating.length) parts.push(`${filters.elementaryRating.length} elem rating`);
    if (filters.middleRating.length) parts.push(`${filters.middleRating.length} mid rating`);
    if (filters.highRating.length) parts.push(`${filters.highRating.length} high rating`);
    return parts.length ? parts.join(' · ') : 'No school filters';
  }, [filters]);

  const handleReset = useCallback(() => {
    setSelectedIds([]);
    setFilters(DEFAULT_FILTERS);
    setSearchQuery('');
    setReportGenerated(false);
    setActiveWindows([]);
  }, [setActiveWindows]);

  const generateReport = useCallback(() => {
    setReportGenerated(true);
    // When no boxes are pinned, default to Quick Stats + Market Health
    if (activeWindows.length === 0) {
      setActiveWindows(['quick-stats', 'market-health']);
    }
  }, [activeWindows.length, setActiveWindows]);

  const clearReport = useCallback(() => {
    setReportGenerated(false);
    setActiveWindows([]);
  }, [setActiveWindows]);

  const handleExportPDF = useCallback(() => {
    if (reportRef.current) {
      reportRef.current.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
    setTimeout(() => window.print(), 150);
  }, []);

  const BoundaryButton = ({ b }: { b: (typeof BOUNDARIES)[number] }) => (
    <button
      key={b.key}
      title={b.name + (b.premium ? ' (Premium)' : '')}
      onClick={() => {
        if (boundary === b.key) return;
        setBoundary(b.key);
        setSelectedIds([]);
      }}
      className={`relative flex-1 flex items-center justify-center gap-1 text-[10px] sm:text-xs font-semibold py-2 px-2 rounded-lg transition-colors whitespace-nowrap ${
        boundary === b.key
          ? 'bg-blue-600 text-white shadow'
          : 'text-gray-300 hover:bg-white/5'
      }`}
    >
      <span className="hidden sm:inline">{b.name}</span>
      <span className="sm:hidden">{b.short}</span>
      {b.premium && (
        <span className="ml-0.5 inline-flex items-center gap-0.5 text-[9px] font-bold text-amber-300 bg-amber-500/10 px-1 py-0.5 rounded">
          <Star className="w-2.5 h-2.5" />
          <span className="hidden sm:inline">PREM</span>
        </span>
      )}
    </button>
  );

  const FilterSection = ({
    icon,
    title,
    children,
    className = '',
    defaultOpen = true,
    dataTour,
  }: {
    icon: React.ReactNode;
    title: string;
    children: React.ReactNode;
    className?: string;
    defaultOpen?: boolean;
    dataTour?: string;
  }) => (
    <CollapsibleFilterSection
      icon={icon}
      title={title}
      className={className}
      defaultOpen={defaultOpen}
      dataTour={dataTour}
    >
      {children}
    </CollapsibleFilterSection>
  );

  const RangeControl = ({
    label,
    min,
    max,
    step,
    lowKey,
    highKey,
    format,
  }: {
    label: string;
    min: number;
    max: number;
    step: number;
    lowKey: keyof PropertyFilters;
    highKey: keyof PropertyFilters;
    format: (n: number) => string;
  }) => (
    <div>
      <div className="flex justify-between text-xs text-gray-400 font-bold uppercase tracking-wider mb-2">
        <span>{label}</span>
        <span className="text-blue-400">
          {format(filters[lowKey] as number)} - {format(filters[highKey] as number)}
        </span>
      </div>
      <div className="flex gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={filters[lowKey] as number}
          onChange={(e) => handleFilterChange(lowKey, Number(e.target.value))}
          className="flex-1 accent-blue-500 h-1.5 bg-white/10 rounded-full appearance-none"
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={filters[highKey] as number}
          onChange={(e) => handleFilterChange(highKey, Number(e.target.value))}
          className="flex-1 accent-blue-500 h-1.5 bg-white/10 rounded-full appearance-none"
        />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0a0c10] text-white flex flex-col font-sans print:bg-white print:text-black">
      {/* Header */}
      <header data-tour="header" className="bg-[#121620] border-b border-white/[0.06] px-4 lg:px-6 py-3 flex items-center justify-between shrink-0 print:hidden z-30">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors">
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm font-medium hidden sm:inline">Back</span>
          </Link>
          <div className="h-5 w-px bg-white/10 mx-1" />
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow">
            <span className="text-white font-bold text-lg">K</span>
          </div>
          <div>
            <h1 className="text-sm sm:text-base font-bold text-white leading-tight">Houston Metro Real-Estate Analytics</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {loadingCSV && csvProgress && (
            <div className="flex flex-col gap-1 mr-2 min-w-[140px]">
              <div className="flex items-center justify-between text-[10px] text-blue-300">
                <span>Loading CSV {csvProgress.loaded}/{csvProgress.total}</span>
                <span>{Math.round((csvProgress.loaded / csvProgress.total) * 100)}%</span>
              </div>
              <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${(csvProgress.loaded / csvProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}
          {loadingCSV && !csvProgress && (
            <div className="flex items-center gap-2 text-blue-300 text-sm mr-2">
              <div className="w-4 h-4 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
              <span className="hidden sm:inline">Loading data…</span>
            </div>
          )}
          {csvError && (
            <div className="flex items-center gap-2 text-red-400 text-xs mr-2 max-w-[240px]">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span className="truncate" title={csvError}>{csvError}</span>
            </div>
          )}
          <button
            onClick={() => setShowTour(true)}
            className="bg-[#1f2937] hover:bg-[#374151] text-white p-2 sm:px-3 sm:py-2 rounded-lg shadow flex items-center gap-2 font-semibold text-sm transition-all"
            title="Show guided tour"
          >
            <HelpCircle className="w-4 h-4" />
            <span className="hidden sm:inline">Tour</span>
          </button>
          <button
            onClick={handleExportPDF}
            className="bg-blue-600 hover:bg-blue-700 text-white p-2 sm:px-3 sm:py-2 rounded-lg shadow flex items-center gap-2 font-semibold text-sm transition-all"
            title="Export report as PDF"
          >
            <Printer className="w-4 h-4" />
            <span className="hidden sm:inline">PDF</span>
          </button>
          <button
            onClick={() => {
              setAccountModalMode('save');
              setShowAccountModal(true);
            }}
            className="bg-[#1f2937] hover:bg-[#374151] text-white p-2 sm:px-3 sm:py-2 rounded-lg shadow flex items-center gap-2 font-semibold text-sm transition-all hidden md:flex"
            title="Save Report"
          >
            <Save className="w-4 h-4" />
            <span className="hidden lg:inline">Save</span>
          </button>
          <button
            onClick={() => {
              setAccountModalMode('account');
              setShowAccountModal(true);
            }}
            className="bg-[#1f2937] hover:bg-[#374151] text-white p-2 sm:px-3 sm:py-2 rounded-lg shadow flex items-center gap-2 font-semibold text-sm transition-all"
            title="My Account"
          >
            <User className="w-4 h-4" />
            <span className="hidden lg:inline">Account</span>
          </button>
          <button
            onClick={handleReset}
            className="bg-[#1f2937] hover:bg-[#374151] text-white p-2 sm:px-3 sm:py-2 rounded-lg shadow flex items-center gap-2 font-semibold text-sm transition-all"
            title="Reset all"
          >
            <RotateCcw className="w-4 h-4" />
            <span className="hidden sm:inline">Reset</span>
          </button>
        </div>
      </header>

      {/* Summary bar */}
      <div data-tour="summary-bar" className="bg-[#0a0c10] border-b border-white/[0.06] px-4 lg:px-6 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs print:hidden no-print">
        <div className="flex items-center gap-1.5">
          <MapIcon className="w-3.5 h-3.5 text-blue-400" />
          <span className="text-gray-500 uppercase font-bold">Boundary</span>
          <span className="text-white font-semibold">{BOUNDARIES.find((b) => b.key === boundary)?.name}</span>
        </div>
        <div className="hidden sm:block h-4 w-px bg-white/10" />
        <div className="flex items-center gap-1.5">
          <BarChart3 className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-gray-500 uppercase font-bold">Metric</span>
          <span className="text-white font-semibold">{METRICS.find((m) => m.key === metric)?.label}</span>
        </div>
        <div className="hidden sm:block h-4 w-px bg-white/10" />
        <div className="flex items-center gap-1.5">
          <CalendarDays className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-gray-500 uppercase font-bold">Period</span>
          <span className="text-white font-semibold">{PERIODS.find((p) => p.key === filters.period)?.label}</span>
        </div>
        <div className="hidden md:block h-4 w-px bg-white/10" />
        <div className="flex items-center gap-1.5">
          <School className="w-3.5 h-3.5 text-purple-400" />
          <span className="text-gray-500 uppercase font-bold">Schools</span>
          <span className="text-gray-300">{activeFilterSummary}</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-gray-400">
          {loadingCSV ? (
            <span className="flex items-center gap-2 text-blue-300 text-xs">
              <span className="w-3.5 h-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
              {csvProgress && csvProgress.total > 0
                ? `Loading CSV ${csvProgress.loaded}/${csvProgress.total}…`
                : 'Loading market data…'}
            </span>
          ) : (
            <>
              <span>
                <span className="text-white font-semibold">{filteredData.length.toLocaleString()}</span> properties
              </span>
              <span>
                <span className="text-white font-semibold">{Object.keys(metricValues).length.toLocaleString()}</span> areas
              </span>
              <span>
                <span className="text-white font-semibold">{selectedIds.length}</span> selected
              </span>
            </>
          )}
        </div>
      </div>

      {/* Main workspace */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">
        {/* Sidebar toggle (mobile) */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="lg:hidden m-3 mb-0 flex items-center gap-2 px-3 py-2 rounded-xl bg-[#121620] border border-white/[0.06] text-sm font-semibold text-gray-300 print:hidden"
        >
          <PanelLeft className="w-4 h-4" />
          {sidebarOpen ? 'Hide filters' : 'Show filters'}
        </button>

        {/* Left sidebar */}
        <aside
          className={`${
            sidebarOpen ? 'flex' : 'hidden'
          } lg:flex flex-col gap-4 w-full lg:w-80 xl:w-88 shrink-0 bg-[#0a0c10] border-r border-white/[0.06] p-4 overflow-y-auto print:hidden`}
        >
          {/* Search */}
          <FilterSection icon={<Search className="w-4 h-4" />} title="Search" defaultOpen={false} dataTour="search">
            <div className="flex items-center gap-2 bg-white/5 border border-white/[0.06] rounded-xl px-3 py-2">
              <Search className="w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Area, address or ZIP…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applySearch()}
                className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder-gray-500"
              />
              <button
                onClick={applySearch}
                className="text-xs bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-md font-medium transition-colors"
              >
                Go
              </button>
            </div>
          </FilterSection>

          {/* Boundary */}
          <FilterSection icon={<MapIcon className="w-4 h-4 text-blue-400" />} title="Geographic Boundary" defaultOpen={false} dataTour="boundary">
            <div className="flex flex-wrap gap-1">
              {BOUNDARIES.map((b) => (
                <BoundaryButton key={b.key} b={b} />
              ))}
            </div>
          </FilterSection>

          {/* Metric */}
          <FilterSection icon={<BarChart3 className="w-4 h-4 text-emerald-400" />} title="Market Metric" defaultOpen={false} dataTour="metric">
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as MetricKey)}
              className="w-full bg-white/5 border border-white/[0.06] text-white text-sm rounded-xl px-3 py-2.5 outline-none focus:border-blue-500 appearance-none"
            >
              {METRICS.map((m) => (
                <option key={m.key} value={m.key} className="bg-[#121620]">
                  {m.label}
                </option>
              ))}
            </select>
          </FilterSection>

          {/* Period */}
          <FilterSection icon={<CalendarDays className="w-4 h-4 text-amber-400" />} title="Close Period" defaultOpen={false}>
            <select
              value={filters.period}
              onChange={(e) => handleFilterChange('period', e.target.value as PropertyFilters['period'])}
              className="w-full bg-white/5 border border-white/[0.06] text-white text-sm rounded-xl px-3 py-2.5 outline-none focus:border-blue-500 appearance-none"
            >
              {PERIODS.map((p) => (
                <option key={p.key} value={p.key} className="bg-[#121620]">
                  {p.label}
                </option>
              ))}
            </select>
          </FilterSection>

          {/* Quick property filters */}
          <FilterSection icon={<SlidersHorizontal className="w-4 h-4" />} title="Property Filters" defaultOpen={false}>
            <div className="space-y-4">
              <RangeControl
                label="Sale Price"
                min={0}
                max={5000000}
                step={50000}
                lowKey="saleMin"
                highKey="saleMax"
                format={formatMoney}
              />
              <RangeControl
                label="Est. Rent"
                min={0}
                max={10000}
                step={100}
                lowKey="rentMin"
                highKey="rentMax"
                format={formatMoney}
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[10px] font-bold uppercase text-gray-400 block mb-1.5">Beds</span>
                  <select
                    value={filters.bedsMin}
                    onChange={(e) => handleFilterChange('bedsMin', Number(e.target.value))}
                    className="w-full bg-white/5 border border-white/[0.06] text-white text-sm rounded-lg px-2 py-1.5 outline-none"
                  >
                    {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n} className="bg-[#121620]">
                        {n}+
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className="text-[10px] font-bold uppercase text-gray-400 block mb-1.5">Baths</span>
                  <select
                    value={filters.bathsMin}
                    onChange={(e) => handleFilterChange('bathsMin', Number(e.target.value))}
                    className="w-full bg-white/5 border border-white/[0.06] text-white text-sm rounded-lg px-2 py-1.5 outline-none"
                  >
                    {[0, 1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n} className="bg-[#121620]">
                        {n}+
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </FilterSection>

          {/* Advanced filters */}
          <FilterSection icon={<SlidersHorizontal className="w-4 h-4 text-purple-400" />} title="Advanced Filters" defaultOpen={false} dataTour="advanced-filters">
            <div className="space-y-5">
              <RangeControl
                label="Sq.Ft."
                min={0}
                max={10000}
                step={250}
                lowKey="sqftMin"
                highKey="sqftMax"
                format={(n) => (n >= 1000 ? (n / 1000).toFixed(0) + 'k' : n.toString())}
              />
              <RangeControl
                label="Price / Sq.Ft."
                min={0}
                max={2000}
                step={10}
                lowKey="pricePerSqftMin"
                highKey="pricePerSqftMax"
                format={formatMoney}
              />
              <RangeControl
                label="Lot Size"
                min={0}
                max={50000}
                step={500}
                lowKey="lotSizeMin"
                highKey="lotSizeMax"
                format={(n) => n.toLocaleString()}
              />
              <RangeControl
                label="Year Built"
                min={1920}
                max={new Date().getFullYear()}
                step={1}
                lowKey="yearMin"
                highKey="yearMax"
                format={(n) => n.toString()}
              />
              <RangeControl
                label="Days on Market"
                min={0}
                max={365}
                step={5}
                lowKey="domMin"
                highKey="domMax"
                format={(n) => n + 'd'}
              />
              <RangeControl
                label="List-to-Sale Ratio"
                min={50}
                max={150}
                step={1}
                lowKey="l2sMin"
                highKey="l2sMax"
                format={(n) => n + '%'}
              />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[10px] font-bold uppercase text-gray-400 block mb-1.5">Property Type</span>
                  <select
                    multiple
                    value={filters.propertyTypes}
                    onChange={(e) => {
                      const opts = Array.from(e.target.selectedOptions).map((o) => o.value);
                      handleFilterChange('propertyTypes', opts);
                    }}
                    className="w-full bg-white/5 border border-white/[0.06] text-white text-xs rounded-lg px-2 py-1.5 outline-none"
                    size={Math.min(4, uniquePropertyTypes.length || 1)}
                  >
                    {uniquePropertyTypes.map((t) => (
                      <option key={t} value={t} className="bg-[#121620]">
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className="text-[10px] font-bold uppercase text-gray-400 block mb-1.5">Pool</span>
                  <select
                    value={filters.pool}
                    onChange={(e) => handleFilterChange('pool', e.target.value as PropertyFilters['pool'])}
                    className="w-full bg-white/5 border border-white/[0.06] text-white text-sm rounded-lg px-2 py-1.5 outline-none"
                  >
                    <option value="any" className="bg-[#121620]">Any</option>
                    <option value="yes" className="bg-[#121620]">Yes</option>
                    <option value="no" className="bg-[#121620]">No</option>
                  </select>
                </div>
              </div>

              <div>
                <span className="text-[10px] font-bold uppercase text-gray-400 block mb-1.5">Cities</span>
                <select
                  multiple
                  value={filters.cities}
                  onChange={(e) => {
                    const opts = Array.from(e.target.selectedOptions).map((o) => o.value);
                    handleFilterChange('cities', opts);
                  }}
                  className="w-full bg-white/5 border border-white/[0.06] text-white text-xs rounded-lg px-2 py-1.5 outline-none"
                  size={Math.min(4, uniqueCities.length || 1)}
                >
                  {uniqueCities.map((t) => (
                    <option key={t} value={t} className="bg-[#121620]">
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              {/* School filters */}
              <div className="pt-4 border-t border-white/[0.06]">
                <div className="flex items-center gap-2 mb-3 text-purple-400">
                  <School className="w-4 h-4" />
                  <span className="text-[11px] font-bold uppercase tracking-wider">School Filters</span>
                </div>
                <div className="space-y-4">
                  <div>
                    <span className="text-[10px] font-bold uppercase text-gray-400 block mb-1.5">School District</span>
                    <select
                      multiple
                      value={filters.schoolDistricts}
                      onChange={(e) => {
                        const opts = Array.from(e.target.selectedOptions).map((o) => o.value);
                        handleFilterChange('schoolDistricts', opts);
                      }}
                      className="w-full bg-white/5 border border-white/[0.06] text-white text-xs rounded-lg px-2 py-1.5 outline-none"
                      size={Math.min(4, uniqueDistricts.length || 1)}
                    >
                      {uniqueDistricts.map((t) => (
                        <option key={t} value={t} className="bg-[#121620]">
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { key: 'elementary', label: 'Elementary', values: uniqueElementary },
                      { key: 'middle', label: 'Middle', values: uniqueMiddle },
                      { key: 'highschools', label: 'District', values: uniqueHigh },
                    ].map(({ key, label, values }) => (
                      <div key={key}>
                        <span className="text-[9px] font-bold uppercase text-gray-400 block mb-1">{label}</span>
                        <select
                          multiple
                          value={filters[key as keyof PropertyFilters] as string[]}
                          onChange={(e) => {
                            const opts = Array.from(e.target.selectedOptions).map((o) => o.value);
                            handleFilterChange(key as keyof PropertyFilters, opts);
                          }}
                          className="w-full bg-white/5 border border-white/[0.06] text-white text-[10px] rounded-lg px-1 py-1 outline-none"
                          size={Math.min(3, values.length || 1)}
                        >
                          {values.map((t) => (
                            <option key={t} value={t} className="bg-[#121620]">
                              {t.slice(0, 18)}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-3">
                    {[
                      { key: 'elementaryRating', label: 'Elem Rating' },
                      { key: 'middleRating', label: 'Middle Rating' },
                      { key: 'highRating', label: 'High Rating' },
                    ].map(({ key, label }) => {
                      const selected = filters[key as keyof PropertyFilters] as string[];
                      return (
                        <div key={key}>
                          <span className="text-[10px] font-bold uppercase text-gray-400 block mb-1.5">{label}</span>
                          <div className="flex flex-wrap gap-1">
                            {RATING_OPTIONS.map((grade) => {
                              const active = selected.includes(grade);
                              return (
                                <button
                                  key={grade}
                                  onClick={() => handleMultiSelectChange(key as keyof PropertyFilters, grade, !active)}
                                  className={`px-2 py-1 rounded-md text-[10px] font-bold border transition-colors ${
                                    active
                                      ? 'bg-purple-600 border-purple-500 text-white'
                                      : 'bg-white/5 border-white/[0.06] text-gray-400 hover:bg-white/10'
                                  }`}
                                >
                                  {grade}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </FilterSection>

          {/* Scale / legend */}
          <FilterSection icon={<BarChart3 className="w-4 h-4 text-cyan-400" />} title="Scale Range" defaultOpen={false}>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoScale}
                    onChange={(e) => setAutoScale(e.target.checked)}
                    className="rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500"
                  />
                  Auto scale
                </label>
                <button
                  onClick={() => setReversePalette(!reversePalette)}
                  className="text-[10px] text-gray-400 hover:text-white underline"
                >
                  Reverse colors
                </button>
              </div>
              {!autoScale && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-[10px] text-gray-500 uppercase block mb-1">Min</span>
                    <input
                      type="number"
                      value={customMin}
                      onChange={(e) => setCustomMin(Number(e.target.value))}
                      className="w-full bg-white/5 border border-white/[0.06] rounded-lg px-2 py-1.5 text-sm text-white outline-none"
                    />
                  </div>
                  <div>
                    <span className="text-[10px] text-gray-500 uppercase block mb-1">Max</span>
                    <input
                      type="number"
                      value={customMax}
                      onChange={(e) => setCustomMax(Number(e.target.value))}
                      className="w-full bg-white/5 border border-white/[0.06] rounded-lg px-2 py-1.5 text-sm text-white outline-none"
                    />
                  </div>
                </div>
              )}
              <div
                className="h-3 w-full rounded-full"
                style={{
                  background: `linear-gradient(to right, ${colorStops.map((s) => s[1]).join(', ')})`,
                }}
              />
              <div className="flex justify-between text-xs font-semibold text-gray-300">
                <span>{formatMetricValue(metric, colorStops[0][0])}</span>
                <span>{formatMetricValue(metric, colorStops[colorStops.length - 1][0])}</span>
              </div>
            </div>
          </FilterSection>

          {/* Layers */}
          <FilterSection icon={<MapPin className="w-4 h-4 text-rose-400" />} title="Map Layers" defaultOpen={false}>
            <div className="space-y-2">
              <button
                onClick={() => setLayerSales(!layerSales)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                  layerSales
                    ? 'bg-white/15 border-white/20 text-white'
                    : 'bg-black/40 border-white/[0.06] text-gray-400 hover:bg-white/10'
                }`}
              >
                <Building className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-semibold">Current Sales</span>
              </button>
              <button
                onClick={() => setLayerRentals(!layerRentals)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                  layerRentals
                    ? 'bg-white/15 border-white/20 text-white'
                    : 'bg-black/40 border-white/[0.06] text-gray-400 hover:bg-white/10'
                }`}
              >
                <Building className="w-4 h-4 text-orange-400" />
                <span className="text-sm font-semibold">Est. Rentals</span>
              </button>
            </div>
          </FilterSection>

          <button
            onClick={handleReset}
            className="w-full py-3 text-xs font-semibold text-gray-400 hover:text-white transition-colors flex items-center justify-center gap-2 bg-[#121620] border border-white/[0.06] rounded-xl"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset all filters
          </button>
        </aside>

        {/* Map + Report */}
        <main className="flex-1 flex flex-col min-h-0 overflow-y-auto">
          <div className="p-4 lg:p-6">
            {/* Map */}
            <div className="relative w-full aspect-[4/3] min-h-[420px] max-h-[760px] print:hidden no-print">
              <div className="absolute inset-0 bg-[#121620] border border-white/[0.06] rounded-2xl shadow-2xl p-3 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between mb-3 px-1">
                  <div className="flex items-center gap-2 text-gray-400">
                    <TrendingUp className="w-4 h-4" />
                    <span className="text-xs font-bold uppercase tracking-wider">Interactive Map</span>
                    <span className="text-xs text-gray-500 hidden sm:inline">
                      {loadingCSV ? (
                        csvProgress && csvProgress.total > 0
                          ? `Loading CSV ${csvProgress.loaded}/${csvProgress.total}…`
                          : 'Loading market data…'
                      ) : (
                        `${filteredData.length.toLocaleString()} properties · ${Object.keys(metricValues).length} areas`
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={multiSelect}
                        onChange={(e) => setMultiSelect(e.target.checked)}
                        className="rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500"
                      />
                      Multi-select
                    </label>
                    <WindowSelector active={activeWindows} onChange={setActiveWindows} />
                  </div>
                </div>

                <div data-tour="map" className="flex-1 relative rounded-xl overflow-hidden border border-white/[0.06] min-h-0">
                  <DraggableMapWindows
                    metric={metric}
                    metricLabel={METRICS.find((m) => m.key === metric)?.label || metric}
                    reportStats={reportStats}
                    marketHealth={marketHealth}
                    timeSeries={timeSeries}
                    forecast={forecast}
                    forecastComparison={forecastComparison}
                    chartData={chartData}
                    yearBuiltData={yearBuiltData}
                    boundary={boundary}
                    active={activeWindows}
                    visible={reportGenerated && selectedIds.length > 0}
                    isLoading={!dataReady}
                    onClose={(key) => setActiveWindows(activeWindows.filter((k) => k !== key))}
                  />
                  <MapComponent
                    boundary={boundary}
                    metricValues={effectiveMetricValues}
                    sampleCounts={effectiveSampleCounts}
                    nameMap={effectiveNameMap}
                    colorStops={colorStops}
                    multiSelect={multiSelect}
                    selectedIds={selectedIds}
                    onSelectionChange={(ids) => setSelectedIds(ids)}
                    rawData={filteredData}
                    showSales={layerSales}
                    showRentals={layerRentals}
                    showFlood={false}
                    metricLabel={METRICS.find((m) => m.key === metric)?.label || metric}
                    fillOpacity={fillOpacity}
                    onClear={() => setSelectedIds([])}
                    onGenerateReport={generateReport}
                    reportGenerated={reportGenerated}
                  />
                </div>
              </div>
            </div>

            {reportGenerated && selectedIds.length > 0 && (
              <div data-tour="report" ref={reportRef} className="mt-6 scroll-mt-6 analysis-panel">
                <ReportPanel
                  metric={metric}
                  metricLabel={METRICS.find((m) => m.key === metric)?.label || metric}
                  selectedNames={selectedNames}
                  reportStats={reportStats}
                  marketHealth={marketHealth}
                  timeSeries={timeSeries}
                  forecast={forecast}
                  forecastComparison={forecastComparison}
                  chartData={chartData}
                  yearBuiltData={yearBuiltData}
                  boundary={boundary}
                  onHide={clearReport}
                  isLoading={!dataReady}
                  pinnedWindows={activeWindows}
                  onToggleWindow={(key) => {
                    if (activeWindows.includes(key)) {
                      setActiveWindows(activeWindows.filter((k) => k !== key));
                    } else if (activeWindows.length < 3) {
                      setActiveWindows([...activeWindows, key]);
                    }
                  }}
                />
              </div>
            )}
          </div>
        </main>
      </div>

      <TourModal open={showTour} onClose={() => setShowTour(false)} />
      <AccountModal open={showAccountModal} onClose={() => setShowAccountModal(false)} mode={accountModalMode} />

      {/* AI Chatbot Floating Button */}
      <div data-tour="chat" className="fixed bottom-6 right-6 z-[1001] flex flex-col items-end print:hidden">
        {showChatbot && (
          <div className="mb-4 w-80 h-96 bg-[#1a1f2e] border border-white/[0.06] rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in slide-in-from-bottom-5">
            <div className="bg-blue-600 p-4 flex items-center justify-between">
              <span className="text-white font-bold text-sm">Kwizi AI Assistant</span>
              <button onClick={() => setShowChatbot(false)} className="text-white/80 hover:text-white">&times;</button>
            </div>
            <div className="flex-1 p-4 flex flex-col justify-center items-center text-center text-gray-400 gap-3">
              <MessageSquare className="w-8 h-8 opacity-50" />
              <p className="text-sm">I can help you filter areas, find trends, and build reports.</p>
              <span className="text-xs bg-white/5 px-3 py-1 rounded-full border border-white/[0.06]">Coming Soon</span>
            </div>
            <div className="p-3 bg-[#121620] border-t border-white/[0.06]">
              <input
                disabled
                type="text"
                placeholder="Ask a question..."
                className="w-full bg-[#1a1f2e] border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-white opacity-50 cursor-not-allowed"
              />
            </div>
          </div>
        )}
        <button
          onClick={() => setShowChatbot(!showChatbot)}
          className="bg-blue-600 hover:bg-blue-700 text-white p-4 rounded-full shadow-2xl transition-transform hover:scale-110 flex items-center justify-center"
        >
          <MessageSquare className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
}
