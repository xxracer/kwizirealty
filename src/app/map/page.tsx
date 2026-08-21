'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import ReportPanel from '@/components/ReportPanel';
import TourModal from '@/components/TourModal';
import AccountModal from '@/components/AccountModal';
import CollapsibleFilterSection from '@/components/CollapsibleFilterSection';
import DraggableMapWindows, { WindowSelector, useDraggableWindows } from '@/components/DraggableMapWindows';
import HommieChat from '@/components/HommieChat';
import {
  PropertyData,
  BoundaryKey,
  MetricKey,
  PropertyFilters,
  DEFAULT_FILTERS,
  engine,
  cleanBoundaryName,
} from '@/lib/engine';
import { db } from '@/lib/firebase';
import { collection, query, where, getDocs, limit } from 'firebase/firestore';
import type { AdCampaign } from '@/components/admin/AdminAds';
import { motion, AnimatePresence } from 'framer-motion';
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
  { key: 'areas', name: 'Custom Areas', short: 'Custom', premium: false },
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

export default function MapPage() {
  const [boundary, setBoundary] = useState<BoundaryKey>('subdivisions');
  const [metric, setMetric] = useState<MetricKey>('Close Price');
  // Property data is no longer loaded on page load. We keep only the tiny
  // boundary snapshots and GeoJSON in memory for instant map rendering. The full
  // CSV rows are fetched on demand when the user clicks Generate Report for the
  // selected areas, so memory stays low and the page loads fast.
  const [reportPhase, setReportPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [reportProgress, setReportProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportGeneration, setReportGeneration] = useState(0);
  const [showReportModal, setShowReportModal] = useState(false);

  const [initialMetrics, setInitialMetrics] = useState<
    Partial<Record<BoundaryKey, { values: Record<string, number>; counts: Record<string, number> }>> | null
  >(null);

  const [filters, setFilters] = useState<PropertyFilters>(DEFAULT_FILTERS);

  const [layerSales, setLayerSales] = useState(false);
  const [layerRentals, setLayerRentals] = useState(false);
  const [layerFlood, setLayerFlood] = useState(false);

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

  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountModalMode, setAccountModalMode] = useState<'account' | 'save'>('account');

  const { active: activeWindows, setActive: setActiveWindows } = useDraggableWindows();
  const [activeAd, setActiveAd] = useState<AdCampaign | null>(null);
  const [showAd, setShowAd] = useState(true);

  useEffect(() => {
    const fetchAd = async () => {
      try {
        const q = query(collection(db, 'ads'), where('status', '==', 'active'), limit(1));
        const snapshot = await getDocs(q);
        if (!snapshot.empty) {
          setActiveAd({ id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as AdCampaign);
        }
      } catch (err) {
        console.error('Error fetching ad', err);
      }
    };
    fetchAd();
  }, []);

  const isMobile = useMediaQuery('(max-width: 1024px)');
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
    if (!initialMetrics?.[boundary]) return;
    for (const b of BOUNDARIES) {
      if (b.key !== boundary && !initialMetrics?.[b.key]) {
        loadMetricsForBoundary(b.key);
      }
    }
  }, [boundary, initialMetrics, loadMetricsForBoundary]);

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
    if (selectedIds.length === 0) {
      setReportGenerated(false);
      setReportPhase('idle');
      setReportProgress(null);
    }
  }, [selectedIds]);

  useEffect(() => {
    // Changing boundary invalidates the current selection and report data.
    setSelectedIds([]);
    setReportGenerated(false);
    setReportPhase('idle');
    setReportProgress(null);
    setReportError(null);
  }, [boundary]);

  const filteredData = useMemo(() => {
    if (reportPhase !== 'ready') return [];
    return engine.filterProperties(filters);
  }, [reportPhase, filters, reportGeneration]);

  const { values: metricValues, counts: sampleCounts, names: nameMap } = useMemo(() => {
    return engine.getMapValues(filteredData, boundary, metric);
  }, [filteredData, boundary, metric, reportGeneration]);

  const dataReady = reportPhase === 'ready' && filteredData.length > 0;

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
    const full = engine.getForecastForSelection(filteredData, boundary, metric, selectedIds);
    // Sort by baseline descending to get the top 5 areas
    return full.sort((a, b) => b.baseline - a.baseline).slice(0, 5);
  }, [filteredData, boundary, metric, selectedIds, dataReady]);

  const chartData = useMemo(() => {
    if (!dataReady) return [];
    return Object.entries(metricValues)
      .filter(([k]) => selectedIds.length === 0 || selectedIds.includes(k))
      .map(([name, value]) => ({ name: cleanBoundaryName(name), value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
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
    
    // First, try searching through the currently loaded properties (if a report is generated)
    let matches: string[] = [];
    if (filteredData.length > 0) {
      matches = filteredData
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
    } else {
      // If no properties loaded, search the boundary names directly
      const availableKeys = Object.keys(initialMetrics?.[boundary]?.values || {});
      matches = availableKeys.filter(k => k.toUpperCase().includes(q));
    }
    
    const unique = Array.from(new Set(matches));
    setSelectedIds(unique);
  }, [searchQuery, filteredData, boundary, initialMetrics]);

  const uniquePropertyTypes = useMemo(() => engine.getUniqueValues('propertyType'), [reportGeneration]);
  const uniqueCities = useMemo(() => engine.getUniqueValues('city').slice(0, 120), [reportGeneration]);
  const uniqueDistricts = useMemo(() => engine.getUniqueValues('schoolDistrict').slice(0, 80), [reportGeneration]);
  const uniqueElementary = useMemo(() => engine.getUniqueValues('elementary').slice(0, 80), [reportGeneration]);
  const uniqueMiddle = useMemo(() => engine.getUniqueValues('middle').slice(0, 80), [reportGeneration]);
  const uniqueHigh = useMemo(() => engine.getUniqueValues('highschools').slice(0, 80), [reportGeneration]);

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
    setReportPhase('idle');
    setReportError(null);
    setReportProgress(null);
    setActiveWindows([]);
  }, [setActiveWindows]);

  const handleAreaSelectFromChat = useCallback((queries: string[]) => {
    if (!queries || queries.length === 0) return;
    
    // Convert to lowercase for fuzzy matching
    const normalizedQueries = queries.map(q => q.toLowerCase().trim());
    const matchedIds: string[] = [];

    // Search through effectiveNameMap
    Object.entries(effectiveNameMap).forEach(([id, name]) => {
      const normalizedName = name.toLowerCase();
      // If the feature name includes the query or vice-versa
      const isMatch = normalizedQueries.some(q => 
        normalizedName.includes(q) || q.includes(normalizedName)
      );
      if (isMatch) {
        matchedIds.push(id);
      }
    });

    if (matchedIds.length > 0) {
      // Add the matched IDs to the current selection, without duplicating
      setSelectedIds(prev => Array.from(new Set([...prev, ...matchedIds])));
    }
  }, [effectiveNameMap]);

  const generateReport = useCallback(() => {
    if (reportPhase === 'loading') return;
    if (selectedIds.length === 0) {
      setReportError('Select one or more areas on the map to generate a report.');
      setTimeout(() => setReportError(null), 4000);
      return;
    }
    setReportPhase('loading');
    setReportError(null);
    setReportProgress(null);
    setShowReportModal(true);
    engine
      .loadDataForSelection(boundary, selectedIds, (loaded, total) => setReportProgress({ loaded, total }))
      .then((result) => {
        if (result.ok) {
          setReportPhase('ready');
          setReportGeneration((g) => g + 1);
          setReportGenerated(true);
        } else {
          setReportPhase('error');
          setReportError(result.error || 'Could not load report data.');
        }
      })
      .catch((err) => {
        setReportPhase('error');
        setReportError(err?.message || 'Unexpected error loading report data.');
      });
    // When no boxes are pinned, default to Quick Stats + Market Health
    if (activeWindows.length === 0) {
      setActiveWindows(['quick-stats', 'market-health']);
    }
  }, [activeWindows.length, boundary, selectedIds, setActiveWindows]);

  const clearReport = useCallback(() => {
    setReportGenerated(false);
    setReportPhase('idle');
    setReportError(null);
    setReportProgress(null);
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
          {reportPhase === 'loading' && reportProgress && (
            <div className="flex flex-col gap-1 mr-2 min-w-[140px]">
              <div className="flex items-center justify-between text-[10px] text-blue-300">
                <span>Loading report data {reportProgress.loaded}/{reportProgress.total}</span>
                <span>{Math.round((reportProgress.loaded / reportProgress.total) * 100)}%</span>
              </div>
              <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${(reportProgress.loaded / reportProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}
          {reportPhase === 'loading' && !reportProgress && (
            <div className="flex items-center gap-2 text-blue-300 text-sm mr-2">
              <div className="w-4 h-4 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
              <span className="hidden sm:inline">Loading report data…</span>
            </div>
          )}
          {reportError && (
            <div className="flex items-center gap-2 text-red-400 text-xs mr-2 max-w-[240px]">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span className="truncate" title={reportError}>{reportError}</span>
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
          {reportPhase === 'loading' ? (
            <span className="flex items-center gap-2 text-blue-300 text-xs">
              <span className="w-3.5 h-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
              {reportProgress && reportProgress.total > 0
                ? `Loading report data ${reportProgress.loaded}/${reportProgress.total}…`
                : 'Loading report data…'}
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
            <div className="relative">
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value as MetricKey)}
                className="w-full bg-white/5 border border-white/[0.06] text-white text-sm rounded-xl px-3 py-2.5 pr-10 outline-none focus:border-blue-500 appearance-none"
              >
                {METRICS.map((m) => (
                  <option key={m.key} value={m.key} className="bg-[#121620]">
                    {m.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
          </FilterSection>

          {/* Period */}
          <FilterSection icon={<CalendarDays className="w-4 h-4 text-amber-400" />} title="Close Period" defaultOpen={false}>
            <div className="relative">
              <select
                value={filters.period}
                onChange={(e) => handleFilterChange('period', e.target.value as PropertyFilters['period'])}
                className="w-full bg-white/5 border border-white/[0.06] text-white text-sm rounded-xl px-3 py-2.5 pr-10 outline-none focus:border-blue-500 appearance-none"
              >
                {PERIODS.map((p) => (
                  <option key={p.key} value={p.key} className="bg-[#121620]">
                    {p.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
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
                    value="Single Family, Free Standing"
                    disabled
                    onChange={() => {}}
                    className="w-full bg-white/5 border border-white/[0.06] text-white text-xs rounded-lg px-2 py-1.5 outline-none opacity-50 cursor-not-allowed"
                  >
                    <option value="Single Family, Free Standing" className="bg-[#121620]">
                      Single Family, Free Standing
                    </option>
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
              <button
                onClick={() => setLayerFlood(!layerFlood)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all ${
                  layerFlood
                    ? 'bg-white/15 border-white/20 text-white'
                    : 'bg-black/40 border-white/[0.06] text-gray-400 hover:bg-white/10'
                }`}
              >
                <MapPin className="w-4 h-4 text-blue-400" />
                <span className="text-sm font-semibold">Flood Zones</span>
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
                      {reportPhase === 'loading' ? (
                        reportProgress && reportProgress.total > 0
                          ? `Loading report data ${reportProgress.loaded}/${reportProgress.total}…`
                          : 'Loading report data…'
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
                    onSet90Days={() => handleFilterChange('period', '90d')}
                    is90Days={filters.period === '90d'}
                  />

                  <AnimatePresence>
                    {activeAd && showAd && (
                      <motion.div
                        initial={{ opacity: 0, y: 20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 20, scale: 0.95 }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed bottom-6 left-6 z-[100] w-64 md:w-72 shadow-2xl rounded-2xl overflow-hidden bg-slate-900 border border-slate-700/50"
                      >
                        <button
                          onClick={() => setShowAd(false)}
                          className="absolute top-2 right-2 z-10 p-1 bg-black/50 hover:bg-black/80 rounded-full text-white backdrop-blur-sm transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                        <a href={activeAd.targetUrl} target="_blank" rel="noreferrer" className="block relative aspect-video bg-black group">
                          {activeAd.mediaType === 'video' ? (
                            <video src={activeAd.mediaUrl} className="w-full h-full object-cover" muted loop autoPlay playsInline />
                          ) : (
                            <img src={activeAd.mediaUrl} alt={activeAd.title} className="w-full h-full object-cover" />
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-4">
                            <span className="text-white text-sm font-bold truncate drop-shadow-md">
                              {activeAd.title}
                            </span>
                          </div>
                        </a>
                        <div className="bg-slate-900 px-4 py-2 flex items-center justify-between">
                          <span className="text-xs text-slate-400 font-medium">Sponsored</span>
                          <a href={activeAd.targetUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:text-blue-300 font-bold transition-colors">
                            Learn More
                          </a>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <HommieChat
                    boundary={boundary}
                    metricLabel={METRICS.find((m) => m.key === metric)?.label || metric}
                    reportStats={reportStats}
                    marketHealth={marketHealth}
                    selectedIds={selectedIds}
                    onAreaSelect={handleAreaSelectFromChat}
                    onGenerateReport={generateReport}
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
                    showFlood={layerFlood}
                    metricLabel={METRICS.find((m) => m.key === metric)?.label || metric}
                    fillOpacity={fillOpacity}
                    onClear={() => setSelectedIds([])}
                    onGenerateReport={generateReport}
                    reportGenerated={reportGenerated}
                    isReportLoading={reportPhase === 'loading'}
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

      {/* Floating Chatbot / Assistant */}
      <div className="print:hidden">
        <HommieChat
          boundary={boundary}
          metricLabel={METRICS.find((m) => m.key === metric)?.label || metric}
          reportStats={reportStats}
          marketHealth={marketHealth}
          selectedIds={selectedIds}
          onAreaSelect={handleAreaSelectFromChat}
          onGenerateReport={generateReport}
        />
      </div>
    </div>
  );
}
