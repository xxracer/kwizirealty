/* RESDOGS — map.js
 *
 * The rendering engine is the OLD app's: MapLibre GL + OSM raster, a fill
 * layer keyed by polygon id, a `match` expression for the metric colours,
 * hover tooltip, and click / box / lasso selection. Only the data source
 * changed: it now comes from Firebase through the Python API.
 *
 * The chrome is the NEW app's: the same filter panel, summary bar, tool
 * column and report cards as `new kwizi`.
 */
(function () {
  'use strict';

  const B = window.RESDOGS;
  const state = {
    boundary: B.defaultBoundary,
    metric: B.defaultMetric,
    period: B.defaultPeriod,
    metricValues: [],       // [{i,name,label,value,count}]
    valuesByName: new Map(),
    featureColors: new Map(),
    features: [],
    centroids: [],
    selected: new Set(),    // polygon indexes
    multiSelect: false,
    draft: JSON.parse(JSON.stringify(B.defaultFilters)),
    applied: JSON.parse(JSON.stringify(B.defaultFilters)),
    scaleOn: false,
    autoScale: true,
    reverse: false,
    customMin: null,
    customMax: null,
    vmin: 0,
    vmax: 1,
    tool: 'select',
    reportOpen: false,
    zipFallback: {},   // polygon name -> rows placed by proximity
    map: null,
    loadedBoundary: null,
  };
  state.draft.period = state.period;
  state.applied.period = state.period;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ── formatting (mirrors new kwizi/src/lib/legendFormat.ts) ─────────────────
  const METRIC_FMT = Object.fromEntries(B.metrics.map((m) => [m.key, m.fmt]));
  function formatValue(metric, v) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
    const n = Number(v);
    const f = METRIC_FMT[metric] || 'number';
    if (f === 'money') {
      if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
      if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
      return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    }
    if (f === 'money2') return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (f === 'pct') return n.toFixed(0) + '%';
    if (f === 'pct4') return n.toFixed(4) + '%';
    if (f === 'days') return Math.round(n) + 'd';
    if (f === 'ratio') return n.toFixed(2);
    if (f === 'score') return n.toFixed(0);
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  function formatInput(metric, v) {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    const f = METRIC_FMT[metric] || 'number';
    if (f === 'money' || f === 'money2') return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (f === 'pct') return n.toFixed(0) + '%';
    if (f === 'pct4') return n.toFixed(4) + '%';
    if (f === 'days') return Math.round(n) + 'd';
    if (f === 'ratio') return n.toFixed(2);
    if (f === 'score') return n.toFixed(0);
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  const money = (n) => (n === null || n === undefined ? '—' : '$' + Math.round(n).toLocaleString());
  const compact = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 }));

  // ── colour ramp (the owner's rule: solid blue until Scale Range is on) ────
  function hexToRgb(h) {
    return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
  }
  function colorFor(value, stops, solid) {
    if (value === null || value === undefined) return 'rgba(0,0,0,0)';
    if (!stops || !stops.length) return solid || '#2c7be5';
    const t = (value - stops[0][0]) / Math.max(1e-9, stops[stops.length - 1][0] - stops[0][0]);
    const clamped = Math.max(0, Math.min(1, t));
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i];
      const [t1, c1] = stops[i + 1];
      const f0 = (t0 - stops[0][0]) / Math.max(1e-9, stops[stops.length - 1][0] - stops[0][0]);
      const f1 = (t1 - stops[0][0]) / Math.max(1e-9, stops[stops.length - 1][0] - stops[0][0]);
      if (clamped <= f1) {
        const k = (clamped - f0) / Math.max(1e-9, f1 - f0);
        const a = hexToRgb(c0), b2 = hexToRgb(c1);
        return '#' + [0, 1, 2].map((j) => Math.round(a[j] + (b2[j] - a[j]) * k).toString(16).padStart(2, '0')).join('');
      }
    }
    return stops[stops.length - 1][1];
  }
  function currentStops() {
    if (!state.scaleOn) return [];
    const palette = state.reverse ? B.palette.slice().reverse() : B.palette;
    const lo = state.autoScale ? state.vmin : (state.customMin ?? state.vmin);
    const hi = state.autoScale ? state.vmax : (state.customMax ?? state.vmax);
    const span = Math.max(1e-9, hi - lo);
    return palette.map((c, i) => [lo + (span * i) / (palette.length - 1), c]);
  }

  // ── API ───────────────────────────────────────────────────────────────────
  function filterQuery() {
    const params = new URLSearchParams();
    Object.keys(state.applied).forEach((k) => {
      const v = state.applied[k];
      if (Array.isArray(v)) { if (v.length) params.set(k, v.join('|')); }
      else if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
    });
    params.set('period', state.period);
    return params;
  }
  async function api(path, params) {
    const url = path + (params ? '?' + params.toString() : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(path + ' HTTP ' + res.status);
    return res.json();
  }

  // ── map ───────────────────────────────────────────────────────────────────
  function initMap() {
    const map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [-95.3698, 29.7604],
      zoom: 9.4,
      maxZoom: 18,
      maxBounds: [[-107.0, 25.7], [-93.3, 36.8]],
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    state.map = map;

    map.on('load', () => {
      map.addSource('areas', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: 'i',
      });
      map.addLayer({
        id: 'areas-fill', type: 'fill', source: 'areas',
        paint: { 'fill-color': '#2c7be5', 'fill-opacity': 0.5 },
      });
      map.addLayer({
        id: 'areas-line', type: 'line', source: 'areas',
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.75, 'line-width': 0.75 },
      });
      map.on('mousemove', 'areas-fill', onHover);
      map.on('mouseleave', 'areas-fill', () => { state.popup && state.popup.remove(); });
      map.on('click', 'areas-fill', onClickPolygon);
      map.on('mousemove', () => { if (state.tool !== 'select') map.getCanvas().style.cursor = 'crosshair'; });
    });
  }

  // Center the view on the areas that actually exist (the old app did the
  // same), instead of a fixed Houston center.
  function fitToAreas() {
    if (!state.map || !state.features.length) return;
    const bounds = new maplibregl.LngLatBounds();
    const extend = (coords) => {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === 'number') { bounds.extend([coords[0], coords[1]]); return; }
      coords.forEach(extend);
    };
    state.features.forEach((f) => extend(f.geometry && f.geometry.coordinates));
    if (bounds.isEmpty()) return;
    state.map.fitBounds(bounds, { padding: 24, maxZoom: 10.5, duration: 0 });
    // Stay inside the Texas lock: fitBounds can go below the configured zoom.
    if (state.map.getZoom() < 8) state.map.setZoom(8);
  }

  const popup = () => (state.popup = state.popup || new maplibregl.Popup({
    closeButton: false, closeOnClick: false, maxWidth: '280px',
  }));

  function onHover(e) {
    if (state.tool !== 'select' || !e.features.length) return;
    const f = e.features[0];
    const i = f.id != null ? Number(f.id) : Number(f.properties.i);
    const rec = state.metricValues[i];
    if (!rec) return;
    const metricLabel = (B.metrics.find((m) => m.key === state.metric) || {}).label || state.metric;
    const approx = state.zipFallback[rec.name] || state.zipFallback[String(rec.name || '').toUpperCase().replace(/\s+/g, ' ').trim()];
    const html =
      '<b class="pop-name">' + (rec.label || rec.name || '') + '</b>' +
      (rec.value == null ? '' : '<span class="pop-val">' + metricLabel + ': ' + formatValue(state.metric, rec.value) + '</span><br>') +
      '<span class="pop-meta">' + Number(rec.count || 0).toLocaleString() + ' properties</span>' +
      (approx ? '<br><span class="pop-meta" style="color:#fbbf24">incl. ' + Number(approx).toLocaleString() + ' placed by proximity (approximate)</span>' : '');
    popup().setLngLat(e.lngLat).setHTML(html).addTo(state.map);
    state.map.getCanvas().style.cursor = 'pointer';
  }

  function onClickPolygon(e) {
    if (document.body.classList.contains('plan-locked')) return;
    if (state.tool !== 'select' || !e.features.length) return;
    const f = e.features[0];
    const i = f.id != null ? Number(f.id) : Number(f.properties.i);
    if (state.multiSelect) {
      if (state.selected.has(i)) state.selected.delete(i);
      else state.selected.add(i);
    } else {
      if (state.selected.size === 1 && state.selected.has(i)) state.selected.clear();
      else { state.selected.clear(); state.selected.add(i); }
    }
    syncSelection();
  }

  function selectedNames() {
    const out = [];
    state.selected.forEach((i) => {
      const f = state.features[i];
      const name = f && f.properties && f.properties.name;
      if (name) out.push(name);
    });
    return out;
  }

  function syncSelection() {
    if (!state.map || !state.map.getLayer('areas-line')) return;
    state.features.forEach((_, idx) => {
      const base = (state.featureColors && state.featureColors.get(idx)) || { hasValue: false, color: 'rgba(0,0,0,0)' };
      state.map.setFeatureState(
        { source: 'areas', id: idx },
        { ...base, selected: state.selected.has(idx) },
      );
    });
    state.map.setPaintProperty('areas-line', 'line-color', ['case', ['boolean', ['feature-state', 'selected'], false], '#ec4899', '#ffffff']);
    state.map.setPaintProperty('areas-line', 'line-width', ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, 0.75]);
    $('#sum-selected').textContent = String(state.selected.size);
    const reportBtn = $('#tool-report');
    const locked = document.body.classList.contains('plan-locked');
    reportBtn.hidden = locked || state.selected.size === 0 || state.reportOpen;
    if (state.reportOpen) renderReport();
  }

  // ── load + draw ───────────────────────────────────────────────────────────
  async function loadBoundary(boundary) {
    showOverlay('Loading Boundary Data...', 'Drawing areas from the published boundary file.');
    const fc = await api('/api/geojson', new URLSearchParams({ boundary }));
    state.features = (fc.features || []).map((f, i) => ({
      type: 'Feature',
      id: i,
      geometry: f.geometry,
      properties: { ...f.properties, i },
    }));
    state.centroids = state.features.map((f) => centroid(f.geometry));
    state.loadedBoundary = boundary;
    if (state.map && state.map.getSource('areas')) {
      state.map.getSource('areas').setData({ type: 'FeatureCollection', features: state.features });
      fitToAreas();
    }
    hideOverlay();
    return state.features.length;
  }

  function centroid(geometry) {
    let ring = null;
    if (!geometry) return null;
    if (geometry.type === 'Polygon') ring = geometry.coordinates[0];
    else if (geometry.type === 'MultiPolygon' && geometry.coordinates[0]) ring = geometry.coordinates[0][0];
    if (!ring || !ring.length) return null;
    let x = 0, y = 0;
    ring.forEach((c) => { x += c[0]; y += c[1]; });
    return [x / ring.length, y / ring.length];
  }

  async function loadValues() {
    showOverlay('Loading Data...', 'Fetching the market dataset for the map.');
    const params = filterQuery();
    params.set('boundary', state.boundary);
    params.set('metric', state.metric);
    const data = await api('/api/map', params);
    state.metricValues = data.values || [];
    state.vmin = data.vmin;
    state.vmax = data.vmax;
    state.valuesByName = new Map();
    state.metricValues.forEach((v) => { if (v.name) state.valuesByName.set(v.name, v); });
    paint();
    updateSummary();
    hideOverlay();
  }

  function paint() {
    if (!state.map || !state.map.getLayer('areas-fill')) return;
    const map = state.map;
    const stops = currentStops();
    let painted = 0;
    // Per-feature state, not a 4 000-branch `match` expression: MapLibre's
    // expression compiler chokes on expressions that large and the layer
    // stops drawing entirely.
    state.featureColors = new Map();
    state.metricValues.forEach((v) => {
      const id = Number(v.i);
      const has = v.value !== null && v.value !== undefined;
      const color = has ? colorFor(v.value, stops, '#2c7be5') : 'rgba(0,0,0,0)';
      if (has) painted++;
      state.featureColors.set(id, { hasValue: has, color });
      map.setFeatureState(
        { source: 'areas', id },
        { hasValue: has, color, selected: state.selected.has(id) },
      );
    });
    map.setPaintProperty('areas-fill', 'fill-color', [
      'case',
      ['boolean', ['feature-state', 'hasValue'], false],
      ['feature-state', 'color'],
      'rgba(0,0,0,0)',
    ]);
    map.setPaintProperty('areas-fill', 'fill-opacity', 0.5);
    $('#map-count').textContent = `${painted.toLocaleString()} areas with data`;
    $('#sum-areas').textContent = painted.toLocaleString();
  }

  /** Period text with the EXACT range for rolling windows. The original
   *  analytics app shows "Sep 30, 2025 – Sep 30, 2026"; without the dates
   *  "Last 12 months" was being mistaken for "Calendar 2025". */
  function periodLabel(key) {
    const p = B.periods.find((x) => x.key === key) || B.periods[0];
    if (!p) return '';
    if (!B.referenceDate) return p.label;
    const ref = new Date(`${B.referenceDate}T00:00:00`);
    if (isNaN(ref.getTime())) return p.label;
    const start = new Date(ref);
    if (/^r?[1-5]y$/.test(key)) {
      const n = Number(key.replace(/\D/g, ''));
      start.setFullYear(start.getFullYear() - n);
    } else if (key === '6m') {
      start.setMonth(start.getMonth() - 6);
    } else if (key === '30d') {
      start.setDate(start.getDate() - 30);
    } else if (key === '90d') {
      start.setDate(start.getDate() - 90);
    } else {
      return p.label;
    }
    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${p.label.replace(' (rolling)', '')} (${fmt(start)} – ${fmt(ref)})`;
  }

  function updateSummary() {
    const b = B.boundaries.find((x) => x.key === state.boundary) || B.boundaries[0];
    const m = B.metrics.find((x) => x.key === state.metric) || B.metrics[0];
    const p = B.periods.find((x) => x.key === state.period) || B.periods[0];
    $('#sum-boundary').textContent = b.name;
    $('#sum-metric').textContent = m.label;
    $('#sum-period').textContent = periodLabel(state.period);
    const schools = []
      .concat(state.applied.schoolDistricts || [])
      .concat(state.applied.elementary || [])
      .concat(state.applied.middle || [])
      .concat(state.applied.highschools || []);
    $('#sum-schools').textContent = schools.length ? `${schools.length} active` : 'None';
    const count = state.metricValues.reduce((acc, v) => acc + (v.count || 0), 0);
    $('#sum-props').textContent = count.toLocaleString();
    $('#sum-selected').textContent = String(state.selected.size);
    // Scale bar
    if (state.scaleOn) {
      const { lo, hi } = scaleValues();
      const stops = currentStops();
      $('#scale-bar').style.background = `linear-gradient(to right, ${stops.map((s) => s[1]).join(', ')})`;
      $('#scale-min-label').textContent = formatValue(state.metric, lo);
      $('#scale-max-label').textContent = formatValue(state.metric, hi);
      setScaleHandlePositions();
    }
  }

  /** Current Min/Max of the colour scale (custom when Auto scale is off). */
  function scaleValues() {
    return {
      lo: state.autoScale ? state.vmin : (state.customMin ?? state.vmin),
      hi: state.autoScale ? state.vmax : (state.customMax ?? state.vmax),
    };
  }

  /** Put the two handles and the dimmed margins where the current range is. */
  function setScaleHandlePositions() {
    const minH = $('#scale-handle-min');
    const maxH = $('#scale-handle-max');
    if (!minH || !maxH) return;
    const span = (state.vmax - state.vmin) || 1;
    const { lo, hi } = scaleValues();
    const pct = (v) => Math.max(0, Math.min(100, ((v - state.vmin) / span) * 100));
    const pLo = pct(lo);
    const pHi = pct(hi);
    minH.style.left = `${pLo}%`;
    maxH.style.left = `${pHi}%`;
    const dimL = $('#scale-dim-l');
    const dimR = $('#scale-dim-r');
    if (dimL) {
      dimL.hidden = pLo <= 0.01;
      dimL.style.width = `${pLo}%`;
    }
    if (dimR) {
      dimR.hidden = pHi >= 99.99;
      dimR.style.width = `${100 - pHi}%`;
    }
  }

  async function refreshAll() {
    setHeaderLoading(true);
    try {
      if (state.loadedBoundary !== state.boundary) await loadBoundary(state.boundary);
      await loadValues();
      if (state.reportOpen) await renderReport();
    } catch (err) {
      console.error(err);
      toast('Could not load the dataset. ' + (err.message || ''));
    } finally {
      setHeaderLoading(false);
    }
  }

  // ── tools: box / lasso ────────────────────────────────────────────────────
  function setTool(tool) {
    state.tool = tool;
    ['select', 'box', 'lasso'].forEach((t) => $('#tool-' + t).classList.toggle('active', t === tool));
    const map = state.map;
    if (!map) return;
    const hint = $('#tool-hint');
    if (tool === 'select') {
      map.dragPan.enable();
      hint.hidden = true;
      canvas().style.pointerEvents = 'none';
      map.getCanvas().style.cursor = '';
    } else {
      map.dragPan.disable();
      canvas().style.pointerEvents = 'auto';
      canvas().style.cursor = 'crosshair';
      hint.hidden = false;
      hint.textContent = tool === 'box'
        ? 'Click and drag on the map to draw a selection box'
        : 'Draw a freehand shape to select areas inside';
    }
  }

  function canvas() {
    return $('#draw-canvas');
  }

  function initDrawCanvas() {
    const c = document.createElement('canvas');
    c.id = 'draw-canvas';
    Object.assign(c.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: 600,
    });
    $('.map-host').appendChild(c);
    const resize = () => {
      const host = $('.map-host');
      c.width = host.offsetWidth;
      c.height = host.offsetHeight;
    };
    resize();
    window.addEventListener('resize', resize);
    state.resizeCanvas = resize;

    let drawing = false, start = null, current = null, lasso = [];
    const ctx = c.getContext('2d');
    const clear = () => ctx.clearRect(0, 0, c.width, c.height);
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('mousedown', (e) => {
      if (state.tool === 'select') return;
      e.preventDefault(); drawing = true;
      start = pos(e); current = start; lasso = [start];
    });
    c.addEventListener('mousemove', (e) => {
      if (!drawing || state.tool === 'select') return;
      e.preventDefault(); current = pos(e);
      clear();
      ctx.save(); ctx.strokeStyle = '#2c7be5'; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
      ctx.fillStyle = 'rgba(44,123,229,.12)';
      if (state.tool === 'box') {
        const x = Math.min(start.x, current.x), y = Math.min(start.y, current.y);
        const w = Math.abs(current.x - start.x), h = Math.abs(current.y - start.y);
        ctx.strokeRect(x, y, w, h); ctx.fillRect(x, y, w, h);
      } else {
        lasso.push(current);
        ctx.beginPath(); ctx.moveTo(lasso[0].x, lasso[0].y);
        for (let i = 1; i < lasso.length; i++) ctx.lineTo(lasso[i].x, lasso[i].y);
        ctx.closePath(); ctx.stroke(); ctx.fill();
      }
      ctx.restore();
    });
    const finish = () => {
      if (!drawing) return;
      drawing = false;
      if (state.tool === 'box') {
        const x0 = Math.min(start.x, current.x), y0 = Math.min(start.y, current.y);
        const x1 = Math.max(start.x, current.x), y1 = Math.max(start.y, current.y);
        if (x1 - x0 >= 4 && y1 - y0 >= 4) {
          state.centroids.forEach((ll, i) => {
            if (!ll) return;
            const p = state.map.project(ll);
            if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) state.selected.add(i);
          });
        }
      } else if (lasso.length >= 3) {
        state.centroids.forEach((ll, i) => {
          if (!ll) return;
          const p = state.map.project(ll);
          if (pointInPolygon(p.x, p.y, lasso)) state.selected.add(i);
        });
      }
      clear(); syncSelection();
      if (state.selected.size) setTool('select');
    };
    c.addEventListener('mouseup', (e) => { e.preventDefault(); finish(); });
    c.addEventListener('mouseleave', () => { if (drawing) finish(); });
  }

  function pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // ── report ────────────────────────────────────────────────────────────────
  async function renderReport() {
    const params = filterQuery();
    params.set('boundary', state.boundary);
    params.set('metric', state.metric);
    params.set('selected', selectedNames().join('|'));
    const data = await api('/api/report', params);
    renderQuickStats(data.stats);
    renderMarketHealth(data.marketHealth);
    renderSalesTaxRent(data.stats);
    renderTimeSeries(data.timeSeries);
    renderTopAreas(data.topAreas);
    renderYearBuilt(data.yearBuilt);
    renderForecast(data.forecast, data.monthly);
    $('#report-rows').textContent = `${Number(data.stats.count || 0).toLocaleString()} rows`;
    $('#report-sel').textContent = state.selected.size
      ? `${state.selected.size} area${state.selected.size === 1 ? '' : 's'} selected`
      : 'All visible areas';
    // Every card gets its "pin to the map" button, and any window already on
    // the map picks up the fresh numbers from this report.
    syncPinButtons();
    refreshMapWindows();
  }

  /** Cards are interactive: clicking a stat colours the map by that metric. */
  function setMetric(key) {
    if (!key || !B.metrics.some((m) => m.key === key)) return;
    state.metric = key;
    const lab = $('#metric-label');
    if (lab) lab.textContent = (B.metrics.find((m) => m.key === key) || {}).label || key;
    refreshAll();
  }

  function renderQuickStats(s) {
    const tiles = [
      { k: 'Properties', v: compact(s.count), c: '#fff', metric: null, hint: 'Rows in this selection' },
      { k: 'Avg Price', v: money(s.avgSale), c: '#2c7be5', metric: 'Close Price', hint: 'Click: colour the map by Sales Price' },
      { k: '$/SqFt', v: money(s.avgSqft), c: '#00d4ff', metric: 'Price per Sqft', hint: 'Click: colour the map by Sale Price / Sq.Ft.' },
      { k: 'Avg DOM', v: `${Math.round(s.avgDom || 0)}d`, c: '#a855f7', metric: 'Days on Market', hint: 'Click: colour the map by Sale Days on Market' },
    ];
    $('#quick-stats').innerHTML =
      tiles.map((t) => `<div class="tile${t.metric ? ' clickable' : ''}" ${t.metric ? `data-metric="${t.metric}"` : ''} title="${t.hint}"><span class="k">${t.k}</span><span class="v" style="color:${t.c}">${t.v}</span></div>`).join('') +
      `<div class="tile wide" title="Sum of the closed sale prices in this selection"><span class="k">Total Volume</span><span class="v">${money(s.totalVolume)}</span></div>`;
    $$('#quick-stats .tile[data-metric]').forEach((el) => el.addEventListener('click', () => setMetric(el.dataset.metric)));
  }

  function renderMarketHealth(h) {
    if (!h) {
      $('#market-health').innerHTML = '<div class="empty-state">Select one or more areas to calculate market health.</div>';
      return;
    }
    const pct = Math.max(0, Math.min(100, h.score));
    const r = 70, circ = Math.PI * r;
    const offset = circ - (pct / 100) * circ;
    const rows = [
      ['Months Inv.', h.moi != null ? h.moi.toFixed(1) : null],
      ['Days on Mkt.', h.dom != null ? Math.round(h.dom) + 'd' : null],
      ['List/Sale %', h.l2s != null ? h.l2s.toFixed(1) + '%' : null],
      ['Volume Trend', h.volumeTrend != null ? (h.volumeTrend >= 0 ? '+' : '') + h.volumeTrend.toFixed(1) + '%' : null],
    ].filter((r2) => r2[1] !== null);
    $('#market-health').innerHTML = `
      <div class="gauge-wrap">
        <svg viewBox="0 0 180 100" style="width:11rem;height:6rem">
          <path d="M 20 90 A 70 70 0 0 1 160 90" fill="none" stroke="#ffffff12" stroke-width="12" stroke-linecap="round"/>
          <path d="M 20 90 A 70 70 0 0 1 160 90" fill="none" stroke="${h.color}" stroke-width="12"
                stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
        </svg>
        <div class="gauge-val" style="color:${h.color}">${pct.toFixed(0)}</div>
        <div class="gauge-label" style="color:${h.color}">${h.label}</div>
        <div class="gauge-scale"><span>Buyer's</span><span>Neutral</span><span>Seller's</span></div>
      </div>
      <div class="stat-grid">
        ${rows.map(([k, v]) => `<div class="stat-tile"><div class="k">${k}</div><div class="v" ${k === 'Volume Trend' ? `style="color:${(h.volumeTrend || 0) >= 0 ? '#34d399' : '#fb7185'}"` : ''}>${v}</div></div>`).join('')}
      </div>`;
  }

  function renderSalesTaxRent(s) {
    const sales = `
      <div class="subpanel clickable" data-metric="Close Price" title="Click: colour the map by Sales Price">
        <div class="h" style="color:#60a5fa">Sales</div>
        <div style="display:flex;flex-direction:column;gap:.375rem">
          <div class="subrow"><span class="k">Properties</span><span class="v">${compact(s.count)}</span></div>
          <div class="subrow"><span class="k">Avg Sale Price</span><span class="v">${money(s.avgSale)}</span></div>
          <div class="subrow"><span class="k">$/SqFt</span><span class="v">${money(s.avgSqft)}</span></div>
          <div class="subrow"><span class="k">Avg DOM</span><span class="v">${Math.round(s.avgDom || 0)}d</span></div>
          <div class="subrow"><span class="k">Total Volume</span><span class="v">${money(s.totalVolume)}</span></div>
        </div>
      </div>`;
    const tax = s.taxCoverage > 0 ? `
      <div class="subpanel clickable" data-metric="Last Year Tax Rate" title="Click: colour the map by Last Year Tax Rate">
        <div class="h" style="color:#fbbf24">Tax</div>
        <div style="display:flex;flex-direction:column;gap:.375rem">
          <div class="subrow"><span class="k">Avg Annual Tax</span><span class="v">${money(s.avgTaxAmount)}/yr</span></div>
          <div class="subrow"><span class="k">Avg Tax Rate</span><span class="v">${(s.avgTaxRate || 0).toFixed(2)}%</span></div>
          <div class="subrow"><span class="k">Data Coverage</span><span class="v">${Math.round(s.taxCoverage * 100)}%</span></div>
          <div class="subrow"><span class="k">Properties with Tax</span><span class="v">${compact(Math.round(s.taxCoverage * s.count))}</span></div>
        </div>
      </div>` : `
      <div class="subpanel clickable" data-metric="Last Year Tax Rate" title="Click: colour the map by Last Year Tax Rate">
        <div class="h" style="color:#fbbf24">Tax</div>
        <div class="empty">No tax records in this selection yet.</div>
      </div>`;
    const rent = (s.rentCount > 0 && (s.medianRent || 0) > 0) ? `
      <div class="subpanel clickable" data-metric="Est. Rental Price" title="Click: colour the map by Rental Price">
        <div class="h" style="color:#fb923c">Rent (real)</div>
        <div style="display:flex;flex-direction:column;gap:.375rem">
          <div class="subrow"><span class="k">Median Monthly Rent</span><span class="v">${money(s.medianRent)}/mo</span></div>
          ${s.medianRentPsf ? `<div class="subrow"><span class="k">Median Rent $/SqFt</span><span class="v">$${s.medianRentPsf.toFixed(2)}/sqft</span></div>` : ''}
          <div class="subrow"><span class="k">Annualized Rent</span><span class="v">${money((s.medianRent || 0) * 12)}/yr</span></div>
          <div class="subrow"><span class="k">Rental Rows</span><span class="v">${compact(s.rentCount)}</span></div>
        </div>
      </div>` : `
      <div class="subpanel">
        <div class="h" style="color:#fb923c">Rent</div>
        <div class="empty">No rental records in this selection yet.</div>
      </div>`;
    $('#sales-tax-rent').innerHTML = `
      <div class="report-grid" style="grid-template-columns:repeat(3,1fr)">
        ${sales}${tax}${rent}
      </div>
      <div class="footnote">Rent values are REAL rental medians — never estimates. Tax figures are merged by MLS number. Click a panel to colour the map by that metric.</div>`;
    $$('#sales-tax-rent .subpanel[data-metric]').forEach((el) => el.addEventListener('click', () => setMetric(el.dataset.metric)));
  }

  function renderTimeSeries(series) {
    const host = $('#time-series');
    if (!series || series.length < 3) {
      host.innerHTML = `<div class="empty-state">${series && series.length ? 'Not enough periods for a trend — try a longer time range.' : 'Select an area to see its time series.'}</div>`;
      return;
    }
    const vals = series.map((p) => p.value).filter((v) => v != null);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const W = 520, H = 190, pad = 12;
    const pts = series.map((p, i) => {
      const x = pad + (i * (W - pad * 2)) / Math.max(1, series.length - 1);
      const y = H - pad - ((p.value - lo) / Math.max(1e-9, hi - lo)) * (H - pad * 2);
      return [x, y, p];
    });
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const area = `${path} L${pts[pts.length - 1][0].toFixed(1)},${H - pad} L${pts[0][0].toFixed(1)},${H - pad} Z`;
    host.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:13rem">
        <defs><linearGradient id="tsGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stop-color="#2c7be5" stop-opacity=".4"/>
          <stop offset="95%" stop-color="#2c7be5" stop-opacity="0"/>
        </linearGradient></defs>
        ${[0.25, 0.5, 0.75].map((f) => `<line x1="${pad}" x2="${W - pad}" y1="${(H - pad) - f * (H - pad * 2)}" y2="${(H - pad) - f * (H - pad * 2)}" stroke="#ffffff10" stroke-dasharray="3 3"/>`).join('')}
        <path d="${area}" fill="url(#tsGrad)"/>
        <path d="${path}" fill="none" stroke="#2c7be5" stroke-width="2"/>
        ${pts.map((p) => `<circle class="ts-dot" data-period="${p[2].period}" data-value="${p[2].value}" data-count="${Number(p[2].count || 0)}" cx="${p[0]}" cy="${p[1]}" r="4" fill="#2c7be5" style="cursor:pointer"><title>${p[2].period}: ${formatValue(state.metric, p[2].value)}${p[2].count ? ` · ${Number(p[2].count).toLocaleString()} properties` : ''}</title></circle>`).join('')}
        ${pts.map((p) => `<text x="${p[0]}" y="${H - 1}" fill="#6b7280" font-size="9" text-anchor="middle">${p[2].period}</text>`).join('')}
      </svg>
      <div class="fc-tip" hidden></div>`;
    host.style.position = 'relative';
    const tip = host.querySelector('.fc-tip');
    host.querySelectorAll('.ts-dot').forEach((dot) => {
      dot.addEventListener('mousemove', (ev) => {
        const r = host.getBoundingClientRect();
        tip.innerHTML = `<b>${dot.dataset.period}</b><br>${formatValue(state.metric, Number(dot.dataset.value))}` +
          (Number(dot.dataset.count) ? `<br>${Number(dot.dataset.count).toLocaleString()} properties` : '');
        tip.hidden = false;
        tip.style.left = `${Math.min(r.width - 150, ev.clientX - r.left + 12)}px`;
        tip.style.top = `${ev.clientY - r.top + 12}px`;
      });
      dot.addEventListener('mouseleave', () => { tip.hidden = true; });
      dot.addEventListener('click', () => applyYearPeriod(Number(dot.dataset.period)));
    });
  }

  function renderTopAreas(areas) {
    const host = $('#top-areas');
    if (!areas || !areas.length) { host.innerHTML = '<div class="empty-state">No areas with data for this selection.</div>'; return; }
    const max = Math.max(...areas.map((a) => a.value || 0)) || 1;
    host.innerHTML = '<div class="bar-chart">' + areas.map((a) => `
      <div class="bar-row clickable" data-area="${String(a.name || '').replace(/"/g, '&quot;')}" title="${a.label}: ${formatValue(state.metric, a.value)} · ${Number(a.count || 0).toLocaleString()} properties — click to select it on the map">
        <span class="bar-name" title="${a.label}">${a.label}</span>
        <span class="bar-val">${formatValue(state.metric, a.value)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, ((a.value || 0) / max) * 100)}%;background:#2c7be5"></div></div>
      </div>`).join('') + '</div>';
    // Interactive: clicking a bar selects that area on the map (same as
    // clicking its polygon), so the report follows the selection.
    host.querySelectorAll('[data-area]').forEach((row) => {
      row.addEventListener('click', () => {
        const name = row.dataset.area;
        const hit = state.metricValues.find((v) => v.name === name || v.label === name);
        if (!hit) return;
        if (state.multiSelect) {
          if (state.selected.has(hit.i)) state.selected.delete(hit.i);
          else state.selected.add(hit.i);
        } else {
          state.selected = new Set([hit.i]);
        }
        syncSelection();
        if (state.reportOpen) renderReport();
      });
    });
  }

  function renderYearBuilt(buckets) {
    const host = $('#year-built');
    const total = buckets.reduce((a, b) => a + b.count, 0);
    if (!total) { host.innerHTML = '<div class="empty-state">No year-built data for this selection.</div>'; return; }
    const colors = ['#2c7be5', '#00d4ff', '#7c3aed', '#f59e0b', '#10b981'];
    host.innerHTML = '<div class="bar-chart">' + buckets.map((b, i) => `
      <div class="bar-row" title="${b.bucket}: ${b.count.toLocaleString()} properties (${(100 * b.count / total).toFixed(1)}%)">
        <span class="bar-name">${b.bucket}</span>
        <span class="bar-val">${b.count.toLocaleString()}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (b.count / total) * 100)}%;background:${colors[i] || colors[0]}"></div></div>
      </div>`).join('') + '</div>';
  }

  /** 5-Year Forecast — the old app's card, fitted on the uploaded periods. */
  const FC_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const FC_COLORS = ['#2c7be5','#f59e0b','#10b981','#fb923c','#a855f7','#eab308','#0ea5e9','#f472b6','#84cc16','#ec4899','#8b5cf6','#facc15'];
  let fcHiddenMonths = new Set();

  function monthlyChartSvg(monthly) {
    const years = Array.from(new Set(monthly.map((d) => d.year))).sort();
    if (!years.length) return '<div class="empty-state">No monthly data for this selection.</div>';
    const W = 1200, H = 230, pl = 46, pr = 12, pt = 12, pb = 26;
    const plotW = W - pl - pr, plotH = H - pt - pb;
    const visible = monthly.filter((d) => !fcHiddenMonths.has(d.month));
    const max = Math.max(...visible.map((d) => d.count), 1);
    const gw = plotW / years.length;
    const bw = Math.max(2, (gw * 0.88) / 12);
    const yFor = (v) => pt + plotH - (v / max) * plotH;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) =>
      `<line x1="${pl}" x2="${W - pr}" y1="${yFor(max * f).toFixed(1)}" y2="${yFor(max * f).toFixed(1)}" stroke="#ffffff14"/>` +
      `<text x="${pl - 6}" y="${(yFor(max * f) + 3).toFixed(1)}" fill="#6b7280" font-size="10" text-anchor="end">${Math.round(max * f)}</text>`
    ).join('');
    const bars = visible.map((d) => {
      const gi = years.indexOf(d.year), mi = d.month - 1;
      const x = pl + gi * gw + gw * 0.06 + mi * bw;
      const h = Math.max(1, (d.count / max) * plotH);
      return `<rect class="fc-bar" data-y="${d.year}" data-m="${d.month}" data-n="${d.count}" data-v="${d.value == null ? '' : d.value}" x="${x.toFixed(1)}" y="${(pt + plotH - h).toFixed(1)}" width="${(bw * 0.92).toFixed(1)}" height="${h.toFixed(1)}" fill="${FC_COLORS[mi]}" rx="1"/>`;
    }).join('');
    const labels = years.map((yr, i) => `<text class="fc-year" data-year="${yr}" x="${(pl + i * gw + gw / 2).toFixed(1)}" y="${H - 4}" fill="#9ca3af" font-size="11" text-anchor="middle" style="cursor:pointer">${yr}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">${grid}${bars}${labels}</svg>`;
  }

  function renderForecast(f, monthly) {
    const host = $('#forecast');
    if (!monthly || !monthly.length) {
      host.innerHTML = '<div class="empty-state">No monthly data for this selection.</div>';
      return;
    }
    const legend = FC_MONTHS.map((m, i) =>
      `<button type="button" class="fc-chip${fcHiddenMonths.has(i + 1) ? ' off' : ''}" data-month="${i + 1}"><span class="fc-dot" style="background:${FC_COLORS[i]}"></span>${m}</button>`
    ).join('');
    host.innerHTML = `
      <div class="fc-legend">${legend}</div>
      <div class="fc-chart" style="position:relative;margin-top:.6rem">
        ${monthlyChartSvg(monthly)}
        <div class="fc-tip" hidden></div>
      </div>
      <table class="fc-table">
        <thead><tr><th>Year</th><th>Properties</th><th>Median</th></tr></thead>
        <tbody>
          ${(f && f.periods ? f.periods : []).map((p, i) => `<tr class="fc-row" data-year="${p}">
            <td>${p}</td><td>${Number((f.counts || [])[i] || 0).toLocaleString()}</td>
            <td>${f.actual[i] == null ? '—' : formatValue(state.metric, f.actual[i])}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="footnote">Properties closed per month and year (real uploaded data). Hover a bar for its numbers; click a month to show/hide it; click a year (bar chart or list) to filter the report.</div>`;
    host.querySelectorAll('.fc-row').forEach((row) => row.addEventListener('click', () => applyYearPeriod(Number(row.dataset.year))));
    host.querySelectorAll('[data-month]').forEach((b) => b.addEventListener('click', () => {
      const m = Number(b.dataset.month);
      if (fcHiddenMonths.has(m)) fcHiddenMonths.delete(m); else fcHiddenMonths.add(m);
      renderForecast(f, monthly);
    }));
    const tip = host.querySelector('.fc-tip');
    const box = host.querySelector('.fc-chart');
    host.querySelectorAll('.fc-bar').forEach((bar) => {
      bar.addEventListener('mousemove', (ev) => {
        const r = box.getBoundingClientRect();
        const m = Number(bar.dataset.m), n = Number(bar.dataset.n);
        const v = bar.dataset.v ? Number(bar.dataset.v) : null;
        tip.innerHTML = `<b>${FC_MONTHS[m - 1]} ${bar.dataset.y}</b><br>${n.toLocaleString()} properties` +
          (v != null ? `<br>median ${formatValue(state.metric, v)}` : '');
        tip.hidden = false;
        tip.style.left = `${Math.min(r.width - 150, ev.clientX - r.left + 12)}px`;
        tip.style.top = `${ev.clientY - r.top + 12}px`;
      });
      bar.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
    host.querySelectorAll('.fc-year').forEach((el) => el.addEventListener('click', () => {
      applyYearPeriod(Number(el.dataset.year));
    }));
  }

  /** Clicking a year in the Forecast bars filters the report to that year. */
  function applyYearPeriod(year) {
    const back = new Date().getFullYear() - year;
    const key = back >= 1 && back <= 5 ? `${back}y` : 'all';
    state.period = key; state.draft.period = key; state.applied.period = key;
    const lab = $('#period-label');
    if (lab) lab.textContent = periodLabel(key);
    refreshAll();
  }

  // ── UI wiring ─────────────────────────────────────────────────────────────
  function setHeaderLoading(on) {
    $('#header-status').hidden = !on;
    if (on) showOverlay('Loading Data...', 'Fetching the market dataset for the map.');
  }
  function showOverlay(title, desc) {
    $('#overlay-title').textContent = title;
    $('#overlay-desc').textContent = desc;
    $('#map-overlay').hidden = false;
  }
  function hideOverlay() { $('#map-overlay').hidden = true; }
  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function initSections() {
    $$('.section-head').forEach((head) => {
      head.addEventListener('click', () => {
        const body = head.nextElementSibling;
        const chev = head.querySelector('.chev');
        body.hidden = !body.hidden;
        chev.classList.toggle('open', !body.hidden);
      });
    });
    // sections with content visible by default
    $$('.section').forEach((s) => {
      const body = s.querySelector('.section-body');
      const chev = s.querySelector('.chev');
      if (body && !body.hidden) chev.classList.add('open');
    });
  }

  // The dropdown panels live in <body> and are positioned with `fixed`: inside
  // the sidebar's scroll container they were clipped halfway down.
  function placePanel(trigger, panel) {
    panel.style.position = 'fixed';
    panel.style.left = `${trigger.getBoundingClientRect().left}px`;
    panel.style.width = `${trigger.getBoundingClientRect().width}px`;
    panel.style.maxHeight = '18rem';
    panel.style.zIndex = '9500';
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const height = Math.min(panel.scrollHeight, 288);
    if (below < height + 12 && rect.top > height + 12) {
      panel.style.top = 'auto';
      panel.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    } else {
      panel.style.top = `${rect.bottom + 4}px`;
      panel.style.bottom = 'auto';
    }
  }

  function initSelects() {
    const pairs = [
      { trigger: $('#metric-trigger'), panel: $('#metric-panel'), kind: 'metric' },
      { trigger: $('#period-trigger'), panel: $('#period-panel'), kind: 'period' },
    ];
    pairs.forEach(({ trigger, panel }) => {
      document.body.appendChild(panel);
      panel.hidden = true;

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = panel.hidden;
        pairs.forEach((p) => { p.panel.hidden = true; });
        if (!willOpen) return;
        panel.hidden = false;
        placePanel(trigger, panel);
      });

      panel.querySelectorAll('.select-opt').forEach((b) => b.addEventListener('click', () => {
        if (pairs[0].panel === panel) {
          state.metric = b.dataset.metric;
          $('#metric-label').textContent = b.textContent;
        } else {
          state.period = b.dataset.period;
          state.draft.period = state.period;
          state.applied.period = state.period;
          $('#period-label').textContent = periodLabel(b.dataset.period);
        }
        panel.querySelectorAll('.select-opt').forEach((x) => x.classList.toggle('active', x === b));
        panel.hidden = true;
        refreshAll();
      }));
    });

    document.addEventListener('click', () => {
      pairs.forEach((p) => { p.panel.hidden = true; });
    });
    // Reposition on resize, close on scroll: a fixed panel would drift.
    // Scrolling INSIDE the panel must NOT close it (the Close Period list is
    // taller than its max-height and has to be scrollable).
    window.addEventListener('resize', () => pairs.forEach((p) => { p.panel.hidden = true; }));
    document.addEventListener('scroll', (e) => {
      const target = e.target;
      pairs.forEach((p) => {
        if (target instanceof Node && p.panel.contains(target)) return;
        p.panel.hidden = true;
      });
    }, true);
  }

  function initBoundary() {
    $$('#boundary-seg .seg-btn').forEach((b) => b.addEventListener('click', () => {
      if (state.boundary === b.dataset.boundary) return;
      state.boundary = b.dataset.boundary;
      state.selected.clear();
      $$('#boundary-seg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      refreshAll();
    }));
  }

  function initRanges() {
    $$('.range-pair').forEach((pair) => {
      const [lo, hi] = pair.querySelectorAll('input[type=range]');
      const wrap = pair.closest('[data-range]');
      const readout = wrap.querySelector('.range-value');
      const rc = B.rangeControls.find((r) => r.low === lo.dataset.key);
      const sync = () => {
        if (Number(lo.value) > Number(hi.value)) hi.value = lo.value;
        state.draft[lo.dataset.key] = Number(lo.value);
        state.draft[hi.dataset.key] = Number(hi.value);
        const anyLo = Number(lo.value) <= rc.min, anyHi = Number(hi.value) >= rc.max;
        readout.textContent = (anyLo && anyHi) ? 'Any'
          : `${anyLo ? 'Any' : fmtRange(rc, Number(lo.value))} – ${anyHi ? 'Any' : fmtRange(rc, Number(hi.value))}`;
        markDirty();
      };
      lo.addEventListener('input', sync);
      hi.addEventListener('input', sync);
    });
    $$('[data-filter]').forEach((el) => el.addEventListener('change', () => {
      const key = el.dataset.filter;
      state.draft[key] = (el.value === 'any' || el.value === '') ? (key === 'pool' ? 'any' : el.value) : el.value;
      if (el.value === 'any') state.draft[key] = 'any';
      markDirty();
    }));
  }

  function fmtRange(rc, n) {
    if (rc.fmt === 'money') return n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(0) + 'K' : '$' + n;
    if (rc.fmt === 'sqft') return n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n);
    if (rc.fmt === 'days') return n + 'd';
    if (rc.fmt === 'pct') return n + '%';
    return Number(n).toLocaleString();
  }

  function markDirty() {
    const dirty = JSON.stringify(state.draft) !== JSON.stringify(state.applied);
    $('#apply-filters').hidden = !dirty;
  }

  function applyFilters() {
    state.applied = JSON.parse(JSON.stringify(state.draft));
    $('#apply-filters').hidden = true;
    refreshAll();
  }

  function initScale() {
    const on = $('#scale-on');
    on.addEventListener('change', () => {
      state.scaleOn = on.checked;
      $('#scale-controls').hidden = !on.checked;
      $('#scale-off-hint').hidden = on.checked;
      paint(); updateSummary();
    });
    $('#auto-scale').addEventListener('change', (e) => {
      state.autoScale = e.target.checked;
      // Coming back to Auto drops any custom range.
      if (state.autoScale) { state.customMin = null; state.customMax = null; }
      updateSummary(); paint();
    });
    $('#reverse-colors').addEventListener('click', () => {
      state.reverse = !state.reverse;
      paint(); updateSummary();
    });
    initScaleDrag();
  }

  /** Drag the Min/Max handles on the colour bar (owner 2026-10-27: "I cannot
   *  manipulate the color bar scale"). Dragging while Auto scale is on turns
   *  Auto off and starts from the current data range. */
  function initScaleDrag() {
    const bar = $('#scale-bar');
    if (!bar) return;
    const handles = [
      { el: $('#scale-handle-min'), which: 'min' },
      { el: $('#scale-handle-max'), which: 'max' },
    ];
    handles.forEach(({ el, which }) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.autoScale) {
          state.customMin = state.vmin;
          state.customMax = state.vmax;
          state.autoScale = false;
          const auto = $('#auto-scale');
          if (auto) auto.checked = false;
        }
        state.customMin = state.customMin ?? state.vmin;
        state.customMax = state.customMax ?? state.vmax;
        el.classList.add('active');
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

        const onMove = (ev) => {
          const rect = bar.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
          const span = (state.vmax - state.vmin) || 1;
          const value = state.vmin + ratio * span;
          if (which === 'min') {
            state.customMin = Math.min(value, state.customMax);
            if (state.customMax <= state.customMin) state.customMax = Math.min(state.vmax, state.customMin + span * 0.01);
          } else {
            state.customMax = Math.max(value, state.customMin);
            if (state.customMin >= state.customMax) state.customMin = Math.max(state.vmin, state.customMax - span * 0.01);
          }
          updateSummary();
          paint();
        };
        const onUp = () => {
          el.classList.remove('active');
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerup', onUp);
          el.removeEventListener('pointercancel', onUp);
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
      });
    });
    setScaleHandlePositions();
  }

  function initMapTools() {
    $('#tool-select').addEventListener('click', () => setTool('select'));
    $('#tool-box').addEventListener('click', () => setTool('box'));
    $('#tool-lasso').addEventListener('click', () => setTool('lasso'));
    $('#tool-clear').addEventListener('click', () => { state.selected.clear(); syncSelection(); });
    $('#multi-select').addEventListener('change', (e) => { state.multiSelect = e.target.checked; });
    $('#apply-filters').addEventListener('click', applyFilters);
    $('#tool-report').addEventListener('click', async () => {
      state.reportOpen = true;
      $('#report').hidden = false;
      $('#tool-report').hidden = true;
      await renderReport();
      $('#report').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#report-back').addEventListener('click', () => {
      state.reportOpen = false;
      $('#report').hidden = true;
      syncSelection();
    });
    $('#report-print').addEventListener('click', () => window.print());
  }

  function initSidebar() {
    const sidebar = $('#sidebar'), backdrop = $('#backdrop');
    const open = (v) => {
      sidebar.classList.toggle('open', v);
      backdrop.hidden = !v;
      $('#toggle-label').textContent = v ? 'Hide filters' : 'Show filters';
    };
    $('#sidebar-toggle').addEventListener('click', () => open(!sidebar.classList.contains('open')));
    $('#sidebar-close').addEventListener('click', () => open(false));
    backdrop.addEventListener('click', () => open(false));
  }

  function initSearch() {
    let timer = null;
    const run = async () => {
      const term = $('#search-input').value.trim();
      const host = $('#search-results');
      if (!term) { host.innerHTML = ''; return; }
      const data = await api('/api/search', new URLSearchParams({ q: term, boundary: state.boundary }));
      host.innerHTML = (data.results || []).slice(0, 12).map((r) =>
        `<button class="reset-btn" style="justify-content:flex-start" data-hit="${r.name}">${r.label}</button>`
      ).join('') || '<div class="empty-state">No areas match.</div>';
      $$('#search-results [data-hit]').forEach((b) => b.addEventListener('click', () => {
        const idx = state.features.findIndex((f) => f.properties.name === b.dataset.hit);
        if (idx >= 0) {
          state.selected.clear(); state.selected.add(idx);
          const c = state.centroids[idx];
          if (c) state.map.flyTo({ center: c, zoom: 13 });
          syncSelection();
        }
        $('#search-results').innerHTML = '';
      }));
    };
    $('#search-input').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    $('#search-go').addEventListener('click', run);
  }

  function initReset() {
    $('#reset-all').addEventListener('click', () => {
      state.draft = JSON.parse(JSON.stringify(B.defaultFilters));
      state.applied = JSON.parse(JSON.stringify(B.defaultFilters));
      state.period = B.defaultPeriod;
      state.metric = B.defaultMetric;
      state.boundary = B.defaultBoundary;
      state.selected.clear();
      state.reportOpen = false;
      $('#report').hidden = true;
      $$('.range-pair').forEach((pair) => {
        const [lo, hi] = pair.querySelectorAll('input[type=range]');
        const rc = B.rangeControls.find((r) => r.low === lo.dataset.key);
        lo.value = rc.min; hi.value = rc.max;
        pair.closest('[data-range]').querySelector('.range-value').textContent = 'Any';
      });
      $$('[data-filter]').forEach((el) => { el.value = el.dataset.filter === 'pool' ? 'any' : '0'; });
      $$('.chip.active').forEach((c) => c.classList.remove('active'));
      $$('#boundary-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.boundary === state.boundary));
      $('#metric-label').textContent = (B.metrics.find((m) => m.key === state.metric) || {}).label;
      $('#period-label').textContent = (B.periods.find((p) => p.key === state.period) || {}).label;
      $('#apply-filters').hidden = true;
      state.scaleOn = false;
      $('#scale-on').checked = false;
      $('#scale-controls').hidden = true;
      $('#scale-off-hint').hidden = false;
      refreshAll();
    });
  }

  async function initSelectsData() {
    const fill = (sel, values, countId) => {
      const count = document.getElementById(countId);
      if (count) count.textContent = `(${values.length})`;
      if (!values.length) return;
      sel.innerHTML = values
        .map((v) => {
          const text = String(v);
          const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
          return `<option value="${safe}" title="${safe}">${safe}</option>`;
        })
        .join('');
    };
    try {
      const [types, cities, districts, elem, mid, high] = await Promise.all([
        api('/api/distinct', new URLSearchParams({ column: 'property_type' })),
        api('/api/distinct', new URLSearchParams({ column: 'city' })),
        api('/api/distinct', new URLSearchParams({ column: 'school_district' })),
        api('/api/distinct', new URLSearchParams({ column: 'elementary' })),
        api('/api/distinct', new URLSearchParams({ column: 'middle' })),
        api('/api/distinct', new URLSearchParams({ column: 'highschools' })),
      ]);
      const pt = $('#sel-property-type');
      pt.innerHTML = '<option value="any">All Types</option>' + types.values.map((v) => `<option value="${v}">${v}</option>`).join('');
      pt.addEventListener('change', () => {
        state.draft.propertyTypes = pt.value === 'any' ? [] : [pt.value];
        markDirty();
      });
      fill($('#sel-cities'), cities.values, 'count-cities');
      fill($('#sel-districts'), districts.values, 'count-districts');
      fill($('#sel-elementary'), elem.values, 'count-elementary');
      fill($('#sel-middle'), mid.values, 'count-middle');
      fill($('#sel-high'), high.values, 'count-high');
      const ptCount = document.getElementById('count-types');
      if (ptCount) ptCount.textContent = `(${types.values.length})`;
      [['#sel-cities', 'cities'], ['#sel-districts', 'schoolDistricts'], ['#sel-elementary', 'elementary'], ['#sel-middle', 'middle'], ['#sel-high', 'highschools']].forEach(([sel, key]) => {
        $(sel).addEventListener('change', (e) => {
          state.draft[key] = Array.from(e.target.selectedOptions).map((o) => o.value);
          markDirty();
        });
      });
    } catch (err) { console.warn('distinct values:', err); }
  }

  function initRatings() {
    $$('[data-rating]').forEach((wrap) => {
      wrap.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        state.draft[wrap.dataset.rating] = $$('.chip.active', wrap).map((c) => c.dataset.grade);
        markDirty();
      }));
    });
  }

  function initLayers() {
    $('#layer-sales').addEventListener('click', () => $('#layer-sales').classList.toggle('on'));
    $('#layer-rentals').addEventListener('click', () => $('#layer-rentals').classList.toggle('on'));
    const flood = $('#layer-flood');
    flood.addEventListener('click', () => {
      flood.classList.toggle('on');
      $('#flood-hint').hidden = !flood.classList.contains('on');
    });
  }

  // ── plan gating ───────────────────────────────────────────────────────────
  const PREMIUM_BOUNDARIES = new Set(['highschools', 'elementary', 'middle', 'neighborhoods']);

  function applyAccount(account) {
    state.account = account || { signedIn: false, plan: 'free' };
    const plan = state.account.plan || 'free';
    // THE OWNER'S SWITCH WINS: with user management OFF (gateEnabled false)
    // the map is open to everyone, signed in or not.
    const gateOn = state.account.gateEnabled !== false;
    const locked = gateOn && (!state.account.signedIn || plan === 'free');
    document.body.classList.toggle('plan-locked', locked);

    const signin = $('#signin-btn');
    if (signin) signin.hidden = !!state.account.signedIn;
    const banner = $('#plan-banner');
    if (banner) banner.hidden = !locked;
    if (locked) {
      $('#apply-filters').hidden = true;
      $('#tool-report').hidden = true;
    } else {
      syncSelection();
    }

    // Basic keeps the map + filters; the school / neighborhood boundaries and
    // the extra layers are Premium and above.
    const basic = plan === 'basic';
    $$('#boundary-seg .seg-btn').forEach((b) => {
      const premium = PREMIUM_BOUNDARIES.has(b.dataset.boundary);
      b.classList.toggle('premium-locked', basic && premium);
      b.title = basic && premium ? 'Premium plan required' : '';
    });
    $$('#layer-sales, #layer-rentals, #layer-flood').forEach((b) => {
      b.classList.toggle('premium-locked', basic);
      b.title = basic ? 'Premium plan required' : '';
    });

    const acctBtn = $('#btn-account');
    if (acctBtn) {
      acctBtn.onclick = () => {
        location.href = state.account.isAdmin ? '/admin' : (state.account.signedIn ? '/admin' : '/login?next=/map');
      };
    }
  }

  window.addEventListener('resdogs:account', (e) => applyAccount(e.detail));
  if (window.RESDOGS_ACCOUNT) applyAccount(window.RESDOGS_ACCOUNT);

  // ── ads ───────────────────────────────────────────────────────────────────
  function initAds() {
    api('/api/ads').then(({ ads = [] }) => {
      const by = { top: [], bottom: [], corner: [], right: [] };
      ads.forEach((a) => { (by[a.placement] || by.corner).push(a); });
      const slots = [
        ['ad-top', by.top],
        ['ad-bottom', by.bottom],
        ['ad-left', by.corner],
        ['ad-right', by.right],
      ];
      slots.forEach(([id, list]) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (!list.length) { el.hidden = true; return; }
        const ad = list[Math.floor(Math.random() * list.length)];
        const media = ad.mediaType === 'video'
          ? `<video src="${ad.mediaUrl}" autoplay loop muted playsinline></video>`
          : `<img src="${ad.mediaUrl}" alt="${(ad.title || '').replace(/"/g, '&quot;')}"/>`;
        el.innerHTML = `<span class="sponsored">Sponsored</span><a href="${ad.targetUrl || '#'}" target="_blank" rel="noopener">${media}</a>`;
        el.hidden = false;
      });

      // The map fills the screen when there are no ads; each active banner
      // takes height back and each skyscraper takes width.
      document.body.classList.toggle('ads-top', by.top.length > 0);
      document.body.classList.toggle('ads-bottom', by.bottom.length > 0);
      document.body.classList.toggle('ads-side', by.corner.length > 0 || by.right.length > 0);
      if (state.map) {
        setTimeout(() => {
          state.map.resize();
          fitToAreas();
        }, 60);
      }
    }).catch(() => {});
  }

  // ── Hommie AI chat ─────────────────────────────────────────────────────────
  const chatState = { messages: [], busy: false, started: false };

  function chatBubble(role, text) {
    const el = document.createElement('div');
    el.className = `chat-msg ${role}`;
    el.textContent = text;
    $('#chat-messages').appendChild(el);
    $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
    return el;
  }

  function chatOptions(options, multi) {
    const host = $('#chat-options');
    if (!options || !options.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = options.map((o) => `<button data-opt="${String(o).replace(/"/g, '&quot;')}">${o}</button>`).join('');
    host.querySelectorAll('[data-opt]').forEach((b) => b.addEventListener('click', () => {
      const value = b.dataset.opt;
      host.hidden = true;
      host.innerHTML = '';
      chatSend(value);
    }));
  }

  function chatContext() {
    const metricLabel = (B.metrics.find((m) => m.key === state.metric) || {}).label;
    const periodLabel = (B.periods.find((p) => p.key === state.period) || {}).label;
    const count = Number(($('#sum-props').textContent || '0').replace(/,/g, '')) || 0;
    return {
      boundary: state.boundary,
      metric: state.metric,
      metricLabel,
      period: state.period,
      periodLabel,
      selectedNames: selectedNames(),
      filters: state.applied,
      stats: { count },
    };
  }

  async function applyChatActions(actions) {
    for (const a of actions || []) {
      if (a.type === 'set_boundary' && B.boundaries.some((b) => b.key === a.boundary)) {
        state.boundary = a.boundary;
        state.selected.clear();
        $$('#boundary-seg .seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.boundary === a.boundary));
        await refreshAll();
      } else if (a.type === 'set_metric') {
        state.metric = a.metric;
        const m = B.metrics.find((x) => x.key === a.metric);
        if (m) $('#metric-label').textContent = m.label;
        $$('#metric-panel .select-opt').forEach((x) => x.classList.toggle('active', x.dataset.metric === a.metric));
        await refreshAll();
      } else if (a.type === 'set_period') {
        state.period = a.period;
        state.draft.period = a.period;
        state.applied.period = a.period;
        const p = B.periods.find((x) => x.key === a.period);
        if (p) $('#period-label').textContent = p.label;
        await refreshAll();
      } else if (a.type === 'set_filters') {
        Object.entries(a.filters || {}).forEach(([k, v]) => {
          state.draft[k] = v;
          state.applied[k] = v;
          const input = document.querySelector(`input[data-key="${k}"]`);
          if (input) { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); }
          const sel = document.querySelector(`select[data-filter="${k}"]`);
          if (sel) sel.value = String(v);
        });
        await refreshAll();
      } else if (a.type === 'select_areas') {
        const wanted = new Set((a.names || []).map((n) => String(n).toUpperCase()));
        const idx = [];
        state.features.forEach((f, i) => {
          if (wanted.has(String((f.properties && f.properties.name) || '').toUpperCase())) idx.push(i);
        });
        if (idx.length) {
          window.__rd.select(idx);
          const c = state.centroids[idx[0]];
          if (c) state.map.flyTo({ center: c, zoom: 12 });
        }
        if (a.report) {
          state.reportOpen = true;
          $('#report').hidden = false;
          $('#tool-report').hidden = true;
          await renderReport();
          $('#report').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } else if (a.type === 'ask') {
        chatOptions(a.options || [], a.multi);
      }
    }
  }

  async function chatSend(text) {
    const value = String(text || '').trim();
    if (!value || chatState.busy) return;
    chatState.messages.push({ role: 'user', content: value });
    chatBubble('user', value);
    chatOptions([], false);
    chatState.busy = true;
    $('#chat-send').disabled = true;
    $('#chat-input').value = '';
    const typing = chatBubble('bot typing', 'Hommie is thinking…');
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatState.messages, context: chatContext() }),
      });
      const data = await res.json();
      typing.remove();
      const reply = data.reply || '…';
      chatState.messages.push({ role: 'assistant', content: reply });
      chatBubble('bot', reply);
      await applyChatActions(data.actions || []);
    } catch (err) {
      typing.remove();
      chatBubble('bot', 'No pude conectar con el asistente. Intenta de nuevo.');
      console.warn('[chat]', err);
    } finally {
      chatState.busy = false;
      $('#chat-send').disabled = false;
      $('#chat-input').focus();
    }
  }

  function initChat() {
    const open = (v) => {
      $('#chat-panel').hidden = !v;
      $('#chat-fab').hidden = v;
      if (v && !chatState.started) {
        chatState.started = true;
        const hello = 'Hi! I’m Hommie, your Houston real-estate assistant. Ask me about any area, or try a suggestion:';
        chatState.messages.push({ role: 'assistant', content: hello });
        chatBubble('bot', hello);
        chatOptions(['Report for Katy', '4+ beds under $500k', 'Show rental prices', 'Compare Sugar Land and Cypress'], false);
      }
      if (v) setTimeout(() => $('#chat-input').focus(), 50);
    };
    $('#chat-fab').addEventListener('click', () => open(true));
    $('#chat-close').addEventListener('click', () => open(false));
    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      chatSend($('#chat-input').value);
    });
  }

  // ── report boxes ON the map ───────────────────────────────────────────────
  // Owner 2026-10-25: "permíteme agregar cajas al mapa". Every report card can
  // be pinned as a draggable window floating over the map (max 3 at once).
  // The boxes refresh with the fresh numbers every time a report is generated.
  const WINDOW_WIDTH = {
    'Quick Stats': 320,
    'Market Health': 340,
    'Sales · Tax · Rent': 400,
    'Time Series': 400,
    'Top Areas': 360,
    'Year Built': 340,
    '5-Year Forecast': 400,
  };
  const MAP_WINDOW_LIMIT = 3;
  const mapWindows = new Map(); // title -> element

  function cardTitle(card) {
    const t = card.querySelector('.card-title');
    return t ? t.textContent.trim() : 'Report';
  }

  function syncPinButtons() {
    $$('#report .card').forEach((card) => {
      const head = card.querySelector('.card-head');
      if (!head || head.querySelector('[data-pin-card]')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pin-btn';
      btn.dataset.pinCard = '1';
      btn.title = 'Pin this card on the map';
      btn.setAttribute('aria-label', 'Pin this card on the map');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMapWindow(card);
      });
      head.appendChild(btn);
      if (!head.dataset.collapseWired) {
        head.dataset.collapseWired = '1';
        head.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          card.classList.toggle('collapsed');
        });
      }
    });
  }

  // ── guided tour (mirrors new kwizi's TourModal) ───────────────────────────
  const TOUR_STEPS = [
    { title: 'Welcome to Kwizi Market Explorer', icon: '🧭', placement: 'center', text: 'Explore the Houston real-estate market with interactive maps, local insights and detailed area reports.' },
    { sel: '.header', title: 'Top bar', icon: '🗺️', placement: 'bottom', text: 'Start this guided tour, save your session or manage your account from here.' },
    { sel: '.summary', title: 'Live summary', icon: '📋', placement: 'bottom', text: 'See the active boundary, metric, time period, school filters and counts at a glance.' },
    { sel: '[data-section="boundary"]', title: 'Pick a boundary', icon: '📐', placement: 'right', text: 'Switch between Subdivisions, ZIP codes, school districts and more. The map repaints immediately.' },
    { sel: '[data-section="metric"]', title: 'Choose a metric', icon: '📊', placement: 'right', text: 'Colour the map by sales price, rental price, price per sq.ft., days on market, tax rate and more.' },
    { sel: '[data-section="period"]', title: 'Close period', icon: '📅', placement: 'right', text: 'Rolling windows (Last 12 months, 3 years, 5 years) are anchored to the last close date in the data; the calendar options select one exact year.' },
    { sel: '[data-section="search"]', title: 'Search areas', icon: '🔍', placement: 'right', text: 'Type an area name, address or ZIP to find and select matching polygons.' },
    { sel: '[data-section="advanced"]', title: 'Advanced filters', icon: '⚙️', placement: 'right', text: 'Square footage, lot size, year built, DOM, list-to-sale, property type, cities and schools.' },
    { sel: '.map-tools', title: 'Map tools', icon: '🖱️', placement: 'left', text: 'Select individual areas, draw a box or a lasso. Every area inside is selected automatically.' },
    { sel: '#map', title: 'Select on the map', icon: '🎯', placement: 'center', text: 'Click any polygon to select it. With Multi-select on you can add or remove areas one by one.' },
    { sel: '#tool-report', title: 'Generate the report', icon: '📈', placement: 'left', text: 'After selecting areas, press Generate Report. The report opens below the map with Quick Stats, Market Health, Sales · Tax · Rent, Time Series, Forecast, Top Areas and Year Built.' },
    { title: 'You are ready', icon: '✅', placement: 'center', text: 'Every card is interactive: hover the charts, click a stat to recolour the map, collapse a card from its header, or pin it as a draggable box on the map. Press Tour any time to see this again.' },
  ];
  let tourIdx = 0;

  function tourTarget(step) {
    if (!step || !step.sel) return null;
    const list = String(step.sel).split(',').map((x) => x.trim());
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  function placeTourCardFor(step, el) {
    const card = document.getElementById('tour-card');
    if (!card) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let x = (vw - cw) / 2, y = (vh - ch) / 2;
    if (el) {
      const r = el.getBoundingClientRect();
      const gap = 14;
      const right = r.right + gap, left = r.left - cw - gap;
      const below = r.bottom + gap, above = r.top - ch - gap;
      const fitsRight = right + cw <= vw - 12, fitsLeft = left >= 12;
      const fitsBelow = below + ch <= vh - 12, fitsAbove = above >= 12;
      if (step.placement === 'right' && fitsRight) { x = right; y = r.top; }
      else if (step.placement === 'left' && fitsLeft) { x = left; y = r.top; }
      else if (step.placement === 'bottom' && fitsBelow) { x = r.left; y = below; }
      else if (step.placement === 'top' && fitsAbove) { x = r.left; y = above; }
      else if (fitsRight) { x = right; y = r.top; }
      else if (fitsLeft) { x = left; y = r.top; }
      else if (fitsBelow) { x = r.left; y = below; }
      else { x = r.left; y = Math.max(12, above); }
    }
    x = Math.max(12, Math.min(x, vw - cw - 12));
    y = Math.max(12, Math.min(y, vh - ch - 12));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }

  function showTourStep() {
    document.querySelectorAll('.tour-focus').forEach((el) => el.classList.remove('tour-focus'));
    let guard = 0;
    while (tourIdx < TOUR_STEPS.length && TOUR_STEPS[tourIdx].sel && !tourTarget(TOUR_STEPS[tourIdx]) && guard++ < TOUR_STEPS.length) tourIdx++;
    const modal = document.getElementById('tour-modal');
    if (!modal) return;
    if (tourIdx >= TOUR_STEPS.length) { closeTour(); return; }
    const step = TOUR_STEPS[tourIdx];
    const el = tourTarget(step);
    const dim = document.getElementById('tour-dim');
    if (dim) dim.hidden = !!el;
    if (el) {
      el.classList.add('tour-focus');
      el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    }
    document.getElementById('tour-title').textContent = step.title;
    document.getElementById('tour-text').textContent = step.text;
    document.getElementById('tour-icon').textContent = step.icon || '✦';
    document.getElementById('tour-step').textContent = 'STEP ' + (tourIdx + 1) + ' OF ' + TOUR_STEPS.length;
    const dots = document.getElementById('tour-dots');
    if (dots) dots.innerHTML = TOUR_STEPS.map((_, i) => '<span class="tour-dot' + (i === tourIdx ? ' on' : '') + '"></span>').join('');
    const next = document.getElementById('tour-next');
    if (next) next.textContent = tourIdx === TOUR_STEPS.length - 1 ? 'Finish' : 'Next';
    const prev = document.getElementById('tour-prev');
    if (prev) prev.hidden = tourIdx === 0;
    modal.classList.remove('hidden');
    requestAnimationFrame(() => placeTourCardFor(step, el));
  }

  function closeTour() {
    document.querySelectorAll('.tour-focus').forEach((el) => el.classList.remove('tour-focus'));
    const modal = document.getElementById('tour-modal');
    if (modal) modal.classList.add('hidden');
  }

  function initTour() {
    const btn = document.getElementById('btn-tour');
    if (!btn) return;
    btn.addEventListener('click', () => { tourIdx = 0; showTourStep(); });
    document.getElementById('tour-next')?.addEventListener('click', () => {
      if (tourIdx >= TOUR_STEPS.length - 1) { closeTour(); return; }
      tourIdx++;
      showTourStep();
    });
    document.getElementById('tour-prev')?.addEventListener('click', () => { tourIdx = Math.max(0, tourIdx - 1); showTourStep(); });
    document.getElementById('tour-skip')?.addEventListener('click', closeTour);
    document.getElementById('tour-close')?.addEventListener('click', closeTour);
    document.getElementById('tour-modal')?.addEventListener('click', (e) => {
      if (e.target === document.getElementById('tour-modal') || e.target === document.getElementById('tour-dim')) closeTour();
    });
    window.addEventListener('resize', () => {
      const modal = document.getElementById('tour-modal');
      if (modal && !modal.classList.contains('hidden')) {
        const step = TOUR_STEPS[tourIdx] || {};
        placeTourCardFor(step, tourTarget(step));
      }
    });
  }

  // ── boot ───────────────────────────────────────────────────────────────────
  function boot() {
    initSections();
    initSelects();
    initBoundary();
    initRanges();
    initScale();
    initMapTools();
    initSidebar();
    initSearch();
    initReset();
    initRatings();
    initLayers();
    initMap();
    initDrawCanvas();
    initChat();
    initAds();
    syncPinButtons();
    initTour();
    // Proximity manifest (kept for compatibility; rows = 0 after the exact-only
    // placement change, so the tooltip no longer shows an approximation note).
    fetch('/api/zip-fallback')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.byPolygon) state.zipFallback = d.byPolygon; })
      .catch(() => {});
    if (window.RESDOGS_ACCOUNT) applyAccount(window.RESDOGS_ACCOUNT);
    state.map.on('load', () => {
      loadBoundary(state.boundary).then(() => loadValues()).catch((e) => {
        console.error(e); toast('Could not load the map data.');
      });
    });
    initSelectsData();
    updateSummary();
  }

  // Small debug/QA surface (used by the smoke test; harmless in production).
  window.__rd = {
    state,
    select(indexes) {
      state.selected = new Set(indexes);
      syncSelection();
    },
    openReport() {
      state.reportOpen = true;
      document.getElementById('report').hidden = false;
      document.getElementById('tool-report').hidden = true;
      return renderReport();
    },
    refresh: refreshAll,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
