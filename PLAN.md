# Implementation Plan

## 1. Remove CSV-powered branding
- `src/app/layout.tsx`: change metadata description from "Houston real estate market explorer powered by CSV data" to "Houston metro real-estate analytics".
- `src/app/map/page.tsx`: remove the `<p>CSV-powered market explorer</p>` subtitle under the header title (or replace with neutral text).

## 2. Fix perceived slow loading / empty Quick Stats
- The engine loads 763K+ rows. Heavy `useMemo` calculations (filter, map values, stats, time series, forecast, chart data) run synchronously on first render while `loadingCSV` is still true, but the report panel already renders with zeros.
- Keep the report panel hidden until `loadingCSV === false` and the expensive memos have produced their first non-empty result, or show a clear loading skeleton instead of `0` values.
- Add `isCalculating` state in `map/page.tsx` that flips once `filteredData.length > 0` (or engine is loaded and memos computed).
- Pass `loading={!ready}` to `ReportPanel` and render a shared loading placeholder for Quick Stats / charts instead of `0`/`No data`.
- Optionally defer `ReportPanel` rendering until after first paint so the map becomes interactive faster.

## 3. Collapse all sidebar filter sections by default
- In `src/app/map/page.tsx`, change every `FilterSection` from `defaultOpen={true}` (or omitted) to `defaultOpen={false}`.
- The only exception may be the active search/boundary/metric if the user explicitly wants them closed too — request says **all** filter buttons closed until the arrow is clicked, so every section starts collapsed.

## 4. Hide Generate Report until an area is selected
- In `src/components/MapComponent.tsx`, render the Generate Report button only when `selectedIds.length > 0`.
- In `src/app/map/page.tsx`, do not render the `ReportPanel` at all when `selectedIds.length === 0` (remove the empty-state report that currently appears after clicking Generate Report).
- `generateReport` should still work for selected areas; clicking it reveals the report.

## 5. Add up to 3 draggable windows over the map
- Create a new component `src/components/DraggableMapWindows.tsx` using `framer-motion` drag.
- It accepts a list of window configs and renders floating, draggable cards on top of the map.
- Supported windows: Quick Stats, Market Health, Time Series, 5-Year Forecast, Year Built Distribution, Top Areas, Forecast Comparison.
- Add a control (inside the map header or sidebar) to let the user pick which windows are open and reorder them.
- Enforce a maximum of 3 active windows.
- Persist the active set/order in `localStorage` so it survives reloads.

## 6. Improve the guided tour
- Add an IntersectionObserver / scroll-into-view call in `TourModal.tsx` so whenever a step changes, the target element is scrolled into view if it is below the fold.
- Ensure the tooltip recalculates position on scroll and resize (already partly done with the window event listeners, but verify it follows the popup during the auto-scroll).
- Add a new tour step that highlights the draggable-map-windows control and explains that up to 3 report windows can be dragged over the map.
- Ensure the tour works when the sidebar is collapsed on mobile.

## 7. Files touched
- `src/app/layout.tsx`
- `src/app/map/page.tsx`
- `src/components/MapComponent.tsx`
- `src/components/ReportPanel.tsx`
- `src/components/TourModal.tsx`
- New: `src/components/DraggableMapWindows.tsx`

## Decisions made (no blockers)
- **Draggable windows content**: reuse the same SectionCard components from `ReportPanel` (Quick Stats, Market Health, Time Series, 5-Year Forecast, Year Built, Top Areas, Forecast Comparison) in small floating cards.
- **Window order selector**: add a "Windows" dropdown in the map header to pick which reports to float; user can reorder via drag handles or a simple order selector inside the dropdown.
- **Bottom report panel**: keep it. Generate Report still scrolls to the full report below; the 3 floating windows are an additional quick-view layer over the map.
