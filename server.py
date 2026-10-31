"""
server.py — RESDOGS' HTTP layer.

FastAPI + Jinja2. Vercel-compatible (a plain ASGI app, no websockets, no
long-lived server), and the front end carries the `new kwizi` design verbatim.

Routes:
  GET  /                    the Market Explorer (the map page)
  GET  /api/map             the map payload: polygons + values + selection
  GET  /api/report          the report payload for a selection
  GET  /api/search          the area search
  GET  /api/distinct        the distinct values for the filter dropdowns
  GET  /api/status          the dataset status (summary bar)
"""

import json
import os
import time
import urllib.parse
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import accounts
import admin
import ads
import engine
import firebase_data as fd
from metrics import (
    BOUNDARIES,
    BOUNDARY_BY_KEY,
    DEFAULT_BOUNDARY,
    DEFAULT_FILTERS,
    DEFAULT_METRIC,
    DEFAULT_PERIOD,
    FIXED_PALETTE,
    METRICS,
    METRIC_BY_KEY,
    PERIODS,
    RANGE_CONTROLS,
    RATING_OPTIONS,
    active_filter_count,
    format_metric_value,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="RESDOGS", docs_url=None, redoc_url=None)
# The boundary GeoJSON and the map payload compress ~4-5x.
app.add_middleware(GZipMiddleware, minimum_size=1000)
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# Bumped once per process: the browser always picks up a new CSS/JS build.
ASSET_VERSION = str(int(time.time()))

STATIC_DIR = os.path.join(BASE_DIR, "static")
if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ── helpers ──────────────────────────────────────────────────────────────────

def _filters_from_query(q) -> dict:
    """Rebuild the filter dict from the query string."""
    f = dict(DEFAULT_FILTERS)
    for key in DEFAULT_FILTERS:
        if key in ("propertyTypes", "pool", "schoolDistricts", "cities",
                   "elementary", "middle", "highschools",
                   "elementaryRating", "middleRating", "highRating"):
            continue
        if key == "period":
            continue
        val = q.get(key)
        if val is not None and val != "":
            try:
                f[key] = float(val) if "." in str(val) else int(val)
            except ValueError:
                pass
    f["period"] = q.get("period") or DEFAULT_PERIOD
    for key in ("propertyTypes", "schoolDistricts", "cities", "elementary",
                "middle", "highschools", "elementaryRating", "middleRating",
                "highRating"):
        raw = q.get(key)
        if raw:
            f[key] = [v for v in raw.split("|") if v]
    pool = q.get("pool")
    if pool:
        f["pool"] = pool
    return f


def _selected_from_query(q) -> list[str]:
    raw = q.get("selected") or ""
    return [v for v in raw.split("|") if v]


# ── pages ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse(
        request=request, name="home.html", context={"v": ASSET_VERSION}
    )


@app.get("/map", response_class=HTMLResponse)
def map_page(request: Request):
    from datetime import datetime as _dt
    _y = _dt.now().year
    bootstrap = {
        "boundaries": BOUNDARIES,
        "metrics": METRICS,
        "periods": PERIODS,
        "rangeControls": RANGE_CONTROLS,
        "ratingOptions": RATING_OPTIONS,
        "defaultBoundary": DEFAULT_BOUNDARY,
        "defaultMetric": DEFAULT_METRIC,
        "defaultPeriod": DEFAULT_PERIOD,
        "palette": FIXED_PALETTE,
        "defaultFilters": DEFAULT_FILTERS,
        # Rolling windows are anchored on the dataset's last close date — the
        # same anchor the original analytics app uses. The UI shows the exact
        # range so "Last 12 months" can never be confused with "Calendar 2025".
        "referenceDate": engine.reference_date().strftime("%Y-%m-%d"),
    }
    return templates.TemplateResponse(
        request=request,
        name="map.html",
        context={
            "boundaries": BOUNDARIES,
            "metrics": METRICS,
            "periods": PERIODS,
            "range_controls": RANGE_CONTROLS,
            "rating_options": RATING_OPTIONS,
            "default_boundary": DEFAULT_BOUNDARY,
            "default_metric": DEFAULT_METRIC,
            "default_period": DEFAULT_PERIOD,
            "palette": FIXED_PALETTE,
            "default_filters": DEFAULT_FILTERS,
            "bootstrap": bootstrap,
            "years_from": _y - 5,
            "years_to": _y,
            "v": ASSET_VERSION,
        },
    )


# ── map ──────────────────────────────────────────────────────────────────────

@app.get("/api/map")
def api_map(
    request: Request,
    boundary: str = DEFAULT_BOUNDARY,
    metric: str = DEFAULT_METRIC,
    period: str = DEFAULT_PERIOD,
    scale: str = "off",
    reverse: str = "0",
    selected: str = "",
):
    t0 = time.time()
    q = request.query_params
    filters = _filters_from_query(q)
    boundary = boundary if boundary in BOUNDARY_BY_KEY else DEFAULT_BOUNDARY
    metric = metric if metric in METRIC_BY_KEY else DEFAULT_METRIC

    features = engine.boundary_features(boundary)
    if not features:
        return JSONResponse(
            {"error": "No boundary geometry available for this class.", "features": []},
            status_code=200,
        )

    # The polygons' display names (the owner's "west memorial" fix).
    poly_meta = []
    for feat in features:
        props = feat.get("properties") or {}
        raw = props.get("name")
        if raw in (None, ""):
            for key in ("NAME", "Name", "Zip_Code", "Subdivision"):
                if props.get(key) not in (None, ""):
                    raw = props[key]
                    break
        poly_meta.append({
            "name": fd.clean_boundary_name(raw),
            "label": fd.expand_boundary_name(raw),
        })

    # Per-polygon values.
    if boundary == "areas":
        values = engine.aggregate_by_geometry(metric, boundary, filters, period)
    else:
        values = engine.aggregate_by_name(metric, boundary, filters, period)

    scale_on = scale == "on"
    # Auto-scale on robust percentiles: a single $1 row must not flatten the
    # whole map into one colour. Values outside the range still paint (they
    # clamp to the end colours); only the legend bounds are robust.
    nums = sorted(v["value"] for v in values.values() if v.get("value") is not None)
    if nums:
        def _pct(p: float) -> float:
            idx = int(round(p * (len(nums) - 1)))
            return float(nums[max(0, min(len(nums) - 1, idx))])
        vmin, vmax = _pct(0.02), _pct(0.98)
    else:
        vmin, vmax = 0.0, 1.0
    if vmax <= vmin:
        vmax = vmin + 1.0

    payload = []
    for i, feat in enumerate(features):
        meta = poly_meta[i]
        name = meta["name"]
        stat = values.get(name)
        payload.append({
            "i": i,
            "name": name,
            "label": meta["label"],
            "value": stat["value"] if stat else None,
            "count": stat["count"] if stat else 0,
        })

    return JSONResponse({
        "boundary": boundary,
        "metric": metric,
        "period": period,
        "scale": scale_on,
        "reverse": reverse == "1",
        "palette": FIXED_PALETTE,
        "vmin": vmin,
        "vmax": vmax,
        "values": payload,
        "featureCount": len(features),
        "elapsedMs": int((time.time() - t0) * 1000),
    })


_geo_bytes: dict[str, bytes] = {}


@app.get("/api/geojson")
def api_geojson(request: Request, boundary: str = DEFAULT_BOUNDARY):
    """The polygons — the map draws them client-side.

    The compressed body is built once per boundary per process: compressing
    3.6 MB of coordinates on every request costs ~0.5 s for no benefit.
    """
    import gzip as _gzip

    if boundary not in _geo_bytes:
        raw = engine.geojson_payload(boundary)
        _geo_bytes[boundary] = _gzip.compress(
            json.dumps(raw, separators=(",", ":")).encode("utf-8"), 6
        )
    body = _geo_bytes[boundary]
    if "gzip" in (request.headers.get("accept-encoding") or ""):
        return Response(
            content=body,
            media_type="application/json",
            headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"},
        )
    import gzip as _gz
    return Response(content=_gz.decompress(body), media_type="application/json")


# ── report ───────────────────────────────────────────────────────────────────

@app.get("/api/report")
def api_report(
    request: Request,
    boundary: str = DEFAULT_BOUNDARY,
    metric: str = DEFAULT_METRIC,
    period: str = DEFAULT_PERIOD,
    selected: str = "",
):
    q = request.query_params
    filters = _filters_from_query(q)
    names = _selected_from_query(q)
    boundary = boundary if boundary in BOUNDARY_BY_KEY else DEFAULT_BOUNDARY
    metric = metric if metric in METRIC_BY_KEY else DEFAULT_METRIC

    # The four report queries are independent — run them concurrently so the
    # card set arrives in ~one query's time, not four.
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=6) as pool:
        f_stats = pool.submit(engine.area_stats, filters, period, names or None, boundary)
        f_series = pool.submit(engine.time_series, metric, filters, period, boundary, names or None)
        f_years = pool.submit(engine.year_built_histogram, filters, period, boundary, names or None)
        f_health = pool.submit(engine.market_health, filters, period, boundary, names or None)
        # The forecast always uses the FULL uploaded history (a 5-year trend
        # cannot be fitted on a single month), and the grouped bars show every
        # month of every uploaded year.
        f_series_all = pool.submit(engine.time_series, metric, filters, 'all', boundary, names or None)
        f_monthly = pool.submit(engine.monthly_by_year, metric, filters, boundary, names or None)
        stats = f_stats.result()
        series = f_series.result()
        years = f_years.result()
        health = f_health.result()
        series_all = f_series_all.result()
        monthly = f_monthly.result()

    # Top areas: the polygons with the highest values in this selection.
    values = engine.aggregate_by_name(metric, boundary, filters, period)
    if names:
        wanted = set(names)
        top = sorted(
            [v for k, v in values.items() if k in wanted],
            key=lambda d: -(d["value"] or 0),
        )[:10]
    else:
        top = sorted(values.values(), key=lambda d: -(d["value"] or 0))[:10]

    return JSONResponse({
        "stats": stats,
        "marketHealth": health,
        "timeSeries": series,
        "forecast": engine.build_forecast(series_all),
        "monthly": monthly,
        "yearBuilt": years,
        "topAreas": [
            {"name": t["name"], "label": fd.expand_boundary_name(t["name"]),
             "value": t["value"], "count": t["count"]}
            for t in top
        ],
        "metricLabel": METRIC_BY_KEY[metric]["label"],
        "metric": metric,
        "selectionCount": len(names),
    })


def _search_tokens(text: str) -> list[str]:
    """Uppercase words with a light singular form (SPRINGS -> SPRING)."""
    clean = "".join(ch if ch.isalnum() else " " for ch in (text or "").upper())
    out = []
    for word in clean.split():
        if len(word) > 3 and word.endswith("S"):
            word = word[:-1]
        out.append(word)
    return out


def _search_score(query: str, name: str) -> int:
    """0 = no match; higher is better. Token-based so 'Eagle Spring Pkwy'
    still finds 'EAGLE SPRINGS PKWY TO TIMBER FOREST DRIVE'."""
    q_tokens = _search_tokens(query)
    if not q_tokens:
        return 0
    n_tokens = _search_tokens(name)
    if not n_tokens:
        return 0
    q_compact = " ".join(q_tokens)
    n_compact = " ".join(n_tokens)
    if q_compact in n_compact:
        return 100 + len(q_tokens)
    score = 0
    for qt in q_tokens:
        hit = False
        for nt in n_tokens:
            if nt == qt or nt.startswith(qt) or qt.startswith(nt):
                hit = True
                break
        if not hit:
            return 0
        score += 1
    return score


@app.get("/api/search")
def api_search(q: str = "", boundary: str = DEFAULT_BOUNDARY, limit: int = 20):
    """Search areas by name (the sidebar's Search section)."""
    term = (q or "").strip()
    if not term:
        return JSONResponse({"results": []})
    features = engine.boundary_features(boundary)
    scored = []
    for idx, feat in enumerate(features):
        props = feat.get("properties") or {}
        name = props.get("name")
        if name in (None, ""):
            for key in ("NAME", "Name", "Zip_Code", "Subdivision"):
                if props.get(key) not in (None, ""):
                    name = fd.clean_boundary_name(props[key])
                    break
        name = fd.clean_boundary_name(name)
        if not name:
            continue
        score = _search_score(term, name)
        if score:
            scored.append((score, len(name), idx, name))
    scored.sort(key=lambda s: (-s[0], s[1]))
    results = [
        {"name": name, "label": fd.expand_boundary_name(name), "index": idx}
        for _s, _l, idx, name in scored[:limit]
    ]

    # Address fallback (needs GOOGLE_MAPS_API_KEY): geocode and return the
    # polygon that contains the address — the old app searched addresses.
    if not results and any(ch.isdigit() for ch in term):
        key = fd._env("GOOGLE_MAPS_API_KEY")
        if key:
            import urllib.parse
            import urllib.request

            url = (
                "https://maps.googleapis.com/maps/api/geocode/json?address="
                + urllib.parse.quote(term)
                + "&key="
                + key
            )
            try:
                with urllib.request.urlopen(url, timeout=15) as r:
                    data = json.loads(r.read().decode())
                loc = (data.get("results") or [{}])[0].get("geometry", {}).get("location")
                if loc:
                    from shapely.geometry import Point

                    tree, geoms, names, _fids, _bases = engine._get_index(boundary)
                    pt = Point(float(loc["lng"]), float(loc["lat"]))
                    hits = [k for k in tree.query(pt) if geoms[k].intersects(pt)]
                    idx = min(hits, key=lambda k: geoms[k].area) if hits else None
                    if idx is None and len(geoms):
                        idx = tree.nearest(pt)
                        if geoms[idx].distance(pt) * 111.0 > 2.0:
                            idx = None
                    if idx is not None:
                        name = names[idx]
                        results = [{"name": name, "label": fd.expand_boundary_name(name), "index": idx}]
            except Exception as exc:  # noqa: BLE001
                print("[search] geocode failed:", exc)

    return JSONResponse({"results": results})


@app.get("/api/distinct")
def api_distinct(column: str = "property_type"):
    allowed = {"property_type", "city", "school_district", "elementary",
               "middle", "highschools", "listing_type"}
    if column not in allowed:
        return JSONResponse({"values": []})
    return JSONResponse({"values": engine.distinct_values(column)})


_zip_fallback_cache = {"at": 0.0, "data": None}


@app.get("/api/zip-fallback")
def api_zip_fallback():
    """Rows that were placed by proximity (approximate ZIP fallback).

    The table cannot carry a provenance column (the app's DB role is not the
    table owner), so the manifest lives in Firestore `cms_meta/zip_fallback`.
    The map tooltip marks the affected polygons with it.
    """
    import time as _time

    if _zip_fallback_cache["data"] is not None and _time.time() - _zip_fallback_cache["at"] < 600:
        return JSONResponse(_zip_fallback_cache["data"])
    data = {"rows": 0, "byPolygon": {}, "method": "nearest polygon within 1.5 km"}
    try:
        for doc in fd._fs_list("cms_meta"):
            if str(doc.get("_id")) == "zip_fallback":
                data = {
                    "rows": int(doc.get("rows") or 0),
                    "byPolygon": doc.get("byPolygon") or {},
                    "method": doc.get("method") or data["method"],
                }
                break
    except Exception:  # noqa: BLE001
        pass
    _zip_fallback_cache["at"] = _time.time()
    _zip_fallback_cache["data"] = data
    return JSONResponse(data)


@app.get("/api/status")
def api_status():
    st = engine.dataset_status()
    return JSONResponse(st)


@app.get("/api/filter-count")
def api_filter_count(request: Request):
    filters = _filters_from_query(request.query_params)
    return JSONResponse({"count": active_filter_count(filters)})


# ── admin / CMS ──────────────────────────────────────────────────────────────

@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    from fastapi.responses import RedirectResponse

    next_url = request.query_params.get("next") or "/admin"
    return templates.TemplateResponse(
        request=request, name="login.html", context={"v": ASSET_VERSION, "next": next_url}
    )


@app.get("/admin", response_class=HTMLResponse)
def admin_page(request: Request):
    return templates.TemplateResponse(
        request=request, name="admin.html", context={"v": ASSET_VERSION}
    )


@app.get("/api/admin/config")
def admin_config():
    """Public Firebase config for the client SDK (no secrets)."""
    return JSONResponse(admin.public_firebase_config())


@app.get("/api/admin/status")
def admin_status(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse(admin.dataset_status())


@app.post("/api/admin/upload-boundary")
async def admin_upload_boundary(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    form = await request.form()
    cls = str(form.get("class") or "")
    upload = form.get("file")
    if upload is None:
        return JSONResponse({"error": "No file received"}, status_code=400)
    content = await upload.read()
    if len(content) > 200 * 1024 * 1024:
        return JSONResponse({"error": "File too large (200 MB max)"}, status_code=400)
    result = admin.upload_boundary(cls, admin.BOUNDARY_FILE_NAME.get(cls, upload.filename), content)
    # AUTOMATIC: a new subdivision boundary immediately re-runs the exact
    # name+ZIP match, so the rows it covers are placed without another click.
    if cls == "subdivisions":
        try:
            result["exactMatch"] = admin.apply_exact_names()
        except Exception as exc:  # noqa: BLE001 - the upload itself succeeded
            result["exactMatchError"] = str(exc)
    return JSONResponse(result)


@app.get("/api/admin/missing-subdivisions")
def admin_missing_subdivisions(request: Request, limit: int = 300, all: int = 0, section: str = ""):
    """Unplaced rows by subdivision + ZIP — the exact polygons still missing."""
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse(admin.missing_subdivisions(None if all else max(1, min(limit, 5000)), section))


@app.get("/api/admin/polygons-without-data")
def admin_polygons_without_data(request: Request, limit: int = 500, all: int = 0, threshold: int = 0, section: str = ""):
    """Polygons that exist in the boundary but have no rows — upload the CSVs."""
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse(admin.polygons_without_data(
        None if all else max(1, min(limit, 5000)), max(0, min(threshold, 100)), section
    ))


@app.get("/api/admin/polygons-without-data-by-year")
def admin_polygons_without_data_by_year(request: Request, section: str = "", limit: int = 300):
    """Polygons with no rows, split by dataset year (the map is per year)."""
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse(admin.polygons_without_data_by_year(max(1, min(limit, 2000)), section))


@app.get("/api/admin/polygons-without-data-month-counts")
def admin_gap_month_counts(request: Request, section: str = "", year: int = 0):
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse(admin.polygons_without_data_month_counts(section, year))


@app.get("/api/admin/polygons-without-data-month")
def admin_gap_month(request: Request, section: str = "", year: int = 0, month: int = 0, limit: int = 300):
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse(admin.polygons_without_data_month(section, year, month, max(1, min(limit, 3000))))


@app.post("/api/admin/apply-exact-names")
def admin_apply_exact_names(request: Request):
    """Automatic pass: place unplaced rows whose CSV subdivision matches a
    polygon under the normalized name+ZIP bridge (no proximity)."""
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse(admin.apply_exact_names())


@app.post("/api/admin/assign")
async def admin_assign(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    cls = str(body.get("class") or "subdivisions")
    after = body.get("after")
    return JSONResponse(admin.assign_chunk(cls, after))


@app.get("/api/admin/db-stats")
def admin_db_stats(request: Request, section: str = "sales"):
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse(admin.db_stats(section))


@app.get("/api/admin/coverage")
def admin_coverage(request: Request, cls: str = "subdivisions"):
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse(admin.coverage_for(cls))


@app.post("/api/admin/upload-data")
async def admin_upload_data(request: Request):
    """Parse a property CSV, import its rows and publish them right away."""
    import cms_import

    admin.verify_admin(request.headers.get("authorization"))
    form = await request.form()
    section = str(form.get("section") or "")
    if section not in cms_import.SECTION_CATEGORY:
        return JSONResponse({"error": "Unknown section"}, status_code=400)
    upload = form.get("file")
    if upload is None:
        return JSONResponse({"error": "No file received"}, status_code=400)
    content = await upload.read()
    if len(content) > 200 * 1024 * 1024:
        return JSONResponse({"error": "File too large (200 MB max)"}, status_code=400)
    result = cms_import.stage_import(section, upload.filename, content)
    # Publish immediately: the owner asked to skip the dashboard "Add All"
    # trip. If the commit fails the rows stay staged and the dashboard
    # session list still lets them publish or discard.
    if result.get("sessionId"):
        try:
            result["committed"] = cms_import.commit_session(result["sessionId"])
            result["published"] = True
            # AUTOMATIC POLYGON ASSIGNMENT — a published row without a polygon
            # is invisible on the map for every period. This is exactly what hid
            # the July–September rentals from 30d/90d (2026-10-30 incident).
            try:
                assigned = 0
                for _ in range(6):
                    chunk = admin.assign_chunk("subdivisions", None, 15000)
                    assigned += int(chunk.get("assigned") or 0)
                    if chunk.get("done") or chunk.get("error"):
                        break
                result["assignedRows"] = assigned
            except Exception as exc:  # noqa: BLE001 - the upload itself succeeded
                result["assignError"] = str(exc)[:200]
            engine._agg_cache.clear()
            engine._ref_date["value"] = None
        except Exception as exc:  # noqa: BLE001
            result["published"] = False
            result["commitError"] = str(exc)[:200]
    return JSONResponse(result)


@app.post("/api/admin/commit-session")
async def admin_commit_session(request: Request):
    import cms_import

    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    session_id = str(body.get("sessionId") or "")
    if not session_id:
        return JSONResponse({"error": "Missing sessionId"}, status_code=400)
    n = cms_import.commit_session(session_id)
    engine._agg_cache.clear()
    engine._ref_date["value"] = None
    return JSONResponse({"ok": True, "committed": n})


@app.post("/api/admin/discard-session")
async def admin_discard_session(request: Request):
    import cms_import

    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    session_id = str(body.get("sessionId") or "")
    if not session_id:
        return JSONResponse({"error": "Missing sessionId"}, status_code=400)
    n = cms_import.discard_session(session_id)
    return JSONResponse({"ok": True, "discarded": n})


@app.post("/api/admin/commit-all")
def admin_commit_all(request: Request):
    import cms_import

    admin.verify_admin(request.headers.get("authorization"))
    n = cms_import.commit_all()
    engine._agg_cache.clear()
    engine._ref_date["value"] = None
    return JSONResponse({"ok": True, "committed": n})


@app.post("/api/admin/cancel-all")
def admin_cancel_all(request: Request):
    import cms_import

    admin.verify_admin(request.headers.get("authorization"))
    n = cms_import.discard_all()
    return JSONResponse({"ok": True, "discarded": n})


@app.get("/api/admin/pending")
def admin_pending(request: Request):
    import cms_import

    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse({"sessions": cms_import.pending_sessions()})


@app.get("/api/admin/files")
def admin_files(request: Request, category: str | None = None):
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse({"files": admin.list_files(category)})


@app.get("/api/admin/file-preview")
def admin_file_preview(request: Request, id: str = ""):
    """The CMS Eye: the first rows of an uploaded CSV / GeoJSON stats."""
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse(admin.file_preview(id))


@app.get("/api/admin/file-download")
def admin_file_download(request: Request, id: str = ""):
    """Download the original file (gzip is undone server-side)."""
    admin.verify_admin(request.headers.get("authorization"))
    data, name = admin.file_bytes(id)
    base = (name or "download").split("/")[-1] or "download"
    quoted = urllib.parse.quote(base)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}"},
    )


@app.post("/api/admin/delete-file")
async def admin_delete_file(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    return JSONResponse(admin.delete_file(str(body.get("id") or ""), body.get("storagePath")))


@app.post("/api/admin/clear-section")
async def admin_clear_section(request: Request):
    """The CMS "Delete All Data": section files + the rows they created."""
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    return JSONResponse(admin.clear_section(str(body.get("section") or "")))


@app.get("/api/admin/collection")
def admin_collection(request: Request, name: str = "users"):
    admin.verify_admin(request.headers.get("authorization"))
    if name not in ("users", "ads", "companies", "accessRequests"):
        return JSONResponse({"docs": []})
    return JSONResponse({"docs": admin.list_collection(name)})


# ── accounts / plans ────────────────────────────────────────────────────────

@app.get("/api/me")
def api_me(request: Request):
    """The effective account for this browser (free when not signed in)."""
    info = accounts.verify_id_token(request.headers.get("authorization"))
    return JSONResponse(accounts.resolve_account((info or {}).get("email")))


@app.get("/api/admin/gate")
def admin_gate_get(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse(accounts.get_gate())


@app.post("/api/admin/gate")
async def admin_gate_set(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    return JSONResponse(accounts.set_gate(bool(body.get("userManagementEnabled"))))


@app.get("/api/admin/users")
def admin_users(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse({"users": accounts.list_users()})


@app.post("/api/admin/users")
async def admin_user_create(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    return JSONResponse(accounts.create_user(
        email=body.get("email"), password=body.get("password"),
        name=body.get("name") or "", role=body.get("role") or "user",
        plan=body.get("plan") or "Basic", status=body.get("status") or "active",
    ))


@app.post("/api/admin/users/update")
async def admin_user_update(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    return JSONResponse(accounts.update_user(str(body.get("id") or ""), body))


@app.post("/api/admin/users/delete")
async def admin_user_delete(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    accounts.delete_user(str(body.get("id") or ""))
    return JSONResponse({"ok": True})


@app.get("/api/admin/my-company")
def admin_my_company(request: Request):
    """An Enterprise account's own company (to manage its seats)."""
    info = accounts.verify_id_token(request.headers.get("authorization"))
    acct = accounts.resolve_account((info or {}).get("email"))
    if acct.get("plan") != "enterprise" or not acct.get("company"):
        raise HTTPException(status_code=403, detail="Enterprise account required")
    company = next(
        (c for c in accounts.list_companies() if c.get("_id") == acct["company"]["id"]),
        None,
    )
    return JSONResponse({"company": company, "account": acct})


@app.get("/api/admin/companies")
def admin_companies(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse({"companies": accounts.list_companies()})


@app.post("/api/admin/companies")
async def admin_company_create(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    return JSONResponse(accounts.create_company(
        body.get("name") or "", body.get("ownerEmail") or "",
        plan=body.get("plan") or "Enterprise", status=body.get("status") or "active",
        employees=body.get("employees") or [],
    ))


@app.post("/api/admin/companies/employee-add")
async def admin_company_add_employee(request: Request):
    _admin_or_enterprise(request)
    body = await request.json()
    return JSONResponse(accounts.add_employee(
        str(body.get("companyId") or ""), str(body.get("email") or "")
    ))


@app.post("/api/admin/companies/employee-remove")
async def admin_company_remove_employee(request: Request):
    _admin_or_enterprise(request)
    body = await request.json()
    return JSONResponse(accounts.remove_employee(
        str(body.get("companyId") or ""), str(body.get("email") or "")
    ))


@app.post("/api/admin/companies/delete")
async def admin_company_delete(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    accounts.delete_company(str(body.get("id") or ""))
    return JSONResponse({"ok": True})


@app.post("/api/admin/companies/subscription")
async def admin_company_subscription(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    return JSONResponse(accounts.update_company_subscription(
        str(body.get("id") or ""), body.get("plan") or "Enterprise",
        body.get("status") or "active",
    ))


def _admin_or_enterprise(request: Request) -> dict:
    """Admins manage everyone; an Enterprise account manages its own seats."""
    auth = request.headers.get("authorization")
    try:
        admin.verify_admin(auth)
        return {"role": "admin"}
    except Exception:  # noqa: BLE001
        info = accounts.verify_id_token(auth)
        acct = accounts.resolve_account((info or {}).get("email"))
        if acct.get("plan") != "enterprise" or not acct.get("company"):
            raise HTTPException(status_code=403, detail="Enterprise account required") from None
        return acct


# ── ads ─────────────────────────────────────────────────────────────────────

@app.get("/api/ads")
def api_ads():
    """Active campaigns — the map page renders them by placement."""
    return JSONResponse({"ads": ads.list_ads(active_only=True)})


@app.get("/api/admin/ads")
def admin_ads_list(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    return JSONResponse({
        "ads": ads.list_ads(),
        "placements": ads.PLACEMENTS,
        "recommended": {k: list(v) for k, v in ads.RECOMMENDED.items()},
    })


@app.post("/api/admin/ads")
async def admin_ad_create(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    form = await request.form()
    media = form.get("media")
    if media is None:
        return JSONResponse({"error": "Attach an image or video"}, status_code=400)
    content = await media.read()
    if len(content) > 100 * 1024 * 1024:
        return JSONResponse({"error": "Media too large (100 MB max)"}, status_code=400)
    return JSONResponse(ads.create_ad(
        title=str(form.get("title") or ""),
        target_url=str(form.get("targetUrl") or ""),
        placement=str(form.get("placement") or "corner"),
        content=content,
        filename=media.filename or "ad.bin",
        content_type=media.content_type or "",
        beneficiary=str(form.get("beneficiaryName") or ""),
    ))


@app.post("/api/admin/ads/status")
async def admin_ad_status(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    ads.set_status(str(body.get("id") or ""), str(body.get("status") or "active"))
    return JSONResponse({"ok": True})


@app.post("/api/admin/ads/placement")
async def admin_ad_placement(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    ads.set_placement(str(body.get("id") or ""), str(body.get("placement") or "corner"))
    return JSONResponse({"ok": True})


@app.post("/api/admin/ads/delete")
async def admin_ad_delete(request: Request):
    admin.verify_admin(request.headers.get("authorization"))
    body = await request.json()
    ads.delete_ad(str(body.get("id") or ""))
    return JSONResponse({"ok": True})


@app.post("/api/chat")
async def api_chat(request: Request):
    """Hommie AI — Gemini with tools over the live dataset."""
    import chat

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    try:
        out = chat.reply(body.get("messages") or [], body.get("context") or {})
        return JSONResponse(out)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            {"reply": f"The assistant is unavailable right now ({str(exc)[:160]}).",
             "actions": []},
            status_code=200,
        )


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"
