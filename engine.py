"""
engine.py — RESDOGS' data engine.

Two stages, exactly like the app we are porting:

  1. FILTERS + AGGREGATES  → run in Postgres (Cloud SQL) via the connector's
     `_executeReturning`. The database does the WHERE + the GROUP BY; Python
     never pulls 700k rows to the server.

  2. POINT-IN-POLYGON      → run in Python with shapely, because Cloud SQL has
     no PostGIS. The rows that carry coordinates are assigned to the polygon
     that contains them ("smallest containing polygon wins" — the reference
     app's semantics), and the per-polygon medians come out of that.

The result is one dict per polygon:
    {poly_id, name, value, count, ...}
which the map draws and the report reads.
"""

import json
import math
import os
import threading
import time
from collections import defaultdict

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

import firebase_data as fd
from metrics import (
    BOUNDARY_GEOM,
    DEFAULT_FILTERS,
    METRIC_BY_KEY,
    period_window,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Vercel's bundle is read-only; only /tmp is writable there. Locally we keep
# the downloaded GeoPackages next to the app so they survive restarts.
GEOM_CACHE_DIR = (
    os.environ.get("RESDOGS_CACHE_DIR")
    or ("/tmp/resdogs-boundaries" if os.environ.get("VERCEL") else os.path.join(BASE_DIR, "data", "boundaries"))
)
R2_BASE = "https://pub-d823dd0101cc46d5987fa365053fb26e.r2.dev"

# ── SQL helpers ──────────────────────────────────────────────────────────────


def _sql_escape(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            return "NULL"
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def _filter_sql(f: dict) -> tuple[str, list]:
    """Build the WHERE clause for the property filters.

    Ported from `new kwizi/src/lib/engineCore.ts` `filterProperties`:
    every bound is ALWAYS applied (the defaults are the outer limits), and a
    row with a list price must have a sane list-to-sale ratio (50–150 %).
    That last rule is what drops the corrupt `list_price` rows where a
    monthly rent leaked into the sale price column.

    Rows with a NULL in a bounded column are kept: the reference app coerces
    them to 0, which would silently delete every row without a year/bed count.
    Keeping them is the conservative choice and matches the CSVs.
    """
    parts = ["upload_session_id IS NULL"]
    d = DEFAULT_FILTERS

    def _v(key: str) -> float:
        val = f.get(key)
        if val is None:
            return d[key]
        try:
            return float(val)
        except (TypeError, ValueError):
            return float(d[key])

    def _between(col: str, lo: float, hi: float) -> None:
        parts.append(f"({col} IS NULL OR ({col} >= {lo} AND {col} <= {hi}))")

    _between("close_price", _v("saleMin"), _v("saleMax"))
    _between("sqft", _v("sqftMin"), _v("sqftMax"))
    _between("year_built", _v("yearMin"), _v("yearMax"))
    _between("br", _v("bedsMin"), _v("bedsMax"))
    _between("baths", _v("bathsMin"), _v("bathsMax"))
    _between("lot_size", _v("lotSizeMin"), _v("lotSizeMax"))

    # List-to-sale: only filter when the user actually narrows the range.
    # The old app (and the CSVs) count every closed sale by default; forcing
    # 50–150 here silently dropped legitimate outliers (e.g. a 152.6% sale),
    # which is why an area showed 913 instead of 915 properties.
    if _v("l2sMin") > d["l2sMin"] or _v("l2sMax") < d["l2sMax"]:
        parts.append(
            "(list_price IS NULL OR list_price <= 0 OR "
            f"(close_price * 100.0 / list_price) BETWEEN {_v('l2sMin')} AND {_v('l2sMax')})"
        )

    # Days on market: cdom when set, otherwise dom.
    dom_expr = "coalesce(nullif(cdom, 0), dom, 0)"
    parts.append(f"{dom_expr} BETWEEN {int(_v('domMin'))} AND {int(_v('domMax'))}")

    # Price per sqft falls back to close_price / sqft when the column is empty.
    ppsf_expr = "coalesce(nullif(price_per_sqft, 0), CASE WHEN sqft > 0 THEN close_price::numeric / sqft END)"
    parts.append(
        f"({ppsf_expr} IS NULL OR ({ppsf_expr} >= {_v('pricePerSqftMin')} "
        f"AND {ppsf_expr} <= {_v('pricePerSqftMax')}))"
    )

    # The rent range binds REAL rents only (owner rule: a sale row has no rent).
    parts.append(
        "(listing_type IS DISTINCT FROM 'rent' OR "
        f"(close_price >= {_v('rentMin')} AND close_price <= {_v('rentMax')}))"
    )

    ptypes = f.get("propertyTypes") or []
    if ptypes:
        parts.append("property_type IN (" + ", ".join(_sql_escape(p) for p in ptypes) + ")")

    pool = f.get("pool", "any")
    if pool == "yes":
        parts.append("pool IS TRUE")
    elif pool == "no":
        parts.append("pool IS NOT TRUE")

    cities = f.get("cities") or []
    if cities:
        parts.append("city IN (" + ", ".join(_sql_escape(c) for c in cities) + ")")

    districts = f.get("schoolDistricts") or []
    if districts:
        parts.append("school_district IN (" + ", ".join(_sql_escape(c) for c in districts) + ")")

    for col, key in (("elementary", "elementary"), ("middle", "middle"), ("highschools", "highschools")):
        vals = f.get(key) or []
        if vals:
            parts.append(f"{col} IN (" + ", ".join(_sql_escape(v) for v in vals) + ")")

    return " AND ".join(parts), []


_ref_date = {"value": None}


def reference_date():
    """The dataset's last close date — the anchor the original app used for
    its rolling windows, so its "5 years" and ours select the same rows."""
    from datetime import datetime as _dt

    if _ref_date["value"] is None:
        try:
            rows = fd.sql_rows(
                "SELECT max(NULLIF(close_date,'')) AS mx FROM properties "
                "WHERE upload_session_id IS NULL"
            )
            raw = (rows[0] or {}).get("mx") if rows else None
            _ref_date["value"] = _dt.strptime(str(raw)[:10], "%Y-%m-%d")
        except Exception:  # noqa: BLE001
            _ref_date["value"] = _dt.now()
    return _ref_date["value"]


def _period_sql(period: str) -> str:
    """The period clause — rolling windows anchored on the last close date,
    calendar-year buckets on dataset_year."""
    win = period_window(period, reference_date())
    parts = []
    if win["startTs"] is not None:
        parts.append(f"close_date_ts >= {int(win['startTs'])}")
    if win["endTs"] is not None:
        parts.append(f"close_date_ts <= {int(win['endTs'])}")
    if win["datasetYearMin"] is not None:
        parts.append(f"dataset_year >= {int(win['datasetYearMin'])}")
    if win["datasetYearMax"] is not None:
        parts.append(f"dataset_year <= {int(win['datasetYearMax'])}")
    return " AND ".join(parts)


def _kind_clause(metric: dict) -> str:
    """Which rows feed the metric.

    Sale metrics read CLOSED sales only: the table also holds active listings
    (`close_date` empty — the "Current for Sale" uploads, duplicated under
    year 0 and 2025) and tax rows. Including either skews the median and
    inflates the property count.
    """
    kind = metric["kind"]
    if kind == "sale":
        # A closed sale has a close DATE. The active-listing uploads carry a
        # timestamp but an empty close_date, and they appear twice (year 0 and
        # 2025) — counting them would inflate both the median and the count.
        return (
            "coalesce(listing_type, 'sale') NOT IN ('rent', 'tax') "
            "AND close_date IS NOT NULL AND close_date <> ''"
        )
    if kind == "rent":
        # Closed leases only: the "Current for Rent" rows (no lease date) are
        # active listings, not rental comps — the old app kept them in a
        # separate table and never used them for the rental median.
        return "listing_type = 'rent' AND close_date IS NOT NULL AND close_date <> ''"
    if kind == "both":
        return "coalesce(listing_type, 'sale') <> 'tax'"
    return ""


# ── Geometry ─────────────────────────────────────────────────────────────────

_geom_lock = threading.Lock()
_geom_cache: dict[str, dict] = {}
_geojson_cache: dict[str, dict] = {}


def _download(url: str, dest: str) -> str:
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "kwizi-resdogs"})
    with urllib.request.urlopen(req, timeout=300) as r:
        data = r.read()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as fh:
        fh.write(data)
    return dest


def boundary_features(boundary: str) -> list[dict]:
    """The polygons for a boundary class, as GeoJSON features.

    Two sources, in order:
      1. The CURRENT file in the CMS (Firestore + Storage) — what the admin
         uploads, so the map always shows what the owner last published.
      2. The R2 gpkg (the old app's geometry) — the fallback, and the only
         source for the classes the CMS does not carry.
    """
    with _geom_lock:
        if boundary in _geom_cache:
            return _geom_cache[boundary]

    features: list[dict] = []
    try:
        fc = fd.fetch_boundary_geojson(boundary)
        if fc.get("features"):
            features = fc["features"]
    except Exception as exc:  # noqa: BLE001 - fall back to R2
        print(f"[engine] CMS boundary for {boundary} unavailable: {exc}")

    if not features:
        features = _features_from_r2(boundary)

    # A single NULL geometry makes the whole collection invalid for MapLibre
    # (the map then draws nothing at all), and degenerate rings make shapely
    # drop a polygon from the assignment index. Repair both here — every
    # consumer indexes into THIS list, so the map and the values stay aligned.
    valid = []
    skipped = 0
    for feat in features:
        geom = feat.get("geometry") or {}
        if not geom.get("type") or geom.get("coordinates") is None:
            skipped += 1
            continue
        clean = _sanitize_geometry(geom)
        if clean is None:
            skipped += 1
            continue
        feat = {**feat, "geometry": clean}
        valid.append(feat)
    if skipped:
        print(f"[engine] {boundary}: {len(valid)} features kept, {skipped} dropped")

    # Two different polygons often share a name (e.g. two "RIVERSIDE PARK").
    # Grouping by that name merged their properties and gave both areas the
    # same number. Give duplicates a stable suffix (their ZIP when available)
    # so each polygon keeps its own stats.
    from collections import Counter

    base_names = [fd.clean_boundary_name(_feature_name(f)) for f in valid]
    totals = Counter(base_names)
    seen = Counter()
    for feat, base in zip(valid, base_names):
        name = base
        if base and totals[base] > 1:
            seen[base] += 1
            props = feat.setdefault("properties", {})
            zipc = props.get("Zip_Code")
            suffix = f" ({zipc})" if zipc not in (None, "") else f" #{seen[base]}"
            candidate = base + suffix
            if candidate in totals:  # the ZIP alone was not unique
                candidate = base + f" #{seen[base]}"
            name = candidate
            totals[name] += 1
        props = feat.setdefault("properties", {})
        props["base_name"] = base
        props["name"] = name
    features = valid

    with _geom_lock:
        _geom_cache[boundary] = features
    return features


def _features_from_r2(boundary: str) -> list[dict]:
    """Read a boundary class from the old app's R2 GeoPackage."""
    layer = BOUNDARY_GEOM.get(boundary)
    if not layer:
        return []
    local = os.path.join(GEOM_CACHE_DIR, f"{layer}.gpkg")
    if not os.path.exists(local):
        url = f"{R2_BASE}/{layer}.gpkg"
        try:
            _download(url, local)
        except Exception as exc:  # noqa: BLE001
            print(f"[engine] R2 boundary {layer} unavailable: {exc}")
            return []
    try:
        import pyogrio
        import shapely
        # geopandas is NOT needed: the low-level reader returns the WKB
        # geometry column plus one array per attribute column.
        meta, _index, geometry, fields = pyogrio.raw.read(local, layer=0)
    except Exception as exc:  # noqa: BLE001
        print(f"[engine] cannot read {local}: {exc}")
        return []

    meta_fields = meta.get("fields")
    columns = list(meta_fields) if meta_fields is not None else []
    by_name = {name: fields[i] for i, name in enumerate(columns)}

    name_col = None
    for cand in ("NAME", "Name", "Zip_Code", "boundary_name_caps", "poly_name", "name"):
        if cand in by_name:
            name_col = cand
            break
    if name_col is None:
        name_col = columns[0] if columns else None

    features = []
    for i, wkb in enumerate(geometry):
        if wkb is None:
            continue
        try:
            geom = shapely.from_wkb(bytes(wkb))
        except Exception:  # noqa: BLE001
            continue
        if geom is None or geom.is_empty:
            continue
        raw = by_name[name_col][i] if name_col else ""
        if hasattr(raw, "item"):  # numpy scalar -> plain Python value
            raw = raw.item()
        features.append({
            "type": "Feature",
            "geometry": geom.__geo_interface__,
            "properties": {"Name": raw, "_id": int(i)},
        })
    return features


def _sanitize_geometry(geom: dict):
    """Repair a GeoJSON polygon so shapely AND MapLibre can both use it.

    The CMS file contains rings with fewer than 4 points (degenerate), which
    makes `shape()` throw and silently drops the polygon from the assignment
    index — its area then gets attributed to the enclosing, larger polygon.
    Returns a GeoJSON geometry dict, or None when nothing usable remains.
    """
    import shapely
    from shapely.geometry import shape as _shape

    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not gtype or coords is None:
        return None

    def clean_ring(ring):
        if not isinstance(ring, (list, tuple)):
            return None
        pts = [p for p in ring if isinstance(p, (list, tuple)) and len(p) >= 2]
        if len(pts) < 4:
            return None
        if pts[0] != pts[-1]:
            pts.append(pts[0])
        return pts if len(pts) >= 4 else None

    if gtype == "Polygon":
        rings = [r for r in (clean_ring(r) for r in coords) if r]
        if not rings:
            return None
        cleaned = {"type": "Polygon", "coordinates": rings}
    elif gtype == "MultiPolygon":
        polys = []
        for poly in coords:
            rings = [r for r in (clean_ring(r) for r in poly) if r]
            if rings:
                polys.append(rings)
        if not polys:
            return None
        cleaned = {"type": "MultiPolygon", "coordinates": polys}
    else:
        return None

    try:
        obj = _shape(cleaned)
    except Exception:  # noqa: BLE001
        return None
    if obj.is_empty:
        return None
    if not obj.is_valid:
        obj = shapely.make_valid(obj)
        parts = [
            p for p in shapely.get_parts(obj)
            if p.geom_type in ("Polygon", "MultiPolygon")
        ]
        if not parts:
            return None
        obj = shapely.union_all(parts)
        if obj.is_empty:
            return None
    return obj.__geo_interface__


def _round_coords(value, ndigits: int = 5):
    """Round a GeoJSON coordinate tree (~1 m precision at 5 decimals).

    Shrinks the boundary payload a lot: the CMS file carries 12+ decimals
    that no zoom level can resolve."""
    if isinstance(value, (int, float)):
        return round(float(value), ndigits)
    if isinstance(value, (list, tuple)):
        return [_round_coords(v, ndigits) for v in value]
    return value


def geojson_payload(boundary: str) -> dict:
    """The polygons as a display-ready FeatureCollection (cached).

    Each feature carries `name` (the match key) and `label` (the human name).
    """
    with _geom_lock:
        cached = _geojson_cache.get(boundary)
        if cached is not None:
            return cached

    out = []
    for feat in boundary_features(boundary):
        props = feat.get("properties") or {}
        raw = None
        for key in ("name", "NAME", "Name", "Zip_Code", "Subdivision"):
            if props.get(key) not in (None, ""):
                raw = props[key]
                break
        geom = feat.get("geometry") or {}
        out.append({
            "type": "Feature",
            "geometry": {
                "type": geom.get("type"),
                "coordinates": _round_coords(geom.get("coordinates")),
            },
            "properties": {
                "name": fd.clean_boundary_name(raw),
                "label": fd.expand_boundary_name(raw),
            },
        })
    payload = {"type": "FeatureCollection", "features": out}
    with _geom_lock:
        _geojson_cache[boundary] = payload
    return payload


def _feature_name(feature: dict) -> str:
    props = feature.get("properties") or {}
    for key in ("name", "NAME", "Name", "Zip_Code", "Subdivision"):
        val = props.get(key)
        if val not in (None, ""):
            return str(val)
    return ""


def _build_index(boundary: str):
    """(STRtree, geoms, names) for a boundary class."""
    features = boundary_features(boundary)
    geoms, names, feature_ids, base_names = [], [], [], []
    import shapely

    for feature_id, feat in enumerate(features):
        try:
            geom = shape(feat["geometry"])
        except Exception:  # noqa: BLE001
            continue
        if geom is None or geom.is_empty:
            continue
        if not geom.is_valid:
            # Self-intersecting rings make containment tests unreliable.
            fixed = shapely.make_valid(geom)
            if fixed.geom_type == "GeometryCollection":
                parts = [
                    p for p in shapely.get_parts(fixed)
                    if p.geom_type in ("Polygon", "MultiPolygon")
                ]
                fixed = shapely.union_all(parts) if parts else None
            geom = fixed
            if geom is None or geom.is_empty:
                continue
        name = fd.clean_boundary_name(_feature_name(feat))
        if not name:
            continue
        props = feat.get("properties") or {}
        base = fd.clean_boundary_name(props.get("base_name") or name)
        geoms.append(geom)
        names.append(name)
        feature_ids.append(feature_id)
        base_names.append(base)
    if not geoms:
        return None, [], [], [], []
    return STRtree(geoms), geoms, names, feature_ids, base_names


_index_cache: dict[str, tuple] = {}
_index_lock = threading.Lock()


def _get_index(boundary: str):
    with _index_lock:
        if boundary in _index_cache:
            return _index_cache[boundary]
    tree, geoms, names, fids, bases = _build_index(boundary)
    with _index_lock:
        _index_cache[boundary] = (tree, geoms, names, fids, bases)
    return tree, geoms, names, fids, bases


def assign_points(boundary: str, lats: list, lngs: list) -> list[str]:
    """Assign each point to a polygon name (smallest containing polygon wins)."""
    tree, geoms, names, _fids, _bases = _get_index(boundary)
    if tree is None:
        return []
    out = []
    for lat, lng in zip(lats, lngs):
        if lat is None or lng is None:
            out.append("")
            continue
        try:
            pt = Point(float(lng), float(lat))
        except (TypeError, ValueError):
            out.append("")
            continue
        hits = tree.query(pt)
        # STRtree returns bounding-box CANDIDATES — keep only the polygons
        # that really contain the point, or every point near a polygon's
        # bbox would be assigned to it.
        hits = [i for i in hits if geoms[i].intersects(pt)]
        if len(hits) == 0:
            out.append("")
            continue
        # smallest containing polygon wins
        best = min(hits, key=lambda i: geoms[i].area)
        out.append(names[best])
    return out


# ── Aggregates ───────────────────────────────────────────────────────────────

_METRIC_EXPR = {
    # Sanitized inside the metric: corrupt list prices (e.g. $449) must not
    # skew the ratio, but the row itself still counts as a sale elsewhere.
    "__l2s": (
        "CASE WHEN list_price > 0 "
        "AND (close_price * 100.0 / list_price) BETWEEN 10 AND 1000 "
        "THEN (close_price * 100.0 / list_price) END"
    ),
    "__dom": "(coalesce(cdom,0) + coalesce(dom,0))",
    "__r2s": "CASE WHEN close_price > 0 AND listing_type = 'rent' THEN (close_price * 12.0) / close_price END",
}


def _metric_expr(metric: dict) -> str:
    col = metric["col"]
    if col in _METRIC_EXPR:
        return _METRIC_EXPR[col]
    return col


_POLY_COLUMN_BY_CLASS = {
    "subdivisions": "poly_id_subdivisions",
    "neighborhoods": "poly_id_subdivisions",
    "zipcodes": "poly_id_zipcodes",
    "highschools": "poly_id_highschools",
    "elementary": "poly_id_elementary",
    "middle": "poly_id_middle",
}
_poly_ready: bool | None = None


def poly_columns_ready() -> bool:
    """True once `assign_polygons.py` has created the five columns."""
    global _poly_ready
    if _poly_ready is None:
        try:
            rows = fd.sql_rows(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'properties' AND column_name LIKE 'poly_id_%'"
            )
            have = {r.get("column_name") for r in rows}
            _poly_ready = all(
                col in have for col in set(_POLY_COLUMN_BY_CLASS.values())
            )
        except Exception:  # noqa: BLE001
            _poly_ready = False
    return bool(_poly_ready)


def _group_col(boundary: str) -> str:
    """The column that carries the polygon name for a boundary class.

    Uses the assigned polygon column when the one-time job has run (exact),
    otherwise falls back to the row's own text field.
    """
    fallback = {
        "subdivisions": "subdivisions",
        "neighborhoods": "subdivisions",
        "zipcodes": "zipcodes",
        "highschools": "highschools",
        "elementary": "elementary",
        "middle": "middle",
    }.get(boundary, "subdivisions")
    if boundary in _POLY_COLUMN_BY_CLASS and poly_columns_ready():
        return _POLY_COLUMN_BY_CLASS[boundary]
    return fallback


# ── small in-process cache ───────────────────────────────────────────────────
# The same (metric, boundary, period, filters) is requested over and over while
# the user pans/clicks; a warm instance answers instantly.
_cache_lock = threading.Lock()
_agg_cache: dict[str, tuple[float, dict]] = {}
CACHE_TTL = 300.0


def _cache_key(*parts) -> str:
    return json.dumps(parts, sort_keys=True, default=str)


def _cache_get(key: str):
    with _cache_lock:
        hit = _agg_cache.get(key)
        if hit and (time.time() - hit[0]) < CACHE_TTL:
            return hit[1]
        return None


def _cache_put(key: str, value):
    with _cache_lock:
        if len(_agg_cache) > 64:
            _agg_cache.clear()
        _agg_cache[key] = (time.time(), value)


_key_locks: dict[str, threading.Lock] = {}
_key_locks_guard = threading.Lock()


def _inflight_lock(key: str) -> threading.Lock:
    with _key_locks_guard:
        lock = _key_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            if len(_key_locks) > 128:
                _key_locks.clear()
            _key_locks[key] = lock
        return lock


def aggregate_by_name(
    metric_key: str,
    boundary: str,
    filters: dict,
    period: str,
) -> dict[str, dict]:
    """Per-polygon aggregates (memoized + single-flight).

    Two requests for the same filters wait for ONE Postgres query instead of
    stacking identical heavy scans on the small instance.
    """
    metric = METRIC_BY_KEY.get(metric_key)
    if not metric:
        return {}
    key = _cache_key("by_name", metric_key, boundary, period, filters)
    with _inflight_lock(key):
        cached = _cache_get(key)
        if cached is not None:
            return cached
        out = _aggregate_impl(metric, boundary, filters, period)
        _cache_put(key, out)
        return out


def _aggregate_impl(metric: dict, boundary: str, filters: dict, period: str) -> dict[str, dict]:
    metric_key = metric["key"]
    # Rent-to-Sale is not a row-level value: it needs the rent median and the
    # sale median of the SAME polygon. The old app computed
    # (rent_median * 12) / sale_median — replicate it exactly.
    if metric_key == "Rent-to-Sale Ratio":
        return _rent_to_sale(boundary, filters, period)

    where, _ = _filter_sql(filters)
    kind = _kind_clause(metric)
    if kind:
        where += f" AND {kind}"
    per = _period_sql(period)
    if per:
        where += f" AND {per}"

    expr = _metric_expr(metric)
    col = _group_col(boundary)
    sql = (
        f"SELECT {col} AS poly_name, "
        f"count({expr})::int AS n, "
        f"percentile_cont(0.5) WITHIN GROUP (ORDER BY {expr}) AS med, "
        f"avg({expr}) AS avg_v, "
        f"min({expr}) AS min_v, max({expr}) AS max_v, "
        f"sum(coalesce(close_price,0)) AS total_volume "
        f"FROM properties WHERE {where} "
        f"AND {col} IS NOT NULL AND {col} <> '' "
        f"GROUP BY 1"
    )
    rows = fd.sql_rows(sql)
    out: dict[str, dict] = {}
    for r in rows:
        name = fd.clean_boundary_name(r.get("poly_name"))
        if not name:
            continue
        out[name] = {
            "name": name,
            "count": int(r.get("n") or 0),
            "value": _num(r.get("med")),
            "avg": _num(r.get("avg_v")),
            "min": _num(r.get("min_v")),
            "max": _num(r.get("max_v")),
            "total_volume": _num(r.get("total_volume")),
        }
    return out


def _rent_to_sale(boundary: str, filters: dict, period: str) -> dict[str, dict]:
    """(rent median * 12) / sale median per polygon — the old app's formula.

    Built from the two cached row-level aggregates instead of a second heavy
    CTE: the rent and sale medians are already computed (and memoized) for the
    map, so combining them is instant and never duplicates Postgres work.
    """
    rent = aggregate_by_name("Est. Rental Price", boundary, filters, period)
    sale = aggregate_by_name("Close Price", boundary, filters, period)
    out: dict[str, dict] = {}
    for name, r in rent.items():
        s = sale.get(name)
        if not s or not r.get("value") or not s.get("value"):
            continue
        value = (float(r["value"]) * 12.0) / float(s["value"])
        out[name] = {
            "name": name,
            "count": min(int(r.get("count") or 0), int(s.get("count") or 0)),
            "value": value,
            "avg": value,
            "min": value,
            "max": value,
            "total_volume": 0.0,
        }
    return out


def _num(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def aggregate_by_geometry(
    metric_key: str,
    boundary: str,
    filters: dict,
    period: str,
) -> dict[str, dict]:
    """Per-polygon aggregates computed by point-in-polygon.

    Used for the `areas` (custom) boundary and as the geographic fallback.
    The rows come back from Postgres with their coordinates; shapely decides
    which polygon each row belongs to.
    """
    metric = METRIC_BY_KEY.get(metric_key)
    if not metric:
        return {}
    if metric_key == "Rent-to-Sale Ratio":
        # Requires a rent median joined to a sale median; the geometry path
        # would have to run the same join per custom area.
        return {}
    where, _ = _filter_sql(filters)
    kind = _kind_clause(metric)
    if kind:
        where += f" AND {kind}"
    per = _period_sql(period)
    if per:
        where += f" AND {per}"
    expr = _metric_expr(metric)

    sql = (
        f"SELECT lat, lng, {expr} AS v, close_price FROM properties "
        f"WHERE {where} AND lat IS NOT NULL AND lng IS NOT NULL "
        f"AND lat <> 0 AND lng <> 0 AND {expr} IS NOT NULL"
    )
    rows = fd.sql_rows(sql)
    if not rows:
        return {}

    lats = [r.get("lat") for r in rows]
    lngs = [r.get("lng") for r in rows]
    names = assign_points(boundary, lats, lngs)

    buckets: dict[str, list] = defaultdict(list)
    volumes: dict[str, float] = defaultdict(float)
    for r, name in zip(rows, names):
        if not name:
            continue
        v = _num(r.get("v"))
        if v is None:
            continue
        buckets[name].append(v)
        volumes[name] += float(r.get("close_price") or 0)

    def median(values: list) -> float:
        s = sorted(values)
        n = len(s)
        if n == 0:
            return None
        mid = n // 2
        return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0

    out: dict[str, dict] = {}
    for name, values in buckets.items():
        out[name] = {
            "name": name,
            "count": len(values),
            "value": median(values),
            "avg": sum(values) / len(values),
            "min": min(values),
            "max": max(values),
            "total_volume": volumes.get(name, 0.0),
        }
    return out


def area_stats(
    filters: dict,
    period: str,
    selected_names: list[str] | None = None,
    boundary: str = "subdivisions",
) -> dict:
    """The report's row-level stats for a selection (or everything)."""
    where, _ = _filter_sql(filters)
    per = _period_sql(period)
    if per:
        where += f" AND {per}"
    col = _group_col(boundary)
    sel = ""
    if selected_names:
        sel = " AND " + col + " IN (" + ", ".join(
            _sql_escape(fd.clean_boundary_name(n)) for n in selected_names
        ) + ")"

    sql = (
        "SELECT "
        "count(*) FILTER (WHERE coalesce(listing_type,'sale') <> 'tax')::int AS n, "
        "avg(close_price) FILTER (WHERE coalesce(listing_type,'sale') NOT IN ('rent','tax') "
        "  AND close_date IS NOT NULL AND close_date <> '') AS avg_sale, "
        "avg(price_per_sqft) FILTER (WHERE coalesce(listing_type,'sale') NOT IN ('rent','tax') "
        "  AND close_date IS NOT NULL AND close_date <> '' AND price_per_sqft > 0) AS avg_psf, "
        "avg((coalesce(cdom,0) + coalesce(dom,0))) FILTER (WHERE coalesce(listing_type,'sale') NOT IN ('rent','tax') "
        "  AND close_date IS NOT NULL AND close_date <> '') AS avg_dom, "
        "sum(close_price) FILTER (WHERE coalesce(listing_type,'sale') NOT IN ('rent','tax') "
        "  AND close_date IS NOT NULL AND close_date <> '') AS total_volume, "
        "avg(tax_amount) FILTER (WHERE tax_amount IS NOT NULL AND tax_amount > 0) AS avg_tax, "
        "percentile_cont(0.5) WITHIN GROUP (ORDER BY tax_rate::numeric) "
        "FILTER (WHERE tax_rate IS NOT NULL AND tax_rate > 0 AND tax_rate < 15) AS avg_tax_rate, "
        "count(tax_amount) FILTER (WHERE tax_amount IS NOT NULL AND tax_amount > 0) AS tax_rows, "
        "percentile_cont(0.5) WITHIN GROUP (ORDER BY close_price::numeric) "
        "FILTER (WHERE listing_type = 'rent') AS median_rent, "
        "percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_sqft::numeric) "
        "FILTER (WHERE listing_type = 'rent' AND price_per_sqft > 0) AS median_rent_psf, "
        "count(*) FILTER (WHERE listing_type = 'rent') AS rent_rows "
        f"FROM properties WHERE {where}{sel}"
    )
    rows = fd.sql_rows(sql)
    r = rows[0] if rows else {}
    count = int(r.get("n") or 0)
    tax_rows = int(r.get("tax_rows") or 0)
    return {
        "count": count,
        "avgSale": _num(r.get("avg_sale")),
        "avgSqft": _num(r.get("avg_psf")),
        "avgDom": _num(r.get("avg_dom")),
        "totalVolume": _num(r.get("total_volume")) or 0.0,
        "avgTaxAmount": _num(r.get("avg_tax")),
        "avgTaxRate": _num(r.get("avg_tax_rate")),
        "taxCoverage": min(1.0, (tax_rows / count)) if count else 0.0,
        "taxRows": tax_rows,
        "medianRent": _num(r.get("median_rent")),
        "medianRentPsf": _num(r.get("median_rent_psf")),
        "rentCount": int(r.get("rent_rows") or 0),
    }


def market_health(
    filters: dict,
    period: str,
    boundary: str,
    selected_names: list[str] | None = None,
) -> dict:
    """Months of inventory, DOM, list-to-sale and volume trend.

    Same four tiles as the reference report. MOI is active for-sale rows
    (no close date) over the average monthly closings of the last year.
    """
    where, _ = _filter_sql(filters)
    col = _group_col(boundary)
    sel = ""
    if selected_names:
        sel = " AND " + col + " IN (" + ", ".join(
            _sql_escape(fd.clean_boundary_name(n)) for n in selected_names
        ) + ")"

    now = int(__import__("time").time() * 1000)
    year = 365 * 86400000
    sql = (
        "SELECT "
        "count(*) FILTER (WHERE coalesce(listing_type,'sale') NOT IN ('rent','tax') "
        "  AND close_date_ts IS NULL)::int AS active, "
        "count(*) FILTER (WHERE coalesce(listing_type,'sale') NOT IN ('rent','tax') "
        f"  AND close_date_ts >= {now - year})::int AS sold_12m, "
        f"sum(close_price) FILTER (WHERE coalesce(listing_type,'sale') NOT IN ('rent','tax') AND close_date_ts >= {now - year}) AS vol_now, "
        f"sum(close_price) FILTER (WHERE coalesce(listing_type,'sale') NOT IN ('rent','tax') AND close_date_ts >= {now - 2 * year} AND close_date_ts < {now - year}) AS vol_prev, "
        "percentile_cont(0.5) WITHIN GROUP (ORDER BY "
        "  CASE WHEN list_price > 0 THEN close_price * 100.0 / list_price END) "
        "  FILTER (WHERE close_date_ts >= " + str(now - year) + ") AS l2s, "
        "avg(coalesce(nullif(cdom, 0), dom)) FILTER (WHERE coalesce(listing_type,'sale') NOT IN ('rent','tax') "
        f"  AND close_date_ts >= {now - year}) AS dom "
        f"FROM properties WHERE {where}{sel}"
    )
    rows = fd.sql_rows(sql)
    r = rows[0] if rows else {}
    active = int(r.get("active") or 0)
    sold_12m = int(r.get("sold_12m") or 0)
    # No active-listing rows in the table → no inventory figure. Do not show
    # a fake 0.0; the report hides the tile when the value is null.
    mois = (active / (sold_12m / 12.0)) if (active > 0 and sold_12m) else None
    dom = _num(r.get("dom"))
    l2s = _num(r.get("l2s"))
    vol_now = _num(r.get("vol_now")) or 0.0
    vol_prev = _num(r.get("vol_prev")) or 0.0
    trend = ((vol_now - vol_prev) / vol_prev * 100.0) if vol_prev else None

    # The reference score: DOM (lower is hotter) + list-to-sale (higher is hotter).
    score = 50.0
    if dom is not None:
        score += max(-25.0, min(25.0, (90.0 - dom) / 90.0 * 25.0))
    if l2s is not None:
        score += max(-25.0, min(25.0, (l2s - 95.0) / 10.0 * 25.0))
    score = max(0.0, min(100.0, score))
    if score >= 65:
        label, color = "Seller's Market", "#ef4444"
    elif score >= 35:
        label, color = "Neutral Market", "#f59e0b"
    else:
        label, color = "Buyer's Market", "#3b82f6"

    return {
        "score": score,
        "label": label,
        "color": color,
        "moi": mois,
        "dom": dom,
        "l2s": l2s,
        "volumeTrend": trend,
        "active": active,
        "sold12m": sold_12m,
    }


def time_series(metric_key: str, filters: dict, period: str, boundary: str,
                selected_names: list[str] | None = None) -> list[dict]:
    """The metric over time (for the Time Series card)."""
    metric = METRIC_BY_KEY.get(metric_key)
    if not metric:
        return []
    where, _ = _filter_sql(filters)
    kind = _kind_clause(metric)
    if kind:
        where += f" AND {kind}"
    col = _group_col(boundary)
    if selected_names:
        where += " AND " + col + " IN (" + ", ".join(
            _sql_escape(fd.clean_boundary_name(n)) for n in selected_names
        ) + ")"
    expr = _metric_expr(metric)
    sql = (
        f"SELECT close_year AS yr, percentile_cont(0.5) WITHIN GROUP (ORDER BY {expr}) AS med, "
        f"count(*)::int AS n FROM properties WHERE {where} "
        f"AND close_year IS NOT NULL AND close_year > 0 AND {expr} IS NOT NULL "
        f"GROUP BY 1 ORDER BY 1"
    )
    rows = fd.sql_rows(sql)
    return [
        {"period": str(r.get("yr")), "value": _num(r.get("med")), "count": int(r.get("n") or 0)}
        for r in rows
    ]


def year_built_histogram(filters: dict, period: str, boundary: str,
                         selected_names: list[str] | None = None) -> list[dict]:
    """Year-built buckets (Before 1970 / 1970–1989 / 1990–2009 / 2010+)."""
    where, _ = _filter_sql(filters)
    where += " AND coalesce(listing_type, 'sale') NOT IN ('rent', 'tax')"
    per = _period_sql(period)
    if per:
        where += f" AND {per}"
    col = _group_col(boundary)
    if selected_names:
        where += " AND " + col + " IN (" + ", ".join(
            _sql_escape(fd.clean_boundary_name(n)) for n in selected_names
        ) + ")"
    sql = (
        "SELECT "
        "count(*) FILTER (WHERE year_built < 1970)::int AS b1, "
        "count(*) FILTER (WHERE year_built >= 1970 AND year_built < 1990)::int AS b2, "
        "count(*) FILTER (WHERE year_built >= 1990 AND year_built < 2010)::int AS b3, "
        "count(*) FILTER (WHERE year_built >= 2010)::int AS b4 "
        f"FROM properties WHERE {where} AND year_built IS NOT NULL"
    )
    rows = fd.sql_rows(sql)
    r = rows[0] if rows else {}
    labels = ["Before 1970", "1970–1989", "1990–2009", "2010+"]
    keys = ["b1", "b2", "b3", "b4"]
    return [{"bucket": labels[i], "count": int(r.get(keys[i]) or 0)} for i in range(4)]


def distinct_values(column: str, limit: int = 200) -> list[str]:
    """Distinct values for a filter dropdown (property types, cities, schools)."""
    sql = (
        f"SELECT {column} AS v, count(*)::int AS n FROM properties "
        f"WHERE upload_session_id IS NULL AND {column} IS NOT NULL AND {column} <> '' "
        f"GROUP BY 1 ORDER BY n DESC LIMIT {int(limit)}"
    )
    return [str(r.get("v")) for r in fd.sql_rows(sql) if r.get("v")]


def dataset_status() -> dict:
    """Row counts by year + total — for the summary bar."""
    rows = fd.sql_rows(
        "SELECT dataset_year AS yr, count(*)::int AS n FROM properties "
        "WHERE upload_session_id IS NULL GROUP BY 1 ORDER BY 1"
    )
    by_year = {str(r.get("yr")): int(r.get("n") or 0) for r in rows}
    return {"byYear": by_year, "total": sum(by_year.values())}
