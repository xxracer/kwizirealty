'use client';

import { useState, useMemo, useEffect, useCallback, useRef, useDeferredValue } from 'react';
import SimpleSelect from '@/components/SimpleSelect';
import Link from 'next/link';
import ReportPanel from '@/components/ReportPanel';
import TourModal from '@/components/TourModal';
import AccountModal from '@/components/AccountModal';
import CollapsibleFilterSection from '@/components/CollapsibleFilterSection';
import DraggableMapWindows, { WindowSelector, useDraggableWindows } from '@/components/DraggableMapWindows';
import HommieChat from '@/components/HommieChat';
import { RequireAuth } from '@/components/RequireAuth';
import { useAuth } from '@/lib/authContext';
import {
  PropertyData,
  BoundaryKey,
  MetricKey,
  PropertyFilters,
  DEFAULT_FILTERS,
  engine,
  cleanBoundaryName,
} from '@/lib/engine';
import {
  isSQLEnabled,
  hasActiveFilters,
  resolveRatingFilters,
  periodToWindow,
  fetchSqlAggregates,
  type SqlAggregates,
} from '@/lib/sqlData';
import { resolveQueriesToZips } from '@/lib/areaAliases';
import { METRICS } from '@/lib/metrics';
import { cmsStore, type CMSMetricOverride } from '@/lib/cmsStore';
import { db } from '@/lib/firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import type { AdCampaign } from '@/components/admin/AdminAds';
import { motion, AnimatePresence } from 'framer-motion';
import dynamic from 'next/dynamic';
import {
  Search,
  SlidersHorizontal,
  Map as MapIcon,
  CalendarDays,
  Bed,
  X,
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
  Check,
  Star,
  Loader2,
  Filter,
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
  return (
    <RequireAuth redirectTo="/map">
      <MapPageInner />
    </RequireAuth>
  );
}

/**
 * Ad creative card — Google-ads style: every variant lives AROUND the map in
 * normal document flow, never floating on top of it.
 *   `inline-top` / `inline-bottom` — thin banner strips above/below the map.
 *   `side-left` / `side-right`    — vertical banner columns beside the map
 *                                   (hidden on phones, where side banners
 *                                   would crush the map — same as Google).
 * The whole card is one anchor; "Learn More" is a span so we never nest <a>.
 */
function AdCard({
  ad,
  variant,
  onClose,
}: {
  ad: AdCampaign;
  variant: 'inline-top' | 'inline-bottom' | 'side-left' | 'side-right';
  onClose: () => void;
}) {
  const inline = variant === 'inline-top' || variant === 'inline-bottom';
  const className = inline
    ? `relative mx-auto w-full max-w-[64rem] h-16 sm:h-20 rounded-xl overflow-hidden bg-slate-900 border border-slate-700/50 shadow-2xl print:hidden no-print ${
        variant === 'inline-top' ? 'mb-2' : 'mt-2'
      }`
    : 'relative hidden sm:block w-24 md:w-32 lg:w-40 self-stretch rounded-xl overflow-hidden bg-slate-900 border border-slate-700/50 shadow-2xl print:hidden no-print';

  return (
    <motion.div
      initial={{ opacity: 0, y: inline ? (variant === 'inline-top' ? -12 : 12) : 0 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: inline ? (variant === 'inline-top' ? -12 : 12) : 0 }}
      transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      className={className}
    >
      <button
        onClick={onClose}
        className="absolute top-1.5 right-1.5 z-10 p-1 bg-black/50 hover:bg-black/80 rounded-full text-white backdrop-blur-sm transition-colors"
      >
        <X className="w-3 h-3" />
      </button>
      <a href={ad.targetUrl} target="_blank" rel="noreferrer" className="block relative bg-black group h-full">
        {ad.mediaType === 'video' ? (
          <video src={ad.mediaUrl} className="w-full h-full object-cover" muted loop autoPlay playsInline />
        ) : (
          <img src={ad.mediaUrl} alt={ad.title} className="w-full h-full object-cover" />
        )}
        {inline ? (
          <>
            {/* Thin-banner overlay: gradient only on the left third so the
                creative stays visible, Sponsored + title on one line. */}
            <div className="absolute inset-y-0 left-0 w-2/3 bg-gradient-to-r from-black/80 to-transparent flex items-center gap-2 pl-3 pr-8">
              <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold text-slate-300 bg-black/60 border border-white/10 rounded px-1.5 py-0.5">
                Sponsored
              </span>
              <span className="text-white text-[11px] sm:text-xs font-bold truncate drop-shadow-md">
                {ad.title}
              </span>
            </div>
            <span className="absolute bottom-1.5 right-2 text-[10px] text-blue-300 font-bold drop-shadow-md">
              Learn More →
            </span>
          </>
        ) : (
          <>
            {/* Side banner (skyscraper): label + title stacked at the bottom. */}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2 pt-6 flex flex-col gap-1">
              <span className="self-start text-[8px] uppercase tracking-wider font-bold text-slate-300 bg-black/60 border border-white/10 rounded px-1 py-0.5">
                Sponsored
              </span>
              <span className="text-white text-[11px] font-bold leading-snug line-clamp-3 drop-shadow-md">
                {ad.title}
              </span>
              <span className="text-[10px] text-blue-300 font-bold">Learn More →</span>
            </div>
          </>
        )}
      </a>
    </motion.div>
  );
}

// Closed ads stay hidden for 3 minutes; the timestamps live in localStorage
// under this key so the close survives page reloads.
const AD_RESHOW_MS = 3 * 60 * 1000;
const AD_CLOSE_KEY = 'kwizi_closed_ads';

function MapPageInner() {
  const { user } = useAuth();
  const [boundary, setBoundary] = useState<BoundaryKey>('subdivisions');
  const [metric, setMetric] = useState<MetricKey>('Close Price');
  // Aggregates resolved server-side via /api/query (Firebase SQL Connect) when
  // the user has active filters or a report selection. null = use the client
  // engine (no SQL, fetch in-flight, or SQL errored → graceful fallback).
  const [sqlAgg, setSqlAgg] = useState<SqlAggregates | null>(null);
  // CMS metric overrides (boundary+metric → value), applied to the SQL-returned
  // map values to mirror engine.getMapValues' override pass (the server rows
  // are raw — overrides live client-side).
  const [cmsOverrides, setCmsOverrides] = useState<CMSMetricOverride[]>([]);
  useEffect(() => {
    let cancelled = false;
    cmsStore
      .listOverrides()
      .then((o) => {
        if (!cancelled) setCmsOverrides(o);
      })
      .catch(() => {
        /* overrides are best-effort — ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Property data is no longer loaded on page load. We keep only the tiny
  // boundary snapshots and GeoJSON in memory for instant map rendering. The full
  // CSV rows are fetched on demand when the user clicks Generate Report for the
  // selected areas, so memory stays low and the page loads fast.
  const [reportPhase, setReportPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  // What triggered the current 'loading' phase: streaming the dataset for the
  // map ("Loading Data…") or building a report for selected areas
  // ("Generating Report…"). The map overlay must not lie about which one.
  const [dataLoadKind, setDataLoadKind] = useState<'data' | 'report'>('data');
  const [reportProgress, setReportProgress] = useState<{ loaded: number; total: number } | null>(null);
  // When the chat asks us to generate a report right after selecting areas,
  // we set this flag. A useEffect below watches selectedIds and fires the
  // report once the selection state has actually been committed to React.
  const [pendingReport, setPendingReport] = useState(false);
  // Ref mirrored from pendingReport — generateReport() reads this when it
  // finishes so we only announce "report ready" in the chat when the report
  // was triggered from the chat (not when the user clicked the button).
  const reportFromChatRef = useRef(false);
  // Bumped when a chat-triggered report finishes, prompting HommieChat to
  // append a local "your report is ready" message.
  const [reportReadyMsg, setReportReadyMsg] = useState<{ id: number; text: string } | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportGeneration, setReportGeneration] = useState(0);
  const [showReportModal, setShowReportModal] = useState(false);

  const [initialMetrics, setInitialMetrics] = useState<
    Partial<Record<BoundaryKey, { values: Record<string, number>; counts: Record<string, number> }>> | null
  >(null);

  // Names + ZIPs per boundary feature, loaded directly from the GeoJSON so the
  // chatbot can resolve queries like "Tomball" → TOMBALL TERRACE / TOMBALL
  // HEIGHTS even when the CSV hasn't been loaded yet (dataReady=false). Without
  // this fallback, effectiveNameMap is {} until a report has been generated
  // and the chat can't match anything.
  const [boundaryLookup, setBoundaryLookup] = useState<
    Partial<Record<BoundaryKey, Record<string, { name: string; zip?: string }>>>
  >({});

  // Controls edit this DRAFT; the heavy polygon recompute only runs when the
  // user commits with "Apply Filters". Programmatic changes (chat bot, reset,
  // 90-days toggle) apply immediately.
  const [filters, setFilters] = useState<PropertyFilters>(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<PropertyFilters>(DEFAULT_FILTERS);
  // True while the "Applying filters…" popup is up — i.e. the heavy recompute
  // triggered by Apply hasn't settled yet.
  const [filtersApplying, setFiltersApplying] = useState(false);

  const [layerSales, setLayerSales] = useState(false);
  const [layerRentals, setLayerRentals] = useState(false);
  const [layerFlood, setLayerFlood] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [multiSelect, setMultiSelect] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  /** Bumped when the search finds a match so the map flies to the selection. */
  const [searchFocusTick, setSearchFocusTick] = useState(0);
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
  // Every active ad campaign, one per placement slot (top/bottom/right/corner).
  const [activeAds, setActiveAds] = useState<AdCampaign[]>([]);
  // Ads the user closed stay hidden for 3 minutes — per browser (localStorage),
  // so a reload doesn't bring them back immediately. After 3 minutes they
  // reappear automatically. Map of campaign id → close timestamp (ms).
  const [closedAdIds, setClosedAdIds] = useState<Set<string>>(new Set());

  // Restore closes from a previous visit on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(AD_CLOSE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, number>;
      const now = Date.now();
      const stillClosed = new Set(
        Object.entries(parsed)
          .filter(([, ts]) => now - ts < AD_RESHOW_MS)
          .map(([id]) => id)
      );
      if (stillClosed.size > 0) setClosedAdIds(stillClosed);
    } catch {
      /* corrupted storage — ignore, ads just show again */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-evaluate every 15s: once 3 minutes pass, closed ads come back.
  useEffect(() => {
    const id = setInterval(() => {
      setClosedAdIds((prev) => {
        if (prev.size === 0) return prev;
        try {
          const parsed = JSON.parse(localStorage.getItem(AD_CLOSE_KEY) || '{}') as Record<string, number>;
          const now = Date.now();
          const next = new Set([...prev].filter((cid) => now - (parsed[cid] ?? now) < AD_RESHOW_MS));
          return next.size === prev.size ? prev : next;
        } catch {
          return new Set<string>();
        }
      });
    }, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const fetchAd = async () => {
      try {
        const q = query(collection(db, 'ads'), where('status', '==', 'active'));
        const snapshot = await getDocs(q);
        setActiveAds(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as AdCampaign[]);
      } catch (err) {
        console.error('Error fetching ad', err);
      }
    };
    fetchAd();
  }, []);

  // First active campaign per placement (legacy ads without a placement fall
  // into the corner slot).
  const adsByPlacement = useMemo(() => {
    const by: Partial<Record<NonNullable<AdCampaign['placement']>, AdCampaign>> = {};
    for (const ad of activeAds) {
      const p = ad.placement || 'corner';
      if (!by[p]) by[p] = ad;
    }
    return by;
  }, [activeAds]);

  const closeAd = useCallback((id: string) => {
    setClosedAdIds((prev) => new Set(prev).add(id));
    // Persist with a timestamp so the close survives reloads and expires
    // (ad reappears) after 3 minutes.
    try {
      const parsed = JSON.parse(localStorage.getItem(AD_CLOSE_KEY) || '{}') as Record<string, number>;
      parsed[id] = Date.now();
      localStorage.setItem(AD_CLOSE_KEY, JSON.stringify(parsed));
    } catch {
      /* storage unavailable — close just lasts for the session */
    }
  }, []);

  const isMobile = useMediaQuery('(max-width: 1024px)');
  const loadMetricsForBoundary = useCallback(
    async (key: BoundaryKey) => {
      if (initialMetrics?.[key] || key === 'areas') return;
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

  // Load the active boundary's GeoJSON and build an id → {name, zip} lookup so
  // the chat can resolve city/area names even before the CSV report is ready.
  useEffect(() => {
    if (!boundary || boundary === 'areas') return;
    if (boundaryLookup[boundary]) return;
    let cancelled = false;
    (async () => {
      try {
        const fc = await engine.fetchGzJson<GeoJSON.FeatureCollection>(
          `/geojson/${boundary}.geojson.gz`
        );
        if (cancelled || !fc?.features) return;
        const lookup: Record<string, { name: string; zip?: string }> = {};
        for (const feat of fc.features) {
          const props = (feat.properties || {}) as Record<string, unknown>;
          const rawName =
            (props.NAME as string) ||
            (props.Name as string) ||
            (props.name as string) ||
            (props.Subdivision as string) ||
            (props.id as string) ||
            '';
          const key = cleanBoundaryName(rawName);
          if (!key) continue;
          const zipRaw =
            (props.Zip_Code as number | string) ??
            (props.zipcode as number | string) ??
            (props.ZIP as number | string);
          const zip = zipRaw != null ? String(zipRaw).padStart(5, '0') : undefined;
          lookup[key] = { name: rawName || key, zip };
        }
        setBoundaryLookup((prev) => ({ ...prev, [boundary]: lookup }));
      } catch (err) {
        // Silent — chat will just fall back to the empty map if the GeoJSON
        // can't be loaded.
        console.warn(`[Kwizi Map] failed to load boundary GeoJSON for ${boundary}`, err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boundary, boundaryLookup]);

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

  // Load (or re-load) the full dataset into the engine. Until it lands, every
  // filter that acts on real rows — Market Metric, Property Filters, Scale
  // Range, period — looks dead because the map colors come from the static
  // per-boundary snapshot. Called on mount, after a boundary change and after
  // a reset so the live data path is always restored (it's instant once the
  // engine already holds the full dataset).
  const loadFullData = useCallback(() => {
    setDataLoadKind('data');
    setReportError(null);
    setReportPhase('loading');
    engine
      .loadAllCSV(false, (loaded, total) => setReportProgress({ loaded, total }))
      .then((result) => {
        if (result.ok) {
          setReportPhase('ready');
          setReportGeneration((g) => g + 1);
          setReportError(null);
        } else {
          // Keep the snapshot view, but SAY IT: a silent failure here is what
          // made the map look like filters do nothing — without the dataset
          // the polygons can only show the static snapshot.
          setReportPhase('idle');
          setReportProgress(null);
          setReportError(`Dataset load failed: ${result.error || 'unknown error'}. Filters are inactive until the data loads.`);
        }
      })
      .catch((err) => {
        setReportPhase('idle');
        setReportProgress(null);
        const msg = err instanceof Error ? err.message : String(err);
        setReportError(`Dataset load failed: ${msg}. Filters are inactive until the data loads.`);
      });
  }, []);

  useEffect(() => {
    if (selectedIds.length === 0) {
      setReportGenerated(false);
      // Re-prime the full dataset instead of staying idle: otherwise clearing
      // the selection (or a boundary change) would drop the map back onto the
      // static snapshot and make every filter look dead again.
      loadFullData();
    }
  }, [selectedIds, loadFullData]);

  useEffect(() => {
    // Changing boundary invalidates the current selection and report data.
    setSelectedIds([]);
    setReportGenerated(false);
    setReportPhase('idle');
    setReportProgress(null);
    setReportError(null);
    // A pending chat report no longer has its selection — cancel it instead of
    // letting it fire later against whatever the user selects manually.
    setPendingReport(false);
    reportFromChatRef.current = false;
    loadFullData();
  }, [boundary, loadFullData]);

  // The full filter pipeline (filterProperties + all aggregations + map
  // rebuilds) processes ~763k rows synchronously. It reads APPLIED filters —
  // draft edits wait for the Apply Filters button. useDeferredValue still
  // coalesces any burst into a single pass.
  const deferredAppliedFilters = useDeferredValue(appliedFilters);

  // SQL Connect path. When the user has active filters (or a report selection)
  // and SQL is enabled, the aggregates are resolved server-side via /api/query
  // instead of re-scanning the 763k rows in RAM. If the fetch fails, sqlFailed
  // flips and the client engine below takes over exactly as before.
  const [sqlFailed, setSqlFailed] = useState(false);
  const useSql = isSQLEnabled() && !sqlFailed && (hasActiveFilters(deferredAppliedFilters) || selectedIds.length > 0);

  useEffect(() => {
    if (!useSql) {
      setSqlAgg(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const resolved = resolveRatingFilters(engine, deferredAppliedFilters);
        const { startTs, endTs } = periodToWindow(deferredAppliedFilters.period, engine.getReferenceDate());
        const token = await user?.getIdToken();
        if (!token) return; // not signed in — fall back to the client engine
        const agg = await fetchSqlAggregates(
          deferredAppliedFilters,
          resolved,
          boundary,
          metric,
          selectedIds,
          startTs,
          endTs,
          token
        );
        if (cancelled) return;
        if (agg) {
          setSqlFailed(false);
          setSqlAgg(agg);
        } else {
          setSqlFailed(true);
          setSqlAgg(null);
        }
      } catch {
        if (!cancelled) {
          setSqlFailed(true);
          setSqlAgg(null);
        }
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [useSql, deferredAppliedFilters, boundary, metric, selectedIds, user]);

  // A new filter attempt retries SQL (a transient failure shouldn't disable it
  // for the whole session).
  useEffect(() => {
    setSqlFailed(false);
  }, [filters]);

  const filteredData = useMemo(() => {
    if (useSql) return [];
    if (reportPhase !== 'ready') return [];
    return engine.filterProperties(deferredAppliedFilters);
  }, [useSql, reportPhase, deferredAppliedFilters, reportGeneration]);

  const { values: metricValues, counts: sampleCounts, names: nameMap } = useMemo(() => {
    if (useSql) {
      const values = { ...(sqlAgg?.mapValues.values ?? {}) };
      // Apply CMS metric overrides client-side (mirrors engine.getMapValues).
      cmsOverrides.forEach((o) => {
        if (o.boundary === boundary && o.metric === metric && values[o.boundaryId] !== undefined) {
          values[o.boundaryId] = o.value;
        }
      });
      return {
        values,
        counts: sqlAgg?.mapValues.counts ?? {},
        names: {},
      };
    }
    return engine.getMapValues(filteredData, boundary, metric);
  }, [useSql, sqlAgg, cmsOverrides, filteredData, boundary, metric, reportGeneration]);

  const dataReady = useSql ? !!sqlAgg : reportPhase === 'ready' && filteredData.length > 0;

  // Use the lightweight pre-computed snapshot for instant map coloring while
  // the full CSV dataset is still loading in the background.
  const effectiveMetricValues = dataReady
    ? metricValues
    : initialMetrics?.[boundary]?.values ?? {};
  const effectiveSampleCounts = dataReady
    ? sampleCounts
    : initialMetrics?.[boundary]?.counts ?? {};
  const effectiveNameMap = dataReady ? nameMap : {};

  // Seed the manual range inputs from the current data. While Auto scale is
  // on, the inputs track the dataset; the moment the user turns it off we
  // snapshot the current range once into the inputs so they start editing from
  // the real values, and from there on their typed range is never reset by
  // data updates (report ready, boundary change, period change, ...).
  const prevAutoScaleRef = useRef(autoScale);
  useEffect(() => {
    const reseed = prevAutoScaleRef.current !== autoScale ? true : autoScale;
    prevAutoScaleRef.current = autoScale;
    const vals = Object.values(effectiveMetricValues).filter((v) => isFinite(v));
    if (!vals.length || !reseed) return;
    setCustomMin(Math.min(...vals));
    setCustomMax(Math.max(...vals));
  }, [effectiveMetricValues, autoScale]);

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
    if (useSql) return sqlAgg?.reportStats ?? emptyStats;
    if (!dataReady) return emptyStats;
    return engine.getStatsForSelection(filteredData, boundary, selectedIds);
  }, [useSql, sqlAgg, dataReady, filteredData, selectedIds, boundary, emptyStats]);

  const marketHealth = useMemo(() => {
    if (useSql) return sqlAgg?.marketHealth ?? null;
    if (!dataReady) return null;
    const isRental =
      metric === 'Est. Rental Price' ||
      metric === 'Rental Price per Sqft' ||
      metric === 'Rental Days On Market' ||
      metric === 'Rent-to-Sale Ratio';
    return engine.getMarketHealth(filteredData, boundary, selectedIds, isRental ? 'rental' : 'sale');
  }, [useSql, sqlAgg, dataReady, filteredData, selectedIds, boundary, metric]);

  const timeSeries = useMemo(() => {
    if (useSql) return sqlAgg?.timeSeries ?? [];
    if (!dataReady) return [];
    return engine.getTimeSeries(filteredData, boundary, metric, selectedIds);
  }, [useSql, sqlAgg, dataReady, filteredData, boundary, metric, selectedIds]);

  const forecast = useMemo(() => {
    if (!timeSeries.length) return null;
    return engine.buildForecast(timeSeries);
  }, [timeSeries]);

  const forecastComparison = useMemo(() => {
    if (useSql) return sqlAgg?.forecastComparison ?? [];
    if (!dataReady) return [];
    const full = engine.getForecastForSelection(filteredData, boundary, metric, selectedIds);
    // Sort by baseline descending to get the top 5 areas
    return full.sort((a, b) => b.baseline - a.baseline).slice(0, 5);
  }, [useSql, sqlAgg, dataReady, filteredData, boundary, metric, selectedIds]);

  const chartData = useMemo(() => {
    if (!dataReady) return [];
    const source = useSql ? (sqlAgg?.mapValues.values ?? {}) : metricValues;
    return Object.entries(source)
      .filter(([k]) => selectedIds.length === 0 || selectedIds.includes(k))
      .map(([name, value]) => ({ name: cleanBoundaryName(name), value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [useSql, sqlAgg, metricValues, selectedIds, dataReady]);

  const yearBuiltData = useMemo(() => {
    if (useSql) return sqlAgg?.yearBuiltData ?? [];
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
  }, [useSql, sqlAgg, filteredData, selectedIds, boundary, dataReady]);

  // MapComponent only reads lat/lng from rawData (points + bounds), so when SQL
  // is active we hand it the capped point set from the server instead of the
  // full filtered rows.
  const mapRawData = useMemo(() => {
    if (useSql && sqlAgg) return sqlAgg.points as unknown as PropertyData[];
    return filteredData;
  }, [useSql, sqlAgg, filteredData]);

  // Property count shown in the map footer / report header. Under SQL the raw
  // rows aren't in the browser, so we use the server's report count (exact for
  // a selection, the capped sample otherwise).
  const displayPropertyCount = useMemo(() => {
    if (useSql) return sqlAgg?.reportStats.count ?? 0;
    return filteredData.length;
  }, [useSql, sqlAgg, filteredData]);

  const handleFilterChange = useCallback(
    (key: keyof PropertyFilters, value: number | string | string[]) => {
      setFilters((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  // True when the draft differs from what the map is currently showing.
  const filtersDirty = useMemo(
    () => JSON.stringify(filters) !== JSON.stringify(appliedFilters),
    [filters, appliedFilters]
  );

  // Commit the draft. The popup goes up IMMEDIATELY and the browser gets a
  // guaranteed 250ms to paint it BEFORE the ~763k-row recompute blocks the
  // main thread (rAF-based waiting was racy — the popup sometimes never
  // became visible). It stays at least MIN_APPLY_POPUP_MS after the swap.
  const MIN_APPLY_POPUP_MS = 900;
  const applyFilters = useCallback(() => {
    if (!filtersDirty) return;
    setFiltersApplying(true);
    setTimeout(() => {
      setAppliedFilters(filters);
      // If the dataset isn't in memory yet, fetch it now — applying a
      // filter must always end with live data on the map.
      if (reportPhase !== 'ready') loadFullData();
      // The heavy recompute happens during the render above; this timer
      // only starts counting once the main thread is free again.
      setTimeout(() => setFiltersApplying(false), MIN_APPLY_POPUP_MS);
    }, 250);
  }, [filters, filtersDirty, reportPhase, loadFullData]);

  // For changes that must take effect immediately (chat bot, toggles): apply
  // to BOTH the draft and the applied state in one go.
  const applyFiltersNow = useCallback(
    (updater: (prev: PropertyFilters) => PropertyFilters) => {
      setFilters(updater);
      setAppliedFilters(updater);
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

  const applySearch = useCallback((override?: string) => {
    const query = (override ?? searchQuery).trim();
    if (!query) {
      setSelectedIds([]);
      return;
    }
    const q = query.toUpperCase();
    const isZipQuery = /^\d{5}$/.test(q);

    // 1) Loaded property rows (after a report): match address / ZIP / city /
    //    subdivision and map back to the active boundary's keys.
    if (filteredData.length > 0) {
      const matches = filteredData
        .filter((d) => {
          const pid = engine.getBoundaryKey(boundary, d);
          const subdivs = Array.isArray(d.subdivisions)
            ? d.subdivisions.join(' ').toUpperCase()
            : String(d.subdivisions || '').toUpperCase();
          return (
            (!!pid && String(pid).toUpperCase().includes(q)) ||
            d.address.toUpperCase().includes(q) ||
            d.zip.toUpperCase().includes(q) ||
            d.city.toUpperCase().includes(q) ||
            subdivs.includes(q)
          );
        })
        .map((d) => engine.getBoundaryKey(boundary, d))
        .filter((k): k is string => !!k);
      if (matches.length > 0) {
        setSelectedIds(Array.from(new Set(matches)));
        setSearchFocusTick((t) => t + 1);
        return;
      }
    }

    // 2) Boundary features by name — boundaryLookup is loaded from the GeoJSON
    //    and works even before any report has been generated.
    const nameSource: Record<string, string> = {};
    for (const [id, info] of Object.entries(boundaryLookup[boundary] || {})) {
      nameSource[id] = info.name;
    }
    for (const [id, name] of Object.entries(effectiveNameMap || {})) {
      if (!nameSource[id]) nameSource[id] = name;
    }
    const matched = new Set<string>();
    for (const [id, name] of Object.entries(nameSource)) {
      const n = (name || '').toUpperCase();
      if (n && (n.includes(q) || q.includes(n))) matched.add(id);
    }

    // 3) ZIP code query: match features by their stored ZIP on any boundary
    //    (subdivisions/schools carry a Zip_Code prop), or by id when the
    //    active boundary is ZIP codes.
    if (isZipQuery) {
      for (const [id, info] of Object.entries(boundaryLookup[boundary] || {})) {
        if (info.zip === q) matched.add(id);
        else if (boundary === 'zipcodes' && id === q) matched.add(id);
      }
      if (boundary === 'zipcodes' && nameSource[q]) matched.add(q);
    }

    // 4) City / area name ("katy", "tomball", "sugar land"): resolve through
    //    the alias map and match features by ZIP, same as the chat does.
    if (matched.size === 0) {
      const aliasResult = resolveQueriesToZips([query]);
      if (aliasResult.zips.length > 0) {
        const zipSet = new Set(aliasResult.zips);
        for (const [id, info] of Object.entries(boundaryLookup[boundary] || {})) {
          if ((info.zip && zipSet.has(info.zip)) || (boundary === 'zipcodes' && zipSet.has(id))) {
            matched.add(id);
          }
        }
        if (matched.size > 0) {
          console.info(
            '[applySearch] resolved via alias map:',
            aliasResult.matched.map((a) => `${a.displayName} → [${a.zips.join(', ')}]`),
          );
        }
      }
    }

    if (matched.size > 0) {
      setSelectedIds(Array.from(matched));
      setSearchFocusTick((t) => t + 1);
    } else {
      setSelectedIds([]);
    }
  }, [searchQuery, filteredData, boundary, effectiveNameMap, boundaryLookup]);

  // Live search: debounce the input so we filter as the user types.
  useEffect(() => {
    const id = setTimeout(() => {
      setSearchQuery(searchInput);
      applySearch(searchInput);
    }, 200);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

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
    setAppliedFilters(DEFAULT_FILTERS);
    setFiltersApplying(false);
    setSearchQuery('');
    setSearchInput('');
    // Reset every control the sidebar exposes, not just the property filters —
    // "Reset all filters" previously left metric, boundary scale and layers as
    // they were.
    setMetric('Close Price');
    setAutoScale(true);
    setReversePalette(false);
    setLayerSales(false);
    setLayerRentals(false);
    setLayerFlood(false);
    setReportGenerated(false);
    setReportError(null);
    setReportProgress(null);
    setActiveWindows([]);
    // Re-prime the live data path (instant — the engine already has the full
    // dataset) so filters stay active after a reset.
    loadFullData();
  }, [setActiveWindows, loadFullData]);

  const handleAreaSelectFromChat = useCallback((queries: string[], generateReportAfter?: boolean) => {
    if (!queries || queries.length === 0) return;

    // If the chat asked us to also generate a report after selecting these
    // areas, remember it. A useEffect below will fire generateReport() once
    // the selection state has actually been committed to React.
    if (generateReportAfter) {
      reportFromChatRef.current = true;
      setPendingReport(true);
    }

    // Combine the post-report name map with the always-available boundary
    // lookup (loaded from the GeoJSON). effectiveNameMap is empty until a
    // report has been generated, so the lookup is what makes chat work
    // before that point.
    const nameSource: Record<string, string> = {};
    for (const [id, info] of Object.entries(boundaryLookup[boundary] || {})) {
      nameSource[id] = info.name;
    }
    for (const [id, name] of Object.entries(effectiveNameMap || {})) {
      if (!nameSource[id]) nameSource[id] = name;
    }

    // Convert to lowercase for fuzzy matching
    const normalizedQueries = queries.map(q => q.toLowerCase().trim());
    const matchedIds: string[] = [];
    const matchedNames: string[] = [];

    // Search through the combined name source
    Object.entries(nameSource).forEach(([id, name]) => {
      const normalizedName = (name || '').toLowerCase();
      // If the feature name includes the query or vice-versa
      const isMatch = normalizedQueries.some(q =>
        normalizedName.includes(q) || q.includes(normalizedName)
      );
      if (isMatch) {
        matchedIds.push(id);
        matchedNames.push(name);
      }
    });

    // Fallback: when the active boundary is subdivisions/cities and the user
    // mentions a city name, the per-feature names rarely match the city
    // directly. Match by resolved ZIP code on each feature's stored ZIP.
    if (matchedIds.length === 0 && boundary !== 'zipcodes') {
      const aliasResult = resolveQueriesToZips(queries);
      if (aliasResult.zips.length > 0) {
        const zipSet = new Set(aliasResult.zips);
        Object.entries(boundaryLookup[boundary] || {}).forEach(([id, info]) => {
          if (info.zip && zipSet.has(info.zip)) {
            matchedIds.push(id);
            matchedNames.push(info.name);
          }
        });
        if (matchedIds.length > 0) {
          console.info(
            '[handleAreaSelectFromChat] resolved via alias map (ZIPs):',
            aliasResult.matched.map((a) => `${a.displayName} → [${a.zips.join(', ')}]`),
          );
        }
      }
    }

    // Fallback: when the active boundary is ZIP codes and the user mentions a
    // city name ("Katy", "Tomball"), the names won't match — but the resolved
    // ZIPs do. Use the alias resolver to widen the match.
    if (matchedIds.length === 0 && boundary === 'zipcodes') {
      const aliasResult = resolveQueriesToZips(queries);
      if (aliasResult.zips.length > 0) {
        const zipSet = new Set(aliasResult.zips);
        Object.entries(nameSource).forEach(([id]) => {
          if (zipSet.has(id)) {
            matchedIds.push(id);
            matchedNames.push(nameSource[id]);
          }
        });
        if (aliasResult.matched.length > 0) {
          console.info(
            '[handleAreaSelectFromChat] resolved via alias map:',
            aliasResult.matched.map((a) => `${a.displayName} → [${a.zips.join(', ')}]`),
          );
        }
      }
    }

    if (matchedIds.length > 0) {
      // Add the matched IDs to the current selection, without duplicating
      setSelectedIds(prev => Array.from(new Set([...prev, ...matchedIds])));
    } else {
      // Nothing matched — drop the pending-report flag so a later manual
      // selection by the user doesn't unexpectedly trigger a report.
      console.warn('[handleAreaSelectFromChat] NO areas matched for:', queries, 'on boundary:', boundary);
      if (generateReportAfter) {
        reportFromChatRef.current = false;
        setPendingReport(false);
      }
    }
    // Let the chat know what actually matched so the model (and the tool
    // result) can tell matching failures apart from successes.
    return matchedNames.length > 0 ? matchedNames : null;
  }, [effectiveNameMap, boundary, boundaryLookup]);

  const getStatsForChatQueries = useCallback((queries: string[]) => {
    if (!queries || queries.length === 0 || !dataReady) return null;
    // SQL mode: the raw rows live server-side, so an arbitrary-area preview
    // can't be computed client-side. The chat still works — it just skips the
    // stats preview rather than reporting zeros.
    if (useSql) return null;

    const nameSource: Record<string, string> = {};
    for (const [id, info] of Object.entries(boundaryLookup[boundary] || {})) {
      nameSource[id] = info.name;
    }
    for (const [id, name] of Object.entries(effectiveNameMap || {})) {
      if (!nameSource[id]) nameSource[id] = name;
    }

    const normalizedQueries = queries.map(q => q.toLowerCase().trim());
    const matchedIds: string[] = [];
    const matchedNames: string[] = [];

    Object.entries(nameSource).forEach(([id, name]) => {
      const normalizedName = (name || '').toLowerCase();
      const isMatch = normalizedQueries.some(q =>
        normalizedName.includes(q) || q.includes(normalizedName)
      );
      if (isMatch) {
        matchedIds.push(id);
        matchedNames.push(name);
      }
    });

    if (matchedIds.length === 0 && boundary !== 'zipcodes') {
      const aliasResult = resolveQueriesToZips(queries);
      if (aliasResult.zips.length > 0) {
        const zipSet = new Set(aliasResult.zips);
        Object.entries(boundaryLookup[boundary] || {}).forEach(([id, info]) => {
          if (info.zip && zipSet.has(info.zip)) {
            matchedIds.push(id);
            matchedNames.push(info.name);
          }
        });
      }
    }

    if (matchedIds.length === 0 && boundary === 'zipcodes') {
      const aliasResult = resolveQueriesToZips(queries);
      if (aliasResult.zips.length > 0) {
        const zipSet = new Set(aliasResult.zips);
        Object.entries(nameSource).forEach(([id, name]) => {
          if (zipSet.has(id)) {
            matchedIds.push(id);
            matchedNames.push(name);
          }
        });
      }
    }

    if (matchedIds.length === 0) return null;

    const stats = engine.getStatsForSelection(filteredData, boundary, matchedIds);
    const isRental =
      metric === 'Est. Rental Price' ||
      metric === 'Rental Price per Sqft' ||
      metric === 'Rental Days On Market' ||
      metric === 'Rent-to-Sale Ratio';
    const health = engine.getMarketHealth(filteredData, boundary, matchedIds, isRental ? 'rental' : 'sale');

    return { stats, health, matchedNames };
  }, [dataReady, useSql, filteredData, boundary, effectiveNameMap, metric, boundaryLookup]);

  // Real-time stats for chat-driven property filters. The bot merges the
  // requested filters on top of the applied ones and this returns the matching
  // rows' aggregates in ONE synchronous pass, so the model can answer
  // "how many / what's the average / where" in the same turn it applies them.
  // Null in SQL mode (rows live server-side) or before the dataset has loaded.
  const getStatsForChatFilters = useCallback((newFilters: Partial<PropertyFilters>) => {
    if (useSql || reportPhase !== 'ready') return null;
    const merged = { ...appliedFilters, ...newFilters } as PropertyFilters;
    const rows = engine.filterProperties(merged);
    const stats = engine.getStatsForSelection(rows, boundary, []);
    // Top 5 areas by match count so the bot can say where these homes cluster.
    const counts: Record<string, number> = {};
    for (const d of rows) {
      const pid = engine.getBoundaryKey(boundary, d);
      if (!pid) continue;
      counts[pid] = (counts[pid] || 0) + 1;
    }
    const nameSource: Record<string, string> = {};
    for (const [id, info] of Object.entries(boundaryLookup[boundary] || {})) {
      nameSource[id] = info.name;
    }
    for (const [id, name] of Object.entries(effectiveNameMap || {})) {
      if (!nameSource[id]) nameSource[id] = name;
    }
    const topAreas = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, n]) => ({ name: nameSource[id] || id, count: n }));
    return { stats, topAreas };
  }, [useSql, reportPhase, appliedFilters, boundary, boundaryLookup, effectiveNameMap]);

  const generateReport = useCallback(() => {
    if (reportPhase === 'loading') return;
    if (selectedIds.length === 0) {
      setReportError('Select one or more areas on the map to generate a report.');
      setTimeout(() => setReportError(null), 4000);
      return;
    }
    setDataLoadKind('report');
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

  // When the chat sets pendingReport=true alongside a selection, fire
  // generateReport() once the selection state has been committed to React.
  // This is more reliable than a setTimeout: the effect runs after the DOM is
  // updated, so selectedIds is guaranteed to reflect the latest selection.
  useEffect(() => {
    if (!pendingReport) return;
    // The initial full-dataset load ALSO uses reportPhase 'loading'. Firing
    // generateReport() inside that window would hit its 'loading' guard and
    // silently bail — so wait here until the load finishes; this effect
    // re-runs when reportPhase transitions.
    if (reportPhase === 'loading') return;
    if (selectedIds.length === 0) return; // selection didn't actually land
    setPendingReport(false);
    generateReport();
  }, [pendingReport, selectedIds, reportPhase, generateReport]);

  // Load the full dataset in the background right after the map first renders
  // (see loadFullData above). Reports for a selection still re-load just the
  // relevant chunks on top of this when the engine doesn't hold the full data.
  useEffect(() => {
    loadFullData();
    // Run once on mount (boundary effect also fires on mount; the engine
    // de-duplicates concurrent loads via its in-flight promise).
  }, [loadFullData]);

  // Display names of the current selection, so the chat model can re-select
  // the same areas when the user says "generate the report" without naming one.
  const selectedAreaNames = useMemo(() => {
    if (selectedIds.length === 0) return [];
    const nameSource: Record<string, string> = {};
    for (const [id, info] of Object.entries(boundaryLookup[boundary] || {})) {
      nameSource[id] = info.name;
    }
    for (const [id, name] of Object.entries(effectiveNameMap || {})) {
      if (!nameSource[id]) nameSource[id] = name;
    }
    return selectedIds.map((id) => nameSource[id] || id);
  }, [selectedIds, boundary, boundaryLookup, effectiveNameMap]);

  // Announce in the chat when a chat-triggered report finishes generating.
  // Deterministic — doesn't rely on the model saying anything.
  useEffect(() => {
    if (reportPhase !== 'ready' || !reportFromChatRef.current) return;
    reportFromChatRef.current = false;
    setReportReadyMsg({
      id: Date.now(),
      text:
        "Your report is ready! 🎉 I've highlighted the areas on the map and generated the full report. Let me know if you need anything else — I can compare areas, switch metrics, or dig into any specific number.",
    });
  }, [reportPhase]);

  const clearReport = useCallback(() => {
    setReportGenerated(false);
    setReportPhase('idle');
    setReportError(null);
    setReportProgress(null);
    setActiveWindows([]);
  }, [setActiveWindows]);

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
  }) => {
    const low = filters[lowKey] as number;
    const high = filters[highKey] as number;
    // Readable range label: untouched ends read as "Any" instead of raw
    // extremes like "$0 - $20M", and the sliders clamp each other so the
    // label can never cross (e.g. "$9K - $0").
    const rangeLabel =
      low <= min && high >= max
        ? 'Any'
        : `${low <= min ? 'Any' : format(low)} – ${high >= max ? 'Any' : format(high)}`;
    return (
      <div>
        <div className="flex justify-between text-xs text-gray-400 font-bold uppercase tracking-wider mb-2">
          <span>{label}</span>
          <span className="text-blue-400">{rangeLabel}</span>
        </div>
        <div className="flex gap-2">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={low}
            onChange={(e) => {
              const v = Number(e.target.value);
              handleFilterChange(lowKey, v);
              // Keep low <= high: pushing min past max drags max along.
              if (v > high) handleFilterChange(highKey, v);
            }}
            className="flex-1 accent-blue-500 h-1.5 bg-white/10 rounded-full appearance-none"
          />
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={high}
            onChange={(e) => {
              const v = Number(e.target.value);
              handleFilterChange(highKey, v);
              // Keep high >= low: pulling max below min drags min along.
              if (v < low) handleFilterChange(lowKey, v);
            }}
            className="flex-1 accent-blue-500 h-1.5 bg-white/10 rounded-full appearance-none"
          />
        </div>
      </div>
    );
  };

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
                <span>Loading market data {reportProgress.loaded}/{reportProgress.total}</span>
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
              <span className="hidden sm:inline">Loading market data…</span>
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
                <span className="text-white font-semibold">{displayPropertyCount.toLocaleString()}</span> properties
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

        {/* Mobile backdrop: tapping outside the filter drawer closes it */}
        {sidebarOpen && (
          <div
            className="lg:hidden fixed inset-0 z-30 bg-black/60 backdrop-blur-sm print:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Left sidebar — slide-over drawer on mobile, static column on desktop */}
        <aside
          className={`${
            sidebarOpen ? 'flex' : 'hidden'
          } lg:flex fixed lg:static inset-y-0 left-0 z-40 flex-col gap-4 w-[85vw] max-w-sm lg:w-80 xl:w-88 shrink-0 bg-[#0a0c10] border-r border-white/[0.06] p-4 overflow-y-auto print:hidden`}
        >
          {/* Search */}
          <FilterSection icon={<Search className="w-4 h-4" />} title="Search" defaultOpen={false} dataTour="search">
            <div className="flex items-center gap-2 bg-white/5 border border-white/[0.06] rounded-xl px-3 py-2 focus-within:border-blue-500/40 transition-colors">
              <Search className="w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Area, address or ZIP…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setSearchQuery(searchInput);
                    applySearch(searchInput);
                  }
                  if (e.key === 'Escape') {
                    setSearchInput('');
                    setSearchQuery('');
                    setSelectedIds([]);
                  }
                }}
                className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder-gray-500"
              />
              {searchInput && (
                <button
                  onClick={() => {
                    setSearchInput('');
                    setSearchQuery('');
                    setSelectedIds([]);
                  }}
                  className="text-gray-500 hover:text-white transition-colors"
                  aria-label="Clear search"
                  title="Clear"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => {
                  setSearchQuery(searchInput);
                  applySearch(searchInput);
                }}
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
            <SimpleSelect
              value={metric}
              onChange={(v) => setMetric(v as MetricKey)}
              options={METRICS.map((m) => ({ key: m.key, label: m.label }))}
            />
            <p className="text-[10px] text-gray-500 mt-1.5 flex items-center gap-1">
              <ChevronDown className="w-3 h-3" />
              {METRICS.length} metrics available
            </p>
          </FilterSection>

          {/* Period */}
          <FilterSection icon={<CalendarDays className="w-4 h-4 text-amber-400" />} title="Close Period" defaultOpen>
            <SimpleSelect
              value={filters.period}
              onChange={(v) => handleFilterChange('period', v as PropertyFilters['period'])}
              options={PERIODS.map((p) => ({ key: p.key, label: p.label }))}
            />
            <p className="text-[10px] text-gray-500 mt-1.5 flex items-center gap-1">
              <ChevronDown className="w-3 h-3" />
              {PERIODS.length} time periods available
            </p>
          </FilterSection>

          {/* Quick property filters */}
          <FilterSection icon={<SlidersHorizontal className="w-4 h-4" />} title="Property Filters" defaultOpen={false}>
            <div className="space-y-4">
              <RangeControl
                label="Sale Price"
                min={0}
                max={20000000}
                step={100000}
                lowKey="saleMin"
                highKey="saleMax"
                format={formatMoney}
              />
              <RangeControl
                label="Est. Rent"
                min={0}
                max={50000}
                step={500}
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
                        {n === 0 ? 'Any' : `${n}+`}
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
                        {n === 0 ? 'Any' : `${n}+`}
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
                max={20000}
                step={250}
                lowKey="sqftMin"
                highKey="sqftMax"
                format={(n) => (n >= 1000 ? (n / 1000).toFixed(0) + 'k' : n.toString())}
              />
              <RangeControl
                label="Price / Sq.Ft."
                min={0}
                max={5000}
                step={10}
                lowKey="pricePerSqftMin"
                highKey="pricePerSqftMax"
                format={formatMoney}
              />
              <RangeControl
                label="Lot Size"
                min={0}
                max={1000000}
                step={5000}
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
                max={2000}
                step={10}
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
                    value={filters.propertyTypes[0] || 'any'}
                    onChange={(e) => handleFilterChange('propertyTypes', e.target.value === 'any' ? [] : [e.target.value])}
                    disabled={uniquePropertyTypes.length === 0}
                    className="w-full bg-white/5 border border-white/[0.06] text-white text-xs rounded-lg px-2 py-1.5 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <option value="any" className="bg-[#121620]">All Types</option>
                    {uniquePropertyTypes.map((t: string) => (
                      <option key={t} value={t} className="bg-[#121620]">{t}</option>
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
              <p className="text-[10px] text-gray-500 leading-relaxed">
                Controls the color scale of the map: each area is colored by where its metric value falls between Min and Max. With Auto scale on, Min/Max fit the current data automatically.
              </p>
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
              {layerFlood && (
                <p className="text-[10px] text-gray-500 leading-relaxed px-1">
                  Flood Hazard Areas via FEMA NFHL. Zoom in to city level for the zones to render.
                </p>
              )}
            </div>
          </FilterSection>

          {/* Apply button lives ON the map (mid-left) — intentionally not
              duplicated here. Controls stage changes into a draft; the map
              button commits them and recomputes the polygons. */}
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
          {/* min-h-full makes the ads + map fill exactly the visible height, so
              the bottom banner is reachable WITHOUT scrolling. Once a report is
              generated below, the page grows and scrolls as before. */}
          <div className="p-4 lg:p-6 flex flex-col min-h-full">
            {/* 'top' ads sit ABOVE the map in normal flow — the map shrinks a
                little but the ad never overlays it. */}
            <AnimatePresence>
              {adsByPlacement.top && !closedAdIds.has(adsByPlacement.top.id) && (
                <AdCard
                  key={adsByPlacement.top.id}
                  ad={adsByPlacement.top}
                  variant="inline-top"
                  onClose={() => closeAd(adsByPlacement.top!.id)}
                />
              )}
            </AnimatePresence>

            {/* Map + side banners (Google-ads style: ads AROUND the map, never
                on top of it). 'corner' → left column, 'right' → right column;
                both hide on phones where side banners would crush the map. */}
            <div className="flex gap-3 items-stretch sm:flex-1 sm:min-h-0">
              <AnimatePresence>
                {adsByPlacement.corner && !closedAdIds.has(adsByPlacement.corner.id) && (
                  <AdCard
                    key={adsByPlacement.corner.id}
                    ad={adsByPlacement.corner}
                    variant="side-left"
                    onClose={() => closeAd(adsByPlacement.corner!.id)}
                  />
                )}
              </AnimatePresence>

            {/* On desktop the card stretches to whatever height is left after
                the top/bottom banners (no aspect ratio → no page scroll). On
                mobile it keeps a fixed 65vh. */}
            <div className="relative flex-1 min-w-0 h-[65vh] max-h-[760px] sm:h-auto sm:min-h-[420px] print:hidden no-print">
              <div className="absolute inset-0 bg-[#121620] border border-white/[0.06] rounded-2xl shadow-2xl p-3 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between mb-3 px-1">
                  <div className="flex items-center gap-2 text-gray-400">
                    <TrendingUp className="w-4 h-4" />
                    <span className="text-xs font-bold uppercase tracking-wider">Interactive Map</span>
                    <span className="text-xs text-gray-500 hidden sm:inline">
                      {reportPhase === 'loading' ? (
                        reportProgress && reportProgress.total > 0
                          ? `Loading market data ${reportProgress.loaded}/${reportProgress.total}…`
                          : 'Loading market data…'
                      ) : (
                        `${displayPropertyCount.toLocaleString()} properties · ${Object.keys(metricValues).length} areas`
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
                    period={filters.period}
                    onSetPeriod={(p) =>
                      applyFiltersNow((prev) => ({ ...prev, period: p as PropertyFilters['period'] }))
                    }
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
                    rawData={mapRawData}
                    showSales={layerSales}
                    showRentals={layerRentals}
                    showFlood={layerFlood}
                    metricLabel={METRICS.find((m) => m.key === metric)?.label || metric}
                    fillOpacity={fillOpacity}
                    onClear={() => setSelectedIds([])}
                    onGenerateReport={generateReport}
                    onReset={handleReset}
                    reportGenerated={reportGenerated}
                    isReportLoading={reportPhase === 'loading' && dataLoadKind === 'report'}
                    isDataLoading={reportPhase === 'loading' && dataLoadKind === 'data'}
                    focusSelectionTick={searchFocusTick}
                  />
                </div>
              </div>

              {/* Floating Apply button ON the map, mid-left (user-requested
                  spot). NO framer-motion here: it animates on the main thread,
                  and the heavy filter recompute blocks that thread, leaving
                  the button stuck at opacity 0 (invisible). Plain CSS only. */}
              {filtersDirty && !filtersApplying && (
                <button
                  onClick={applyFilters}
                  className="absolute left-4 top-1/2 -translate-y-1/2 z-[800] px-5 py-3 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold shadow-2xl shadow-black/50 border border-blue-400/40 flex items-center gap-2 whitespace-nowrap print:hidden no-print transition-transform hover:scale-105"
                >
                  <Filter className="w-4 h-4" />
                  Apply Filters
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                </button>
              )}

              {/* Applying-filters popup — anchored to the MAP (not the whole
                  viewport), plain div, no framer-motion (main-thread blocking
                  would freeze it at opacity 0). */}
              {filtersApplying && (
                <div className="absolute inset-0 z-[900] bg-black/50 backdrop-blur-sm flex items-center justify-center print:hidden no-print">
                  <div className="bg-[#121620] border border-white/[0.06] rounded-2xl p-6 flex flex-col items-center gap-3 shadow-2xl max-w-[280px] text-center">
                    <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
                    <p className="text-sm font-bold text-white tracking-wide">Applying filters…</p>
                    <p className="text-xs text-gray-400">Updating map polygons and metrics for your selection.</p>
                  </div>
                </div>
              )}
            </div>

              <AnimatePresence>
                {adsByPlacement.right && !closedAdIds.has(adsByPlacement.right.id) && (
                  <AdCard
                    key={adsByPlacement.right.id}
                    ad={adsByPlacement.right}
                    variant="side-right"
                    onClose={() => closeAd(adsByPlacement.right!.id)}
                  />
                )}
              </AnimatePresence>
            </div>

            {/* 'bottom' ads sit BELOW the map, also outside it. */}
            <AnimatePresence>
              {adsByPlacement.bottom && !closedAdIds.has(adsByPlacement.bottom.id) && (
                <AdCard
                  key={adsByPlacement.bottom.id}
                  ad={adsByPlacement.bottom}
                  variant="inline-bottom"
                  onClose={() => closeAd(adsByPlacement.bottom!.id)}
                />
              )}
            </AnimatePresence>

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
          selectedAreaNames={selectedAreaNames}
          onAreaSelect={handleAreaSelectFromChat}
          onGenerateReport={generateReport}
          getStatsForChatQueries={getStatsForChatQueries}
          getStatsForChatFilters={getStatsForChatFilters}
          setBoundary={setBoundary}
          setMetric={setMetric}
          setFilters={applyFiltersNow}
          reportReadyMsg={reportReadyMsg}
        />
      </div>
    </div>
  );
}
