'use client';

import { useState } from 'react';
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

  const [isExporting, setIsExporting] = useState(false);

  const isPinned = (key: WindowType) => pinnedWindows.includes(key);

  const top5ChartData = chartData.slice(0, 5);
  const top5ForecastComparison = forecastComparison.slice(0, 5);

  const exportPDF = async () => {
    setIsExporting(true);
    try {
      const { jsPDF } = await import('jspdf');
      // @ts-ignore
      const autoTable = (await import('jspdf-autotable')).default;

      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'pt',
        format: 'letter'
      });

      const pageWidth = doc.internal.pageSize.getWidth();
      let cursorY = 40;

      // Helper for text formatting
      const addText = (text: string, x: number, y: number, size = 12, isBold = false) => {
        doc.setFontSize(size);
        doc.setFont('helvetica', isBold ? 'bold' : 'normal');
        doc.text(text, x, y);
      };

      // Header
      addText('Houston Real Estate Market Report', 40, cursorY, 20, true);
      cursorY += 25;
      
      const dateString = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      addText(`Date: ${dateString}`, 40, cursorY, 12, false);
      cursorY += 20;
      addText(`Metric: ${metricLabel}`, 40, cursorY, 12, false);
      cursorY += 20;
      addText(`Areas: ${selectionSummary}`, 40, cursorY, 12, false);
      cursorY += 30;

      const formatVal = (val: number) => 
        metric === 'dom' || metric === 'moi' || metric === 'total_sales' 
          ? val.toLocaleString() 
          : val.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

      // Quick Stats
      addText('Quick Stats', 40, cursorY, 16, true);
      cursorY += 15;
      
      const statsData = [
        ['Avg Sale Price', formatVal(reportStats.avgSale)],
        ['Avg List Price', formatVal(reportStats.avgList)],
        ['Avg SqFt Price', formatVal(reportStats.avgSqft)],
        ['Avg Days on Market', reportStats.avgDom.toFixed(0) + ' days'],
        ['Total Volume', formatVal(reportStats.totalVolume)],
        ['Properties Count', reportStats.count.toLocaleString()]
      ];
      
      autoTable(doc, {
        startY: cursorY,
        head: [['Statistic', 'Value']],
        body: statsData,
        theme: 'striped',
        margin: { left: 40, right: 40 }
      });
      cursorY = (doc as any).lastAutoTable.finalY + 30;

      // Market Health
      if (marketHealth) {
        if (cursorY > 700) { doc.addPage(); cursorY = 40; }
        addText('Market Health', 40, cursorY, 16, true);
        cursorY += 15;
        
        const healthData = [
          ['Score (0-100)', marketHealth.score.toFixed(1)],
          ['Market Label', marketHealth.label],
          ['Months of Inventory', marketHealth.moi !== null ? marketHealth.moi.toFixed(1) : 'N/A'],
          ['Days on Market', marketHealth.dom !== null ? marketHealth.dom.toFixed(0) + 'd' : 'N/A'],
          ['List-to-Sale Ratio', marketHealth.l2s !== null ? marketHealth.l2s.toFixed(1) + '%' : 'N/A']
        ];

        autoTable(doc, {
          startY: cursorY,
          head: [['Indicator', 'Status']],
          body: healthData,
          theme: 'striped',
          margin: { left: 40, right: 40 }
        });
        cursorY = (doc as any).lastAutoTable.finalY + 30;
      }

      // Top Areas
      if (top5ChartData.length > 0) {
        if (cursorY > 600) { doc.addPage(); cursorY = 40; }
        addText('Top Areas', 40, cursorY, 16, true);
        cursorY += 15;

        const topAreasData = top5ChartData.map(d => [d.name, formatVal(d.value)]);

        autoTable(doc, {
          startY: cursorY,
          head: [['Area', 'Value']],
          body: topAreasData,
          theme: 'striped',
          margin: { left: 40, right: 40 }
        });
        cursorY = (doc as any).lastAutoTable.finalY + 30;
      }

      // Forecast Comparison
      if (top5ForecastComparison.length > 0) {
        if (cursorY > 600) { doc.addPage(); cursorY = 40; }
        addText('Forecast Comparison (12 Months)', 40, cursorY, 16, true);
        cursorY += 15;
        
        const forecastData = top5ForecastComparison.map(row => [
          row.region,
          formatVal(row.baseline),
          formatVal(row.forecast3yr),
          row.annualPct.toFixed(2) + '%'
        ]);

        autoTable(doc, {
          startY: cursorY,
          head: [['Area', 'Current', 'Predicted', 'Growth']],
          body: forecastData,
          theme: 'striped',
          margin: { left: 40, right: 40 }
        });
      }

      doc.save('Houston_Real_Estate_Report.pdf');
    } catch (err) {
      console.error('Failed to export PDF:', err);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <>
      {isExporting && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0f172a] text-white p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 border border-slate-700">
            <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="font-bold text-lg">Generating PDF...</p>
            <p className="text-sm text-slate-400">Please wait a moment.</p>
          </div>
        </div>
      )}
      <motion.div
        id="report-panel-content"
        className="space-y-4 bg-[#0f172a] p-4 rounded-xl relative"
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
    </>
  );
}
