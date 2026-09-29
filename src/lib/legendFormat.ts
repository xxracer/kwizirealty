/**
 * Single source of truth for metric value formatting — used by the sidebar
 * legend (page.tsx) AND the map legend/popups (MapComponent.tsx) so both
 * always render the same text for the same metric.
 *
 * Money is ALWAYS written in full with thousands separators ("$6,175,000") —
 * raw integers ("6175000") are unreadable and K/M compaction hides the real
 * magnitude the owner wants to see.
 */
import type { MetricKey } from './engineCore';

function isMoneyMetric(metric: MetricKey | string | undefined): boolean {
  // Every metric falls through to formatMoney below except the explicit
  // non-money ones listed in formatMetricValue — mirror that list.
  if (!metric) return true;
  return ![
    'Days on Market',
    'Rental Days On Market',
    'List-to-Sale Ratio',
    'Appreciation Rate',
    'Investor Index',
    'Rent-to-Sale Ratio',
    'Lot Size',
    'Last Year Tax Rate',
    'Elem ETA Score',
    'Middle ETA Score',
    'High ETA Score',
  ].includes(metric);
}

/** Full money format: "$6,175,000" — no K/M compaction, separators included. */
export function formatMoney(num: number): string {
  if (!num || !isFinite(num)) return '$0';
  return '$' + Math.round(num).toLocaleString('en-US');
}

export function formatMetricValue(metric: MetricKey | string | undefined, value: number): string {
  if (!isFinite(value)) return '-';
  if (metric === 'Days on Market' || metric === 'Rental Days On Market') return Math.round(value).toLocaleString('en-US') + ' d';
  if (metric === 'List-to-Sale Ratio') return value.toFixed(1) + '%';
  if (metric === 'Appreciation Rate') return value.toFixed(2) + '%';
  if (metric === 'Investor Index') return value.toFixed(0);
  if (metric === 'Rent-to-Sale Ratio') return value.toFixed(3);
  if (metric === 'Lot Size') return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (metric === 'Last Year Tax Rate') return value.toFixed(2) + '%';
  if (metric === 'Elem ETA Score' || metric === 'Middle ETA Score' || metric === 'High ETA Score') return value.toFixed(0);
  return formatMoney(value);
}

/** Number only (no suffix) for text inputs like the Scale Range Min/Max:
 *  "$6,175,000" / "2.55" / "45,000" depending on the metric. */
export function formatMetricInput(metric: MetricKey | string | undefined, value: number): string {
  if (!isFinite(value)) return '';
  if (metric === 'List-to-Sale Ratio' || metric === 'Rent-to-Sale Ratio' || metric === 'Last Year Tax Rate' || metric === 'Appreciation Rate') {
    return String(value);
  }
  const rounded = Math.round(value * 100) / 100;
  if (isMoneyMetric(metric)) {
    return '$' + rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Parse what the user typed in a metric input back to a number: strips $,
 *  commas and spaces ("$6,175,000" → 6175000). */
export function parseMetricInput(text: string): number {
  const cleaned = text.replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned);
  return isFinite(n) ? n : 0;
}