'use client';

import { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { X, ChevronRight, ChevronLeft, Compass, Map, SlidersHorizontal, MousePointerClick, BarChart3, MessageSquare, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface TourStep {
  target?: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center';
}

const STEPS: TourStep[] = [
  {
    title: 'Welcome to Kwizi Market Explorer',
    description:
      'Explore the Houston real-estate market with interactive maps, local insights, and detailed area reports.',
    icon: <Compass className="w-6 h-6 text-blue-400" />,
    placement: 'center',
  },
  {
    target: '[data-tour="header"]',
    title: 'Top bar',
    description: 'Start a guided tour, export the report to PDF, save your session, or reset all filters from here.',
    icon: <Map className="w-6 h-6 text-emerald-400" />,
    placement: 'bottom',
  },
  {
    target: '[data-tour="summary-bar"]',
    title: 'Live summary',
    description: 'See the active boundary, metric, time period, school filters, and counts at a glance.',
    icon: <Map className="w-6 h-6 text-emerald-400" />,
    placement: 'bottom',
  },
  {
    target: '[data-tour="boundary"]',
    title: 'Pick a boundary',
    description: 'Switch between Subdivisions, Zip Codes, School districts and more. Premium boundaries show a star badge.',
    icon: <Map className="w-6 h-6 text-emerald-400" />,
    placement: 'right',
  },
  {
    target: '[data-tour="metric"]',
    title: 'Choose a metric',
    description: 'Color the map by sales price, rent, tax rate, school ETA scores, appreciation, and more.',
    icon: <BarChart3 className="w-6 h-6 text-cyan-400" />,
    placement: 'right',
  },
  {
    target: '[data-tour="search"]',
    title: 'Search areas',
    description: 'Type an area name, address or ZIP and hit Go to find and select matching polygons.',
    icon: <Map className="w-6 h-6 text-emerald-400" />,
    placement: 'right',
  },
  {
    target: '[data-tour="advanced-filters"]',
    title: 'Advanced filters',
    description: 'Open this panel for square footage, lot size, year built, DOM, list-to-sale ratio, property type, cities and school filters.',
    icon: <SlidersHorizontal className="w-6 h-6 text-orange-400" />,
    placement: 'right',
  },
  {
    target: '[data-tour="map-tools"]',
    title: 'Map tools',
    description: 'Use Select to click individual areas, Box to draw a rectangle, or Lasso to draw a freehand shape. Both Box and Lasso select every area inside automatically.',
    icon: <MousePointerClick className="w-6 h-6 text-pink-400" />,
    placement: 'left',
  },
  {
    target: '[data-tour="map"]',
    title: 'Select on the map',
    description: 'Click any polygon to select it. With Multi-select checked you can add or remove areas one by one.',
    icon: <MousePointerClick className="w-6 h-6 text-pink-400" />,
    placement: 'bottom',
  },
  {
    target: '[data-tour="map-windows"]',
    title: 'Floating report windows',
    description: 'Open up to three draggable report windows to keep Quick Stats, Market Health, charts, and forecasts right on top of the map while you explore. Drag them anywhere inside the map.',
    icon: <BarChart3 className="w-6 h-6 text-cyan-400" />,
    placement: 'bottom',
  },
  {
    target: '[data-tour="generate-report"]',
    title: 'Generate the report',
    description: 'After selecting areas, click Generate Report to reveal the detailed analysis below.',
    icon: <BarChart3 className="w-6 h-6 text-cyan-400" />,
    placement: 'top',
  },
  {
    target: '[data-tour="report"]',
    title: 'Detailed Market Report',
    description: 'Quick Stats, Market Health, Time Series, 5-Year Forecast, Year Built, Top Areas and Forecast Comparison appear here.',
    icon: <BarChart3 className="w-6 h-6 text-cyan-400" />,
    placement: 'top',
  },
  {
    target: '[data-tour="chat"]',
    title: 'Need help?',
    description: 'The Kwizi AI Assistant button stays in the corner. More features coming soon.',
    icon: <MessageSquare className="w-6 h-6 text-blue-400" />,
    placement: 'left',
  },
  {
    placement: 'center',
    title: 'You are ready',
    description: 'Press Done to start exploring. You can reopen this tour anytime with the Tour button in the header.',
    icon: <Check className="w-6 h-6 text-green-400" />,
  },
];

interface TourModalProps {
  open: boolean;
  onClose: () => void;
}

function getElementRect(selector?: string): DOMRect | null {
  if (!selector || typeof document === 'undefined') return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  return el.getBoundingClientRect();
}

export default function TourModal({ open, onClose }: TourModalProps) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const refreshRef = useRef<(() => void) | undefined>(undefined);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const current = STEPS[step];
    if (!current.target) return;
    const el = document.querySelector(current.target);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const placement = current.placement || 'center';
    const isOffScreen = rect.bottom > window.innerHeight || rect.top < 0 || rect.right > window.innerWidth || rect.left < 0;
    if (isOffScreen) {
      // Scroll the target so the tooltip has room based on requested placement.
      let block: ScrollLogicalPosition = 'center';
      if (placement === 'bottom') block = 'start';
      if (placement === 'top') block = 'end';
      el.scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' });
    }
  }, [open, step]);

  useEffect(() => {
    if (!open || !tooltipRef.current || !rect || !STEPS[step].target) return;
    const card = tooltipRef.current.getBoundingClientRect();
    const offBottom = card.bottom > window.innerHeight;
    const offTop = card.top < 0;
    if (offBottom || offTop) {
      tooltipRef.current.scrollIntoView({ behavior: 'smooth', block: offBottom ? 'end' : 'start' });
    }
  }, [open, step, rect]);

  const refresh = useCallback(() => {
    const current = STEPS[step];
    setRect(getElementRect(current.target));
  }, [step]);

  refreshRef.current = refresh;

  useLayoutEffect(() => {
    if (!open) return;
    refresh();
    const handleResize = () => refreshRef.current?.();
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    };
  }, [open, refresh]);

  const finish = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('kwizi-tour-seen', 'true');
    }
    onClose();
  }, [onClose]);

  const next = useCallback(() => {
    if (step >= STEPS.length - 1) {
      finish();
    } else {
      setStep((s) => s + 1);
    }
  }, [step, finish]);

  const prev = useCallback(() => {
    setStep((s) => Math.max(0, s - 1));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, finish, next, prev]);

  if (!open) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const hasTarget = !!current.target && rect;
  const placement = current.placement || 'center';

  // Tooltip positioning
  let tooltipStyle: React.CSSProperties = {};
  const padding = 12;
  const cardWidth = 320;
  if (hasTarget && rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = 0;
    let left = 0;

    switch (placement) {
      case 'right':
        top = Math.max(padding, rect.top + rect.height / 2 - 80);
        left = Math.min(vw - cardWidth - padding, rect.right + padding);
        break;
      case 'left':
        top = Math.max(padding, rect.top + rect.height / 2 - 80);
        left = Math.max(padding, rect.left - cardWidth - padding);
        break;
      case 'top':
        left = Math.max(padding, Math.min(vw - cardWidth - padding, rect.left + rect.width / 2 - cardWidth / 2));
        top = Math.max(padding, rect.top - 200);
        break;
      case 'bottom':
        left = Math.max(padding, Math.min(vw - cardWidth - padding, rect.left + rect.width / 2 - cardWidth / 2));
        top = Math.min(vh - 200 - padding, rect.bottom + padding);
        break;
      default:
        left = vw / 2 - cardWidth / 2;
        top = vh / 2 - 100;
    }
    tooltipStyle = { top, left, width: cardWidth };
  }

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[2000]">
        {/* Dark overlay with cutout spotlight */}
        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={finish} />
        {hasTarget && rect && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute rounded-xl pointer-events-none"
            style={{
              top: rect.top - 6,
              left: rect.left - 6,
              width: rect.width + 12,
              height: rect.height + 12,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.7)',
            }}
          >
            <div className="absolute inset-0 rounded-xl border-2 border-blue-500 animate-pulse" />
          </motion.div>
        )}

        {/* Tooltip card */}
        <motion.div
          ref={tooltipRef}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.2 }}
          className={`absolute bg-[#121620] border border-white/[0.06] rounded-2xl shadow-2xl p-5 ${hasTarget ? '' : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg'}`}
          style={hasTarget ? tooltipStyle : undefined}
        >
          <button
            onClick={finish}
            className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors z-10"
            aria-label="Close tour"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-start gap-4 mb-5">
            <div className="shrink-0 w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center">{current.icon}</div>
            <div>
              <div className="text-[10px] font-bold text-blue-400 uppercase tracking-wider mb-1">
                Step {step + 1} of {STEPS.length}
              </div>
              <h3 className="text-xl font-bold text-white mb-1">{current.title}</h3>
              <p className="text-sm text-gray-300 leading-relaxed">{current.description}</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 mb-6">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? 'w-8 bg-blue-500' : i < step ? 'w-4 bg-blue-500/50' : 'w-4 bg-white/10'
                }`}
              />
            ))}
          </div>

          <div className="flex items-center justify-between">
            <button
              onClick={prev}
              disabled={step === 0}
              className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm font-semibold text-gray-300 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>

            <button
              onClick={next}
              className="flex items-center gap-1 px-5 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors"
            >
              {isLast ? 'Done' : 'Next'}
              {!isLast && <ChevronRight className="w-4 h-4" />}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
