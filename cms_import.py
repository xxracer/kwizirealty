"""
cms_import.py — the data-upload pipeline of the ResDogs CMS.

Ported from `new kwizi` (`src/lib/sqlImport.ts` + `engineCore.normalizeRow`):
a CSV is parsed, each row is mapped to the `properties` columns, and the rows
are staged into Postgres under an `upload_session_id`. "Add All" clears that
id (the rows become visible to the map); "Discard" deletes the session.

The raw file is also stored (gzip) in Cloud Storage and registered in
Firestore `cms_files`, so the CMS inventory matches the main app.
"""

import csv
import gzip
import io
import json
import re
import time
import uuid
from collections import Counter
from datetime import datetime, timezone

import firebase_data as fd
from admin import _set_download_token, _upload_object, _write_firestore_file

# section id -> cms_files category
SECTION_CATEGORY = {
    "sales": "sales",
    "rent": "rent",
    "tax": "tax",
    "current-sales": "current-sale",
    "current-rent": "current-rent",
    "current-tax": "current-tax",
    "schools": "school",
}

RENT_SECTIONS = {"rent", "current-rent"}
TAX_SECTIONS = {"tax", "current-tax"}

RENT_PRICE_HEADERS = [
    "Lease Price", "Rent Price", "Rental Price", "Monthly Rent",
    "Lease Amount", "Price", "Close Price", "Original List Price",
]
LIST_RENT_HEADERS = ["Original List Price", "List Price", "Original Rent", "Listed Rent"]
LEASE_DATE_HEADERS = [
    "Lease Date", "Rented Date", "Contract Date", "Close Date", "Lease Start Date",
]
TAX_MLS_HEADERS = ["MLS #", "MLS Number", "MLS", "Parcel ID", "parcel_id"]
TAX_YEAR_HEADERS = ["Tax Year"]
TAX_AMOUNT_HEADERS = ["Tax Amount", "Taxes"]
TAX_ASSESSED_HEADERS = ["Assessed Total Value", "Assessed Value", "assessed_total_value"]
TAX_RATE_HEADERS = ["Tax Rate", "Tax Rate %"]

INSERT_COLUMNS = [
    "mls_number", "dataset_year", "address", "city", "state", "zip",
    "close_price", "list_price", "price_per_sqft", "sqft", "lot_size",
    "br", "baths", "year_built", "dom", "cdom",
    "close_date", "close_year", "close_date_ts",
    "maint_fee", "maint_fee_schedule", "tax_rate", "tax_year", "tax_amount",
    "subdivisions", "zipcodes", "highschools", "highschool_name",
    "elementary", "middle", "school_district", "market_area", "area",
    "lat", "lng", "property_type", "pool", "listing_type",
    "upload_session_id",
]
BATCH = 300


# ── normalizers (verbatim behaviour from engineCore.ts) ─────────────────────

def clean_number(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace(",", "").replace("$", "").strip()
    if not text or text.upper() in ("NA", "N/A", "NONE", "NULL", "-"):
        return 0.0
    m = re.search(r"-?\d+(?:\.\d+)?", text)
    if not m:
        return 0.0
    try:
        return float(m.group(0))
    except ValueError:
        return 0.0


def clean_date(raw: str) -> dict:
    """MM/DD/YYYY (HAR exports) and YYYY-MM-DD both accepted."""
    text = str(raw or "").strip()
    if not text:
        return {"date": "", "year": 0, "ts": 0}
    year = month = day = 0
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", text)
    if m:
        month, day, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        iso = f"{year:04d}-{month:02d}-{day:02d}"
    else:
        m2 = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", text)
        if m2:
            year, month, day = int(m2.group(1)), int(m2.group(2)), int(m2.group(3))
            iso = f"{year:04d}-{month:02d}-{day:02d}"
        else:
            return {"date": text, "year": 0, "ts": 0}
    try:
        dt = datetime(year, month, day, tzinfo=timezone.utc)
        return {"date": iso, "year": year, "ts": int(dt.timestamp() * 1000)}
    except ValueError:
        return {"date": iso, "year": year, "ts": 0}


def clean_bool(raw) -> bool:
    return str(raw or "").strip().lower() in ("yes", "true", "1", "y")


def district_code(raw) -> str:
    v = str(raw or "").strip()
    if not v or v.upper() in ("NA", "N/A"):
        return ""
    name = re.sub(r"^\d+\s*-\s*", "", v).strip()
    if not name:
        return ""
    if re.search(r"ISD$", name, re.I) or re.search(r"SCHOOL\s+DISTRICT$", name, re.I):
        return fd.clean_boundary_name(name)
    return fd.clean_boundary_name(name + " Independent School District")


def pick_first(row: dict, headers: list[str]) -> str:
    for h in headers:
        if row.get(h) not in (None, ""):
            return row[h]
    return ""


def detect_year(name: str, rows: list[dict]) -> int:
    # Filename: a 4-digit year between 1900 and 2099.
    years = [int(y) for y in re.findall(r"(?:^|\D)(19\d{2}|20\d{2})(?:\D|$)", name or "")]
    years = [y for y in years if 1900 <= y <= 2099]
    if years:
        now = datetime.now().year
        valid = [y for y in years if y <= now]
        return max(valid) if valid else years[-1]

    sample = rows[:20]
    for header in ("Close Year", "Year", "CloseDate", "Close Date", "List Year", "Sale Year"):
        vals = [clean_number(r.get(header)) for r in sample]
        vals = [int(v) for v in vals if 1900 <= v <= 2099]
        if vals:
            return round(sum(vals) / len(vals))

    for header in ("Close Date", "CloseDate", "List Date", "Sale Date", "Date"):
        found = []
        for r in sample:
            m = re.search(r"\b(19\d{2}|20\d{2})\b", str(r.get(header) or ""))
            if m:
                found.append(int(m.group(1)))
        if found:
            return round(sum(found) / len(found))
    return datetime.now().year


def parse_csv(content: bytes) -> tuple[list[str], list[dict]]:
    text = content.decode("utf-8-sig", errors="replace")
    sample = text[:8192]
    delimiter = "," if sample.count(",") >= sample.count(";") else ";"
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    headers = [h.strip() if isinstance(h, str) else h for h in (reader.fieldnames or [])]
    rows = []
    for raw in reader:
        row = {}
        for k, v in raw.items():
            if k is None:
                continue
            row[str(k).strip().replace("﻿", "")] = v
        rows.append(row)
    return headers, rows


# ── row mapping ─────────────────────────────────────────────────────────────

def map_rows(
    rows: list[dict],
    section: str,
    session_id: str,
    default_year: int,
    skips: dict[str, int] | None = None,
) -> list[dict]:
    rent = section in RENT_SECTIONS
    tax = section in TAX_SECTIONS
    # OWNER RULE (2026-10-27): each year and "Current" are separate buckets.
    # A row that cannot be dated belongs to the FILE's year (historical) —
    # never to year 0, which is reserved for the Current listings bucket.
    current = section in ("current-rent", "current-sales", "current-tax")
    listing = "rent" if rent else "tax" if tax else "sale"
    out = []

    def skip(reason: str) -> None:
        """Count why a CSV row never became a property row."""
        if skips is not None:
            skips[reason] = skips.get(reason, 0) + 1

    for row in rows:
        if tax:
            mls = str(pick_first(row, TAX_MLS_HEADERS) or "").strip()
            if not mls:
                skip("no MLS number")
                continue
            tax_rate = clean_number(pick_first(row, TAX_RATE_HEADERS))
            tax_year = clean_number(pick_first(row, TAX_YEAR_HEADERS))
            tax_amount = clean_number(pick_first(row, TAX_AMOUNT_HEADERS))
            assessed = clean_number(pick_first(row, TAX_ASSESSED_HEADERS))
            # The CoreLogic tax export carries no "Tax Rate": it is derived
            # from the assessed value, exactly like the old ETL did.
            if not tax_rate and assessed > 0 and tax_amount > 0:
                tax_rate = tax_amount * 100.0 / assessed
            if not tax_rate and not tax_year and not tax_amount:
                skip("no tax rate/year/amount")
                continue
            lat = clean_number(row.get("Latitude") or row.get("latitude"))
            lng = clean_number(row.get("Longitude") or row.get("longitude"))
            zip_raw = str(row.get("Postal Code") or row.get("Zip") or "").strip()
            out.append({
                "mls_number": mls,
                "dataset_year": 0 if current else (int(tax_year) if tax_year else default_year),
                "address": str(row.get("Address") or "").strip(),
                "city": str(row.get("City Name") or "").strip(),
                "zip": zip_raw,
                "zipcodes": zip_raw,
                "subdivisions": fd.clean_boundary_name(row.get("Subdivision")),
                "tax_rate": tax_rate or None,
                "tax_year": int(tax_year) if tax_year else None,
                "tax_amount": tax_amount or None,
                "lat": lat or None,
                "lng": lng or None,
                "listing_type": "tax",
                "upload_session_id": session_id,
            })
            continue

        close = clean_date(pick_first(row, LEASE_DATE_HEADERS) if rent else row.get("Close Date"))
        close_price = (clean_number(pick_first(row, RENT_PRICE_HEADERS)) if rent
                       else clean_number(row.get("Close Price") or row.get("Original List Price")))
        lat = clean_number(row.get("Latitude"))
        lng = clean_number(row.get("Longitude"))
        mls = str(row.get("MLS Number") or "").strip()
        if not mls:
            skip("no MLS number")
            continue
        if not close_price:
            skip("no Close/Lease price")
            continue
        if not lat or not lng:
            skip("no coordinates")
            continue

        sqft = clean_number(row.get("SF"))
        list_price = (clean_number(pick_first(row, LIST_RENT_HEADERS)) if rent
                      else clean_number(row.get("Original List Price")))
        ppsf = clean_number(row.get("Price Sq Ft Sold") or row.get("Prc/SF"))
        if not ppsf and sqft:
            ppsf = close_price / sqft

        # Historical files always stay in THEIR year bucket; only the Current
        # listings use year 0, so the two can never mix.
        year = 0 if current else (close["year"] or default_year)
        zip_raw = str(row.get("Zip") or "").strip()

        out.append({
            "mls_number": str(row.get("MLS Number") or "").strip(),
            "dataset_year": int(year),
            "address": str(row.get("Address") or "").strip(),
            "city": str(row.get("City/Location") or "").strip(),
            "state": str(row.get("State Or Province") or "").strip(),
            "zip": zip_raw,
            "close_price": int(close_price) if close_price else None,
            "list_price": int(list_price) if list_price else None,
            "price_per_sqft": ppsf or None,
            "sqft": int(sqft) if sqft else None,
            "lot_size": clean_number(row.get("Lot Size")) or None,
            "br": int(clean_number(row.get("BR"))) or None,
            "baths": int(clean_number(row.get("FB")) + clean_number(row.get("HB"))) or None,
            "year_built": int(clean_number(row.get("YB"))) or None,
            "dom": int(clean_number(row.get("DOM"))) or None,
            "cdom": int(clean_number(row.get("CDOM"))) or None,
            "close_date": close["date"],
            "close_year": close["year"] or year,
            "close_date_ts": close["ts"] or (int(datetime(year, 6, 15, tzinfo=timezone.utc).timestamp() * 1000) if year else None),
            "maint_fee": clean_number(row.get("Maint Fee Amt")) or None,
            "maint_fee_schedule": str(row.get("Maint Fee Pay Schedule") or "").strip().lower(),
            "tax_rate": clean_number(row.get("Tax Rate")) or None,
            "tax_year": int(clean_number(row.get("Tax Year"))) or None,
            "tax_amount": clean_number(row.get("Tax Amount")) or None,
            "subdivisions": fd.clean_boundary_name(row.get("Subdivision")),
            "zipcodes": zip_raw,
            "highschools": district_code(row.get("School District")),
            "highschool_name": fd.clean_school_name(row.get("School High")),
            "elementary": fd.clean_school_name(row.get("School Elementary")),
            "middle": fd.clean_school_name(row.get("School Middle")),
            "school_district": str(row.get("School District") or "").strip(),
            "market_area": str(row.get("Market Area") or "").strip(),
            "area": str(row.get("Area") or "").strip(),
            "lat": lat,
            "lng": lng,
            "property_type": str(row.get("Property Type") or "").strip(),
            "pool": clean_bool(row.get("Pool Private")),
            "listing_type": listing,
            "upload_session_id": session_id,
        })
    return out


# ── SQL staging ─────────────────────────────────────────────────────────────

def _row_key(row: dict) -> tuple[str, int]:
    """The table's primary key identity: MLS number + dataset year."""
    return (str(row.get("mls_number") or "").strip(), int(row.get("dataset_year") or 0))


def committed_keys(rows: list[dict]) -> set[tuple[str, int]]:
    """Which of these (MLS, year) pairs are already COMMITTED (visible on the map).

    Used by the upload report to tell "New" rows apart from rows that already
    exist in the database and are being refreshed in place. Pending rows from
    another session are ignored on purpose — only what the map can see counts.
    """
    keys = {k for k in (_row_key(r) for r in rows) if k[0]}
    if not keys:
        return set()
    mls = sorted({m for m, _ in keys})
    found: set[tuple[str, int]] = set()
    chunk_size = 1000
    for i in range(0, len(mls), chunk_size):
        chunk = mls[i : i + chunk_size]
        sql = (
            "SELECT mls_number, dataset_year FROM properties "
            "WHERE upload_session_id IS NULL AND mls_number IN ("
            + ",".join(fd.sql_literal(m) for m in chunk)
            + ")"
        )
        for r in fd.sql_rows(sql, use_cache=False):
            found.add((str(r.get("mls_number") or "").strip(), int(r.get("dataset_year") or 0)))
    return found & keys


def _insert_batch(rows: list[dict], columns: list[str]) -> None:
    cols = ", ".join(columns + ["updated_at"])
    updates = ", ".join(
        f"{c} = EXCLUDED.{c}" for c in columns
        if c not in ("mls_number", "dataset_year")
    )
    tuples = []
    for r in rows:
        vals = []
        for c in columns:
            if c == "pool":
                vals.append("TRUE" if r.get(c) else "FALSE")
            else:
                vals.append(fd.sql_literal(r.get(c)))
        vals.append("now()")
        tuples.append("(" + ", ".join(vals) + ")")
    sql = (
        f"INSERT INTO properties ({cols}) VALUES {', '.join(tuples)} "
        f"ON CONFLICT (mls_number, dataset_year) DO UPDATE SET {updates}, updated_at = now()"
    )
    fd.sql_exec(sql)


# One-sentence explanation of what an upload changes on the map — shown in
# the post-upload report (same wording the old CMS used).
EFFECT_BY_SECTION = {
    "sales": "Sold-property records for {year}, keyed by MLS number + year. Re-uploading updates the same rows instead of duplicating them.",
    "rent": "Rental records for {year}, keyed by MLS number + year. Re-uploading is safe — existing rows are updated in place.",
    "current-sales": "Active for-sale listings, keyed by MLS number + year. Independent from the historical Sales bucket.",
    "current-rent": "Active for-rent listings, keyed by MLS number + year. Independent from the historical Rent bucket.",
    "current-tax": "Current tax values attached by MLS number; re-uploading refreshes them in place.",
    "tax": "Tax records: rate/amount/year attached to the rows that share the same MLS number.",
    "schools": "School ratings from the CSV, used by the school filters and report cards.",
}
DEFAULT_EFFECT = "Rows are keyed by MLS number + year; re-uploading updates them in place."


def _effect_for(section: str, year: int) -> str:
    template = EFFECT_BY_SECTION.get(section, DEFAULT_EFFECT)
    return template.format(year=year) if "{year}" in template else template


def stage_import(section: str, filename: str, content: bytes) -> dict:
    headers, rows = parse_csv(content)
    if not rows:
        return {"ok": False, "error": "The file has no data rows.", "file": filename, "section": section}

    default_year = detect_year(filename, rows)
    session_id = f"sess-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    skips: dict[str, int] = {}
    mapped = map_rows(rows, section, session_id, default_year, skips)
    # "What did this upload actually change?" — split the rows into NEW vs
    # already in the database (re-uploaded → refreshed in place) and call out
    # duplicate (MLS, year) pairs inside the file, exactly like new kwizi's
    # post-upload report. Must run BEFORE the insert: only committed rows
    # count as "already in the database".
    existing = committed_keys(mapped)
    key_counts = Counter(_row_key(r) for r in mapped)
    duplicate_rows = sum(n - 1 for n in key_counts.values() if n > 1)
    updated_rows = sum(1 for r in mapped if _row_key(r) in existing)
    new_rows = len(mapped) - updated_rows

    zip_new_counts: Counter = Counter()
    zip_updated_counts: Counter = Counter()
    for r in mapped:
        z = str(r.get("zipcodes") or "").strip()
        if not z:
            continue
        (zip_updated_counts if _row_key(r) in existing else zip_new_counts)[z] += 1

    zip_counts = zip_new_counts + zip_updated_counts
    top_zips = [{"name": name, "count": n} for name, n in zip_counts.most_common(40)]
    zips_added = [{"name": name, "count": n} for name, n in zip_new_counts.most_common(40)]
    zips_updated = [{"name": name, "count": n} for name, n in zip_updated_counts.most_common(40)]
    effect = _effect_for(section, default_year)
    if not mapped:
        return {
            "ok": False,
            "error": "No row could be imported.",
            "file": filename,
            "section": section,
            "year": default_year,
            "parsed": len(rows),
            "imported": 0,
            "skipped": len(rows),
            "skipReasons": skips,
            "zips": [],
            "zipsAdded": [],
            "zipsUpdated": [],
            "newRows": 0,
            "updatedRows": 0,
            "duplicateRows": 0,
            "effect": effect,
            "headers": headers,
            "detail": "Check the required columns (MLS Number, Close Price, Latitude, Longitude).",
        }

    # Keep only the columns this file actually fills, so the upsert never
    # erases a value another file type wrote (tax columns vs sale columns).
    core = ["mls_number", "dataset_year", "upload_session_id", "listing_type"]
    if section in TAX_SECTIONS:
        allowed = core + [
            c for c in ("tax_rate", "tax_year", "tax_amount",
                        "lat", "lng", "address", "city", "zip", "zipcodes", "subdivisions")
            if any(r.get(c) is not None for r in mapped)
        ]
    else:
        allowed = core + ["pool"] + [
            c for c in INSERT_COLUMNS
            if c not in core + ["pool"] and any(r.get(c) is not None for r in mapped)
        ]

    for i in range(0, len(mapped), BATCH):
        _insert_batch(mapped[i : i + BATCH], allowed)

    # Store the raw file + register it like the main CMS.
    category = SECTION_CATEGORY.get(section, section)
    gz = gzip.compress(content)
    object_path = f"cms_files/{category}/{filename}"
    _upload_object(object_path, gz, "application/gzip")
    url = _set_download_token(object_path)
    months = sorted({
        datetime.fromtimestamp(int(r["close_date_ts"]) / 1000, tz=timezone.utc).month
        for r in mapped if r.get("close_date_ts")
    })
    _write_firestore_file({
        "id": f"{category}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}",
        "name": filename,
        "size": len(gz),
        "uploadedAt": int(time.time() * 1000),
        "storageUrl": url,
        "storagePath": object_path,
        "year": default_year,
        "months": months,
    }, category=category)

    return {
        "ok": True,
        "sessionId": session_id,
        "section": section,
        "category": category,
        "file": filename,
        "year": default_year,
        "parsed": len(rows),
        "imported": len(mapped),
        "skipped": len(rows) - len(mapped),
        "skipReasons": skips,
        "zips": top_zips,
        "zipsAdded": zips_added,
        "zipsUpdated": zips_updated,
        "newRows": new_rows,
        "updatedRows": updated_rows,
        "duplicateRows": duplicate_rows,
        "effect": effect,
        "headers": headers,
    }


def commit_session(session_id: str) -> int:
    return fd.sql_exec(
        "UPDATE properties SET upload_session_id = NULL "
        f"WHERE upload_session_id = {fd.sql_literal(session_id)}"
    )


def discard_session(session_id: str) -> int:
    return fd.sql_exec(
        f"DELETE FROM properties WHERE upload_session_id = {fd.sql_literal(session_id)}"
    )


def commit_all() -> int:
    """Emergency tool: publish every staged row."""
    return fd.sql_exec(
        "UPDATE properties SET upload_session_id = NULL WHERE upload_session_id IS NOT NULL"
    )


def discard_all() -> int:
    """Emergency tool: delete every staged row."""
    return fd.sql_exec(
        "DELETE FROM properties WHERE upload_session_id IS NOT NULL"
    )


def pending_sessions() -> list[dict]:
    return [
        {"sessionId": r["sid"], "rows": int(r["n"] or 0)}
        for r in fd.sql_rows(
            "SELECT upload_session_id AS sid, count(*)::int AS n FROM properties "
            "WHERE upload_session_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC"
        )
    ]
