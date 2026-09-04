import type { MetricKey } from './engine';

/**
 * Canonical list of map metrics. Shared between the map page (sidebar select,
 * labels) and the chatbot (HommieChat validates the model's setMapMetric calls
 * against these keys so the bot can't set an invalid metric that silently
 * falls back to coloring by close price).
 */
export interface MetricDef {
  key: MetricKey;
  label: string;
  category: 'sale' | 'rental' | 'market' | 'school' | 'cost';
}

export const METRICS: MetricDef[] = [
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