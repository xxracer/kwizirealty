'use client';

import { motion } from 'framer-motion';
import { BarChart3, Printer } from 'lucide-react';
import type { MetricKey, PropertyData, BoundaryKey } from '@/lib/engine';
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

interface ReportPanelProps {
  metric: MetricKey;
  metricLabel: string;
  selectedNames: string[];
  reportStats: ReportStats;
  marketHealth: MarketHealth | null;
  timeSeries: { period: string; value: number; n: number }[];
  forecast: Forecast | null;
  forecastComparison: ForecastRow[];
  chartData: { name: string; value: number }[];
  yearBuiltData: { name: string; value: number }[];
  boundary: BoundaryKey;
  onHide?: () => void;
  isLoading?: boolean;
  pinnedWindows?: WindowType[];
  onToggleWindow?: (key: WindowType) => void;
}

export default function ReportPanel({
  metric,
  metricLabel,
  selectedNames,
  reportStats,
  marketHealth,
  timeSeries,
  forecast,
  forecastComparison,
  chartData,
  yearBuiltData,
  boundary,
  onHide,
  isLoading,
  pinnedWindows = [],
  onToggleWindow,
}: ReportPanelProps) {
  const selectionSummary = selectedNames.length
    ? `${selectedNames.length} area${selectedNames.length > 1 ? 's' : ''} selected`
    : 'All visible areas';

  const isPinned = (key: WindowType) => pinnedWindows.includes(key);

  const top5ChartData = chartData.slice(0, 5);
  const top5ForecastComparison = forecastComparison.slice(0, 5);

  const exportPDF = async () => {
    try {
      const html2pdf = (await import('html2pdf.js')).default;
      const element = document.getElementById('report-panel-content');
      if (!element) return;
      
      const opt = {
        margin:       0.5,
        filename:     'real-estate-report.pdf',
        image:        { type: 'jpeg' as const, quality: 0.98 },
        html2canvas:  { scale: 2, useCORS: true, backgroundColor: '#0f172a' },
        jsPDF:        { unit: 'in' as const, format: 'letter' as const, orientation: 'portrait' as const }
      };
      
      html2pdf().set(opt).from(element).save();
    } catch (err) {
      console.error('Failed to export PDF:', err);
    }
  };

  return (
    <motion.div
      id="report-panel-content"
      className="space-y-4 bg-[#0f172a] p-4 rounded-xl"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
    >
      <motion.div
        className="flex items-center justify-between"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.05 }}
      >
        <div className="flex items-center gap-2 text-gray-400">
          <BarChart3 className="w-4 h-4 text-blue-400" />
          <h2 className="text-xs font-bold uppercase tracking-wider">Detailed Market Report</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-xs text-gray-500 font-bold">{selectionSummary}</div>
          {onHide && (
            <button
              onClick={onHide}
              className="text-xs text-gray-400 hover:text-white underline transition-colors"
            >
              Hide report
            </button>
          )}
          <button
            onClick={exportPDF}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition-colors shadow"
            title="Export as PDF"
          >
            <Printer className="w-3.5 h-3.5" />
            Export PDF
          </button>
        </div>
      </motion.div>

      {/* Top row: stats + health */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <QuickStatsCard
          stats={reportStats}
          isLoading={isLoading}
          pinned={isPinned('quick-stats')}
          onTogglePin={() => onToggleWindow?.('quick-stats')}
        />
        <MarketHealthCard
          marketHealth={marketHealth}
          timeSeries={timeSeries}
          isLoading={isLoading}
          pinned={isPinned('market-health')}
          onTogglePin={() => onToggleWindow?.('market-health')}
        />
      </div>

      {/* Time series + forecast */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TimeSeriesCard
          metric={metric}
          metricLabel={metricLabel}
          timeSeries={timeSeries}
          isLoading={isLoading}
          pinned={isPinned('time-series')}
          onTogglePin={() => onToggleWindow?.('time-series')}
        />
        <ForecastCard
          metric={metric}
          metricLabel={metricLabel}
          timeSeries={timeSeries}
          forecast={forecast}
          isLoading={isLoading}
          pinned={isPinned('forecast')}
          onTogglePin={() => onToggleWindow?.('forecast')}
        />
      </div>

      {/* Year built + top areas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <YearBuiltCard
          yearBuiltData={yearBuiltData}
          isLoading={isLoading}
          pinned={isPinned('year-built')}
          onTogglePin={() => onToggleWindow?.('year-built')}
        />
        <TopAreasCard
          metric={metric}
          chartData={top5ChartData}
          isLoading={isLoading}
          pinned={isPinned('top-areas')}
          onTogglePin={() => onToggleWindow?.('top-areas')}
        />
      </div>

      {/* Forecast comparison */}
      <ForecastComparisonCard
        metric={metric}
        forecastComparison={top5ForecastComparison}
        boundary={boundary}
        isLoading={isLoading}
        pinned={isPinned('forecast-comparison')}
        onTogglePin={() => onToggleWindow?.('forecast-comparison')}
      />
    </motion.div>
  );
}
