"""
metrics.py — the metric + filter model, ported from `new kwizi`.

Source of truth (read-only, never modified by this port):
  - new kwizi/src/lib/metrics.ts          → METRICS (key, label, category)
  - new kwizi/src/lib/engineCore.ts       → PropertyFilters, DEFAULT_FILTERS,
                                            periodWindow, activeFilterCount
  - new kwizi/src/app/map/page.tsx        → PERIODS, BOUNDARIES, FIXED_PALETTE

Everything here is pure data / pure functions: no I/O, no framework.
"""

from datetime import datetime, timedelta, timezone

# ── METRICS (verbatim from new kwizi/src/lib/metrics.ts) ──────────────────────
#
# key, label, category. `sql` is the column the aggregate reads; `kind` says
# which rows feed the metric (sale rows / rental rows / both).
METRICS = [
    {"key": "Close Price", "label": "Sales Price", "category": "sale",
     "col": "close_price", "kind": "sale", "fmt": "money"},
    {"key": "Price per Sqft", "label": "Sale Price / Sq.Ft.", "category": "sale",
     "col": "price_per_sqft", "kind": "sale", "fmt": "money2"},
    {"key": "List-to-Sale Ratio", "label": "List-to-Sale Ratio", "category": "sale",
     "col": "__l2s", "kind": "sale", "fmt": "pct"},
    {"key": "Days on Market", "label": "Sale Days on Market", "category": "sale",
     "col": "__dom", "kind": "sale", "fmt": "days"},
    {"key": "Est. Rental Price", "label": "Rental Price", "category": "rental",
     "col": "close_price", "kind": "rent", "fmt": "money"},
    {"key": "Rent-to-Sale Ratio", "label": "Rent-to-Sale Ratio", "category": "rental",
     "col": "__r2s", "kind": "both", "fmt": "ratio3"},
    {"key": "Rental Price per Sqft", "label": "Rental Price / Sq.Ft.", "category": "rental",
     "col": "price_per_sqft", "kind": "rent", "fmt": "money2"},
    {"key": "Rental Days On Market", "label": "Rent Days on Market", "category": "rental",
     "col": "__dom", "kind": "rent", "fmt": "days"},
    {"key": "Lot Size", "label": "Lot Size", "category": "sale",
     "col": "lot_size", "kind": "both", "fmt": "number"},
    {"key": "Appreciation Rate", "label": "Appreciation Rate", "category": "market",
     "col": "__appreciation", "kind": "sale", "fmt": "pct"},
    {"key": "Investor Index", "label": "Investor's Index", "category": "market",
     "col": "__investor", "kind": "sale", "fmt": "score"},
    {"key": "Annual HOA Fee", "label": "Annual HOA Fee", "category": "cost",
     "col": "maint_fee", "kind": "sale", "fmt": "money"},
    {"key": "Last Year Tax Rate", "label": "Last Year Tax Rate", "category": "cost",
     "col": "tax_rate", "kind": "sale", "fmt": "pct4"},
    {"key": "Elem ETA Score", "label": "Elementary ETA Score", "category": "school",
     "col": "__eta_elem", "kind": "none", "fmt": "score"},
    {"key": "Middle ETA Score", "label": "Middle ETA Score", "category": "school",
     "col": "__eta_middle", "kind": "none", "fmt": "score"},
    {"key": "High ETA Score", "label": "High School District ETA", "category": "school",
     "col": "__eta_high", "kind": "none", "fmt": "score"},
]

METRIC_BY_KEY = {m["key"]: m for m in METRICS}
DEFAULT_METRIC = "Close Price"

# ── BOUNDARIES (verbatim from new kwizi/src/app/map/page.tsx) ─────────────────
BOUNDARIES = [
    {"key": "subdivisions", "name": "Subdivisions", "short": "Subdivisions", "premium": True},
    {"key": "zipcodes", "name": "Zip Codes", "short": "Zip Codes", "premium": False},
    {"key": "highschools", "name": "School Districts", "short": "Districts", "premium": True},
    {"key": "elementary", "name": "Elementary", "short": "Elementary", "premium": True},
    {"key": "areas", "name": "Custom Areas", "short": "Custom", "premium": False},
    {"key": "middle", "name": "Middle Schools", "short": "Middle", "premium": True},
    {"key": "neighborhoods", "name": "Neighborhoods", "short": "Neighborhoods", "premium": True},
]
BOUNDARY_BY_KEY = {b["key"]: b for b in BOUNDARIES}
DEFAULT_BOUNDARY = "subdivisions"

# The R2 gpkg layer id per boundary (the old map's geometry source).
BOUNDARY_GEOM = {
    "subdivisions": "subdivisions",
    "neighborhoods": "neighbors",
    "zipcodes": "zip",
    "highschools": "high",
    "elementary": "elem",
    "middle": "middle",
}

# ── PERIODS (verbatim) ───────────────────────────────────────────────────────
# Calendar-year semantics on the dataset_year axis (the owner's rule):
#   all  → no bound
#   ytd  → the current calendar year
#   1y..5y → that exact calendar year, N years back
#   30d/90d/6m → rolling close-date windows
def period_labels(now_year: int | None = None) -> list[dict]:
    """Exactly the original app's Close Period list (same labels and order).

    The rolling windows are anchored on the dataset's last close date, not on
    today: the reference shows "Mar 30, 2026 – Sep 30, 2026" for "Last 6 months"
    because its data ends on Sep 30, 2026.
    """
    return [
        {"key": "30d", "label": "Last 30 days"},
        {"key": "90d", "label": "Last 90 days"},
        {"key": "6m", "label": "Last 6 months"},
        {"key": "ytd", "label": "Year-to-Date"},
        {"key": "1y", "label": "1 year"},
        {"key": "3y", "label": "3 years"},
        {"key": "5y", "label": "5 years"},
        {"key": "all", "label": "All data"},
    ]


PERIODS = period_labels()
PERIOD_BY_KEY = {p["key"]: p for p in PERIODS}
DEFAULT_PERIOD = "5y"

# Market Health's own period selector (verbatim from ReportCards.tsx).
PERIOD_SHORT = ["All data", "30d", "90d", "6mo", "YTD", "1y", "3y", "5y"]
PERIOD_SHORT_KEYS = ["all", "30d", "90d", "6m", "ytd", "1y", "3y", "5y"]




def _days_in_month(year: int, month: int) -> int:
    import calendar as _calendar

    return _calendar.monthrange(year, month)[1]


def period_window(period: str, reference: datetime | None = None) -> dict:
    """The (start_ts, end_ts, dataset_year_min, dataset_year_max) window for a
    period key. Ported from engineCore.ts `periodWindow`.

    Timestamps are the UTC midnight of a close date, so the window is compared
    in UTC: an anchor date is included END TO END (the original app's
    "Sep 30, 2025 – Sep 30, 2026" includes both days). Using the machine's
    local timezone here silently dropped the first day of every rolling window.
    """
    ref = reference or datetime.now()
    year = ref.year

    def utc_ms(dt: datetime) -> int:
        return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)

    def end_of_day(dt: datetime) -> int:
        return utc_ms(dt.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)) - 1

    end_ts = end_of_day(ref)
    if period == "all":
        return {"startTs": None, "endTs": None, "datasetYearMin": None, "datasetYearMax": None}
    if period == "30d":
        start = ref - timedelta(days=30)
        return {"startTs": utc_ms(start), "endTs": end_ts,
                "datasetYearMin": None, "datasetYearMax": None}
    if period == "90d":
        start = ref - timedelta(days=90)
        return {"startTs": utc_ms(start), "endTs": end_ts,
                "datasetYearMin": None, "datasetYearMax": None}
    if period == "6m":
        # SIX CALENDAR MONTHS, not 180 days: the reference's "Last 6 months"
        # on Sep 30, 2026 starts on Mar 30, 2026.
        year2, month2 = ref.year, ref.month - 6
        while month2 <= 0:
            month2 += 12
            year2 -= 1
        day2 = min(ref.day, _days_in_month(year2, month2))
        start = ref.replace(year=year2, month=month2, day=day2)
        return {"startTs": utc_ms(start), "endTs": end_ts,
                "datasetYearMin": None, "datasetYearMax": None}
    if period == "ytd":
        return {"startTs": None, "endTs": None, "datasetYearMin": year, "datasetYearMax": year}
    if period in ("1y", "2y", "3y", "4y", "5y", "r1y", "r2y", "r3y", "r4y", "r5y"):
        # Rolling calendar years back from the dataset's last close date — the
        # original app's "1 year / 3 years / 5 years".
        years = int(period[1] if period.startswith("r") else period[0])
        try:
            start = ref.replace(year=ref.year - years)
        except ValueError:  # Feb 29
            start = ref.replace(year=ref.year - years, day=28)
        return {"startTs": utc_ms(start), "endTs": end_ts,
                "datasetYearMin": None, "datasetYearMax": None}
    return {"startTs": None, "endTs": None, "datasetYearMin": None, "datasetYearMax": None}


# ── Property filters (verbatim from engineCore.ts) ───────────────────────────
DEFAULT_FILTERS = {
    "bedsMin": 0, "bedsMax": 20,
    "bathsMin": 0, "bathsMax": 20,
    "sqftMin": 0, "sqftMax": 20000,
    "saleMin": 0, "saleMax": 20000000,
    "rentMin": 0, "rentMax": 50000,
    "pricePerSqftMin": 0, "pricePerSqftMax": 5000,
    "lotSizeMin": 0, "lotSizeMax": 1000000,
    "domMin": 0, "domMax": 2000,
    "l2sMin": 50, "l2sMax": 150,
    "yearMin": 1920, "yearMax": datetime.now().year,
    "period": "all",
    "propertyTypes": [], "pool": "any",
    "schoolDistricts": [], "cities": [],
    "elementary": [], "middle": [], "highschools": [],
    "elementaryRating": [], "middleRating": [], "highRating": [],
}

RATING_OPTIONS = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"]

# The eight range controls, verbatim labels + bounds (page.tsx).
RANGE_CONTROLS = [
    {"label": "Sale Price", "min": 0, "max": 20000000, "step": 100000,
     "low": "saleMin", "high": "saleMax", "fmt": "money"},
    {"label": "Est. Rent", "min": 0, "max": 50000, "step": 500,
     "low": "rentMin", "high": "rentMax", "fmt": "money"},
    {"label": "Sq.Ft.", "min": 0, "max": 20000, "step": 250,
     "low": "sqftMin", "high": "sqftMax", "fmt": "sqft"},
    {"label": "Price / Sq.Ft.", "min": 0, "max": 5000, "step": 10,
     "low": "pricePerSqftMin", "high": "pricePerSqftMax", "fmt": "money"},
    {"label": "Lot Size", "min": 0, "max": 1000000, "step": 5000,
     "low": "lotSizeMin", "high": "lotSizeMax", "fmt": "number"},
    {"label": "Year Built", "min": 1920, "max": datetime.now().year, "step": 1,
     "low": "yearMin", "high": "yearMax", "fmt": "number"},
    {"label": "Days on Market", "min": 0, "max": 2000, "step": 10,
     "low": "domMin", "high": "domMax", "fmt": "days"},
    {"label": "List-to-Sale Ratio", "min": 50, "max": 150, "step": 1,
     "low": "l2sMin", "high": "l2sMax", "fmt": "pct"},
]


def active_filter_count(f: dict) -> int:
    """How many filter GROUPS differ from the defaults (max 20).
    Ported verbatim from engineCore.ts `activeFilterCount`."""
    n = 0
    d = DEFAULT_FILTERS
    if f.get("period") != d["period"]:
        n += 1
    if f.get("bedsMin", 0) > d["bedsMin"] or f.get("bedsMax", 0) < d["bedsMax"]:
        n += 1
    if f.get("bathsMin", 0) > d["bathsMin"] or f.get("bathsMax", 0) < d["bathsMax"]:
        n += 1
    if f.get("sqftMin", 0) > d["sqftMin"] or f.get("sqftMax", 0) < d["sqftMax"]:
        n += 1
    if f.get("saleMin", 0) > d["saleMin"] or f.get("saleMax", 0) < d["saleMax"]:
        n += 1
    if f.get("rentMin", 0) > d["rentMin"] or f.get("rentMax", 0) < d["rentMax"]:
        n += 1
    if f.get("pricePerSqftMin", 0) > d["pricePerSqftMin"] or f.get("pricePerSqftMax", 0) < d["pricePerSqftMax"]:
        n += 1
    if f.get("lotSizeMin", 0) > d["lotSizeMin"] or f.get("lotSizeMax", 0) < d["lotSizeMax"]:
        n += 1
    if f.get("domMin", 0) > d["domMin"] or f.get("domMax", 0) < d["domMax"]:
        n += 1
    if f.get("l2sMin", 0) > d["l2sMin"] or f.get("l2sMax", 0) < d["l2sMax"]:
        n += 1
    if f.get("yearMin", 0) > d["yearMin"] or f.get("yearMax", 0) < d["yearMax"]:
        n += 1
    if f.get("propertyTypes"):
        n += 1
    if f.get("pool") != d["pool"]:
        n += 1
    if f.get("schoolDistricts"):
        n += 1
    if f.get("cities"):
        n += 1
    if f.get("elementary"):
        n += 1
    if f.get("middle"):
        n += 1
    if f.get("highschools"):
        n += 1
    if f.get("elementaryRating"):
        n += 1
    if f.get("middleRating"):
        n += 1
    if f.get("highRating"):
        n += 1
    return n


# ── The fixed palette (verbatim from page.tsx FIXED_PALETTE) ─────────────────
FIXED_PALETTE = [
    "#5e4fa2", "#3288bd", "#66c2a5", "#abdda4", "#e6f598",
    "#fee08b", "#fdae61", "#f46d43", "#d53e4f", "#9e0142",
]
SOLID_BLUE = "#2c7be5"   # the map's default: every polygon solid blue
NO_METRIC = "#374151"    # polygons with no value


# ── Formatting (ported from page.tsx formatMoney / legendFormat.ts) ─────────
def format_money(num) -> str:
    if num is None:
        return "—"
    try:
        n = float(num)
    except (TypeError, ValueError):
        return "—"
    if n >= 1_000_000:
        return f"${n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"${n / 1_000:.0f}K"
    return f"${n:,.0f}"


def format_money_full(num) -> str:
    if num is None:
        return "—"
    try:
        return f"${float(num):,.0f}"
    except (TypeError, ValueError):
        return "—"


def format_sqft(n) -> str:
    if n is None:
        return "—"
    try:
        v = float(n)
    except (TypeError, ValueError):
        return "—"
    return f"{v / 1000:.0f}k" if v >= 1000 else f"{v:.0f}"


def format_days(n) -> str:
    return "—" if n is None else f"{float(n):.0f}d"


def format_pct(n) -> str:
    return "—" if n is None else f"{float(n):.0f}%"


def format_pct4(n) -> str:
    return "—" if n is None else f"{float(n):.4f}%"


def format_number(n) -> str:
    return "—" if n is None else f"{float(n):,.0f}"


def format_ratio(n) -> str:
    return "—" if n is None else f"{float(n):.2f}"


def format_score(n) -> str:
    return "—" if n is None else f"{float(n):.0f}"


_METRIC_FMT = {
    "money": format_money,
    "money2": lambda v: "—" if v is None else f"${float(v):,.2f}",
    "pct": format_pct,
    "pct4": format_pct4,
    "days": format_days,
    "number": format_number,
    "ratio": format_ratio,
    "ratio3": lambda v: "—" if v is None else f"{float(v):.3f}",
    "score": format_score,
    "sqft": format_sqft,
}


def format_metric_value(metric_key: str, value) -> str:
    """Format a metric value using the metric's own unit (legendFormat.ts)."""
    m = METRIC_BY_KEY.get(metric_key)
    if not m:
        return format_number(value)
    return _METRIC_FMT.get(m["fmt"], format_number)(value)


def format_metric_input(metric_key: str, value) -> str:
    """The Scale Range Min/Max input readout."""
    m = METRIC_BY_KEY.get(metric_key)
    if not m:
        return format_number(value)
    fmt = m["fmt"]
    if fmt in ("money", "money2"):
        return "—" if value is None else f"${float(value):,.0f}"
    if fmt == "pct":
        return "—" if value is None else f"{float(value):.0f}%"
    if fmt == "pct4":
        return "—" if value is None else f"{float(value):.4f}%"
    if fmt == "days":
        return "—" if value is None else f"{float(value):.0f}d"
    if fmt == "ratio":
        return "—" if value is None else f"{float(value):.2f}"
    if fmt == "score":
        return "—" if value is None else f"{float(value):.0f}"
    return format_number(value)
