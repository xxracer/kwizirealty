"""
admin.py — the RESDOGS CMS backend.

Same project, same rules as `new kwizi`: a Google account signs in with the
Firebase JS SDK, the server verifies the ID token and checks the email against
`NEXT_PUBLIC_CMS_ALLOWED_EMAILS`.

Capabilities:
  - dataset status (committed / pending rows, per year)
  - polygon-assignment coverage per boundary class
  - the uploaded-files inventory (Firestore `cms_files`)
  - replace a boundary file (GeoJSON -> gzip -> Storage -> Firestore)
  - run the polygon assignment in resumable chunks
"""

import gzip
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from fastapi import HTTPException

import engine
import firebase_data as fd

BOUNDARY_LABEL = {
    "subdivisions": "Subdivisions / Neighborhoods",
    "zipcodes": "Zip Codes",
    "highschools": "School Districts",
    "elementary": "Elementary",
    "middle": "Middle Schools",
}

# The file name the map looks for, per class (same as new kwizi).
BOUNDARY_FILE_NAME = {
    "subdivisions": "Mapped Subdivisions.geojson",
    "zipcodes": "Zip.geojson",
    "highschools": "Houston_ISD.geojson",
    "elementary": "Elementary School ISD.geojson",
    "middle": "Middle School ISD.geojson",
}

TEXT_COLUMN = {
    "subdivisions": "subdivisions", "zipcodes": "zipcodes",
    "highschools": "highschools", "elementary": "elementary", "middle": "middle",
}

POLY_COLUMN = {
    "subdivisions": "poly_id_subdivisions",
    "zipcodes": "poly_id_zipcodes",
    "highschools": "poly_id_highschools",
    "elementary": "poly_id_elementary",
    "middle": "poly_id_middle",
}


# ── auth ─────────────────────────────────────────────────────────────────────

def _allowed_emails() -> set[str]:
    raw = fd._env("NEXT_PUBLIC_CMS_ALLOWED_EMAILS") or ""
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def verify_admin(authorization: str | None) -> str:
    """Verify a Firebase ID token and return the admin's email."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign in required")
    token = authorization.split(" ", 1)[1].strip()
    try:
        from google.oauth2 import id_token

        info = id_token.verify_firebase_token(
            token, fd._UrllibTransport(), audience=fd.PROJECT,
            clock_skew_in_seconds=120,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"Invalid session: {exc}") from None

    email = (info.get("email") or "").lower()
    if not info.get("email_verified"):
        raise HTTPException(status_code=403, detail="Email not verified")
    allowed = _allowed_emails()
    if not allowed:
        raise HTTPException(
            status_code=403,
            detail="No admin allowlist configured (NEXT_PUBLIC_CMS_ALLOWED_EMAILS)",
        )
    if email not in allowed:
        raise HTTPException(status_code=403, detail="This account is not an admin")
    return email


def public_firebase_config() -> dict:
    return {
        "apiKey": fd._env("NEXT_PUBLIC_FIREBASE_API_KEY"),
        "authDomain": fd._env("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
        "projectId": fd.PROJECT,
        "appId": fd._env("NEXT_PUBLIC_FIREBASE_APP_ID"),
        "allowedEmails": sorted(_allowed_emails()),
    }


# ── status ───────────────────────────────────────────────────────────────────

def dataset_status() -> dict:
    rows = fd.sql_rows(
        "SELECT dataset_year AS yr, count(*)::int AS n, "
        "count(*) FILTER (WHERE upload_session_id IS NULL)::int AS committed, "
        "count(*) FILTER (WHERE upload_session_id IS NOT NULL)::int AS pending "
        "FROM properties GROUP BY 1 ORDER BY 1"
    )
    by_year = [
        {
            "year": int(r.get("yr") or 0),
            "rows": int(r.get("n") or 0),
            "committed": int(r.get("committed") or 0),
            "pending": int(r.get("pending") or 0),
        }
        for r in rows
    ]
    total = sum(r["rows"] for r in by_year)
    committed = sum(r["committed"] for r in by_year)

    coverage = []
    for cls, col in POLY_COLUMN.items():
        try:
            c = fd.sql_rows(
                f"SELECT count(*) FILTER (WHERE {col} <> '')::int AS assigned, "
                f"count(*) FILTER (WHERE lat IS NOT NULL AND lat <> 0)::int AS with_coords "
                "FROM properties WHERE upload_session_id IS NULL"
            )[0]
            coverage.append({
                "class": cls,
                "label": BOUNDARY_LABEL[cls],
                "assigned": int(c.get("assigned") or 0),
                "withCoords": int(c.get("with_coords") or 0),
            })
        except Exception:  # noqa: BLE001
            coverage.append({
                "class": cls, "label": BOUNDARY_LABEL[cls],
                "assigned": 0, "withCoords": 0,
            })

    try:
        files = fd._fs_list("cms_files")
    except Exception:  # noqa: BLE001
        files = []
    by_category: dict[str, int] = {}
    for f in files:
        cat = f.get("category") or "unknown"
        by_category[cat] = by_category.get(cat, 0) + 1

    # Area Metrics counts every GeoJSON the CMS can show, including the
    # Storage-only files whose Firestore record was lost.
    boundary_rows = _add_orphan_boundaries([
        {
            "id": f.get("_id"),
            "name": f.get("name"),
            "category": "boundary",
            "size": f.get("size"),
            "uploadedAt": f.get("uploadedAt"),
            "storagePath": f.get("storagePath"),
            "storageUrl": f.get("storageUrl"),
            "rowCount": f.get("rowCount"),
            "year": _record_year(f),
        }
        for f in files
        if (f.get("category") or "") == "boundary"
    ])
    if boundary_rows:
        by_category["boundary"] = len(boundary_rows)
    boundaries = [
        {
            "id": r.get("id"),
            "name": r.get("name"),
            "size": r.get("size"),
            "uploadedAt": r.get("uploadedAt"),
            "storagePath": r.get("storagePath"),
            "storageUrl": r.get("storageUrl"),
            "year": r.get("year"),
        }
        for r in boundary_rows[:20]
    ]

    return {
        "total": total,
        "committed": committed,
        "pending": total - committed,
        "byYear": by_year,
        "coverage": coverage,
        "filesByCategory": by_category,
        "boundaryFiles": boundaries[:20],
        "polyColumnsReady": engine.poly_columns_ready(),
    }


# ── boundary upload ─────────────────────────────────────────────────────────

def _storage_bucket() -> str:
    return fd._env("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET") or f"{fd.PROJECT}.firebasestorage.app"


def _upload_object(object_path: str, body: bytes, content_type: str) -> None:
    bucket = _storage_bucket()
    url = (
        "https://storage.googleapis.com/upload/storage/v1/b/"
        + urllib.parse.quote(bucket, safe="")
        + "/o?uploadType=media&name="
        + urllib.parse.quote(object_path, safe="")
    )
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {fd.token()}",
            "Content-Type": content_type,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        r.read()


def _set_download_token(object_path: str) -> str:
    """Give the object a Firebase download token and return its public URL."""
    bucket = _storage_bucket()
    token = str(uuid.uuid4())
    url = (
        "https://storage.googleapis.com/storage/v1/b/"
        + urllib.parse.quote(bucket, safe="")
        + "/o/"
        + urllib.parse.quote(object_path, safe="")
    )
    body = json.dumps({"metadata": {"firebaseStorageDownloadTokens": token}}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Authorization": f"Bearer {fd.token()}", "Content-Type": "application/json"},
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        r.read()
    return (
        f"https://firebasestorage.googleapis.com/v0/b/{bucket}/o/"
        f"{urllib.parse.quote(object_path, safe='')}?alt=media&token={token}"
    )


def _write_firestore_file(record: dict, category: str = "boundary") -> None:
    url = (
        f"https://firestore.googleapis.com/v1/projects/{fd.PROJECT}"
        f"/databases/(default)/documents/cms_files?documentId={record['id']}"
    )
    fields = {
        "name": {"stringValue": record["name"]},
        "size": {"integerValue": str(record["size"])},
        "category": {"stringValue": category},
        "uploadedAt": {"integerValue": str(record["uploadedAt"])},
        "source": {"stringValue": "upload"},
        "storageUrl": {"stringValue": record["storageUrl"]},
        "storagePath": {"stringValue": record["storagePath"]},
        "rowCount": {"integerValue": "0"},
        "headers": {"arrayValue": {"values": []}},
        "rows": {"arrayValue": {"values": []}},
    }
    # The CMS groups uploads by dataset year; keep it on the record so future
    # uploads land in the right folder without re-reading the file.
    if record.get("year") is not None:
        try:
            fields["year"] = {"integerValue": str(int(record["year"]))}
        except (TypeError, ValueError):
            pass
    body = json.dumps({"fields": fields}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Authorization": f"Bearer {fd.token()}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        r.read()


def upload_boundary(cls: str, filename: str, content: bytes) -> dict:
    if cls not in BOUNDARY_FILE_NAME:
        raise HTTPException(status_code=400, detail="Unknown boundary class")

    # Validate before touching Storage.
    try:
        parsed = json.loads(content.decode("utf-8"))
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="The file is not valid JSON") from None
    if parsed.get("type") != "FeatureCollection" or not isinstance(parsed.get("features"), list):
        raise HTTPException(
            status_code=400, detail="Expected a GeoJSON FeatureCollection"
        )
    if not parsed["features"]:
        raise HTTPException(status_code=400, detail="The boundary file has 0 areas")

    gz = gzip.compress(content)
    object_path = f"cms_files/boundaries/{filename}"
    _upload_object(object_path, gz, "application/gzip")
    storage_url = _set_download_token(object_path)

    record = {
        "id": f"boundary-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}",
        "name": filename,
        "size": len(gz),
        "uploadedAt": int(time.time() * 1000),
        "storageUrl": storage_url,
        "storagePath": object_path,
    }
    _write_firestore_file(record)

    # The map must see the new geometry on the next request.
    with engine._geom_lock:
        engine._geom_cache.pop(cls, None)
        engine._geojson_cache.pop(cls, None)
    engine._index_cache.pop(cls, None)

    return {
        "ok": True,
        "class": cls,
        "name": filename,
        "features": len(parsed["features"]),
        "bytes": len(gz),
        "storageUrl": storage_url,
    }


# ── files / collections ─────────────────────────────────────────────────────

def _download_object(url: str) -> bytes:
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "resdogs-cms"})
    with urllib.request.urlopen(req, timeout=180) as r:
        buf = r.read()
    if buf[:2] == b"\x1f\x8b":
        buf = gzip.decompress(buf)
    return buf


def file_preview(doc_id: str, limit: int = 500) -> dict:
    """The Eye: the first rows of an uploaded CSV (or GeoJSON stats).

    The file is read from Storage; if the object no longer exists the answer
    says so instead of failing.
    """
    import csv as _csv
    import io as _io

    rec = _resolve_file(doc_id)
    if not rec:
        raise HTTPException(status_code=404, detail="File record not found")
    name = rec.get("name") or ""
    if not rec.get("storageUrl") and not rec.get("storagePath"):
        return {"ok": False, "error": "This record has no Storage file."}

    try:
        body = _read_record_bytes(rec)
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "name": name,
            "error": "The original file is no longer in Storage. Its rows may still be in the database.",
            "detail": str(exc)[:200],
        }

    text = body.decode("utf-8-sig", errors="replace")

    if name.lower().endswith((".geojson", ".json")):
        try:
            data = json.loads(text)
        except Exception:  # noqa: BLE001
            return {"ok": False, "name": name, "error": "The file is not valid JSON."}
        feats = data.get("features") or []
        types = sorted({(f.get("geometry") or {}).get("type") or "null" for f in feats})
        return {
            "ok": True,
            "name": name,
            "kind": "geojson",
            "features": len(feats),
            "geometryTypes": ", ".join(types),
            "sample": [
                {"name": (f.get("properties") or {}).get("Name")
                 or (f.get("properties") or {}).get("NAME")
                 or ""}
                for f in feats[:limit]
            ],
        }

    sample = text[:8192]
    delimiter = "," if sample.count(",") >= sample.count(";") else ";"
    reader = _csv.DictReader(_io.StringIO(text), delimiter=delimiter)
    headers = [h.strip() if isinstance(h, str) else h for h in (reader.fieldnames or [])]
    rows = []
    total = 0
    for raw in reader:
        total += 1
        if len(rows) < limit:
            rows.append({str(k).strip(): ("" if v is None else str(v)) for k, v in raw.items() if k is not None})
    return {
        "ok": True,
        "name": name,
        "kind": "csv",
        "headers": headers,
        "rows": rows,
        "total": total,
        "shown": len(rows),
    }


_YEAR_IN_NAME = re.compile(r"(?:^|\D)(19\d{2}|20\d{2})(?:\D|$)")


def _record_year(rec: dict) -> int | None:
    """The dataset year of an uploaded file (same grouping the old CMS used).

    Older records already carry `year`; files uploaded through this Python CMS
    do not, so the year is recovered from the file name — exactly like the
    browser importer's detect_year().
    """
    raw = rec.get("year")
    try:
        if raw not in (None, ""):
            return int(raw)
    except (TypeError, ValueError):
        pass
    name = rec.get("name") or ""
    years = [int(y) for y in _YEAR_IN_NAME.findall(name) if 1900 <= int(y) <= 2099]
    return max(years) if years else None


def file_bytes(doc_id: str) -> tuple[bytes, str]:
    """The original (decompressed) bytes behind a CMS record — used by Download.

    Files uploaded through this Python CMS are stored gzipped, so the browser
    must never open the Storage URL directly: it would save a .gz with a .csv
    name. This returns the plain file the owner uploaded.
    """
    rec = _resolve_file(doc_id)
    if not rec:
        raise HTTPException(status_code=404, detail="File record not found")
    return _read_record_bytes(rec), rec.get("name") or "download"


CURRENT_LISTING_CATEGORIES = {"current-sale", "current-rent", "current-tax", "property"}


def _storage_objects(prefix: str = "cms_files/") -> list[dict]:
    """Every object under a Storage prefix (paginated)."""
    bucket = _storage_bucket()
    base = (
        "https://storage.googleapis.com/storage/v1/b/"
        f"{urllib.parse.quote(bucket, safe='')}/o"
    )
    items: list[dict] = []
    page: str | None = None
    while True:
        query = {"prefix": prefix, "maxResults": "1000"}
        if page:
            query["pageToken"] = page
        req = urllib.request.Request(
            base + "?" + urllib.parse.urlencode(query),
            headers={"Authorization": f"Bearer {fd.token()}"},
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())
        items.extend(data.get("items") or [])
        page = data.get("nextPageToken")
        if not page:
            break
    return items


def _iso_ms(value: str | None) -> int:
    if not value:
        return 0
    try:
        from datetime import datetime

        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def _add_orphan_boundaries(rows: list[dict]) -> list[dict]:
    """GeoJSON files that exist in Storage but lost their Firestore record.

    The old app left several boundary files in `cms_files/` whose cms_files
    document was never copied to this project, so the CMS showed only one of
    them. The map still needs those files, and the owner must be able to see
    them (Eye / Download / Delete), so they are surfaced from Storage.
    """
    known_names = {r.get("name") for r in rows}
    known_paths = {r.get("storagePath") for r in rows}
    try:
        objects = _storage_objects("cms_files/")
    except Exception as exc:  # noqa: BLE001 - the Firestore list still works
        print(f"[admin] storage listing failed: {exc}")
        return rows
    extra: list[dict] = []
    for obj in objects:
        path = obj.get("name") or ""
        base = path.split("/")[-1]
        if not base.lower().endswith((".geojson", ".json")):
            continue
        # Only real boundary files: `cms_files/<file>` or the uploads folder.
        # Skip caches/metadata under cms_files/csv/ and cms_files/sql_imports/.
        if path.count("/") != 1 and not path.startswith("cms_files/boundaries/"):
            continue
        if base in known_names or path in known_paths:
            continue
        extra.append({
            "id": f"storage::{path}",
            "name": base,
            "category": "boundary",
            "size": int(obj.get("size") or 0),
            "uploadedAt": _iso_ms(obj.get("updated")),
            "storagePath": path,
            "storageUrl": None,
            "rowCount": None,
            "year": None,
        })
    return sorted(rows + extra, key=lambda r: -(float(r.get("uploadedAt") or 0)))


def list_files(category: str | None = None) -> list[dict]:
    files = fd._fs_list("cms_files")
    if category:
        cats = {category}
        # "Current Listings" is one page in the CMS but three upload buckets.
        if category == "current":
            cats = CURRENT_LISTING_CATEGORIES
        files = [f for f in files if (f.get("category") or "") in cats]
    files.sort(key=lambda f: -(float(f.get("uploadedAt") or 0)))
    rows = [
        {
            "id": f.get("_id"),
            "name": f.get("name"),
            "category": f.get("category"),
            "size": f.get("size"),
            "uploadedAt": f.get("uploadedAt"),
            "storagePath": f.get("storagePath"),
            "storageUrl": f.get("storageUrl"),
            "rowCount": f.get("rowCount"),
            "year": _record_year(f),
        }
        for f in files
    ]
    if category in ("boundary", "areas"):
        rows = _add_orphan_boundaries(rows)
    return rows


def _resolve_file(doc_id: str) -> dict | None:
    """A CMS file record, or a Storage-only object (`storage::<path>`)."""
    if doc_id.startswith("storage::"):
        path = doc_id[len("storage::"):]
        if not path:
            return None
        return {"_id": doc_id, "name": path.split("/")[-1], "storagePath": path}
    files = fd._fs_list("cms_files")
    return next((f for f in files if f.get("_id") == doc_id), None)


def _read_object(object_path: str) -> bytes:
    """Read a Storage object with the service account (no signed URL needed)."""
    bucket = _storage_bucket()
    url = (
        "https://storage.googleapis.com/storage/v1/b/"
        f"{urllib.parse.quote(bucket, safe='')}/o/"
        f"{urllib.parse.quote(object_path, safe='')}?alt=media"
    )
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {fd.token()}"}
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        buf = r.read()
    if buf[:2] == b"\x1f\x8b":
        buf = gzip.decompress(buf)
    return buf


def _read_record_bytes(rec: dict) -> bytes:
    """Read a CMS record's file, preferring the Storage path (service auth).

    Some migrated records carry a signed URL whose token has expired; the
    object itself is still there and readable with the service account.
    """
    path = rec.get("storagePath")
    url = rec.get("storageUrl")
    if path:
        try:
            return _read_object(path)
        except Exception:  # noqa: BLE001 - fall back to the signed URL
            if not url:
                raise
    if url:
        return _download_object(url)
    raise HTTPException(status_code=404, detail="This record has no Storage file")


def delete_file(doc_id: str, storage_path: str | None = None) -> dict:
    # A Storage-only object (orphan boundary file) has no Firestore document.
    if doc_id.startswith("storage::"):
        storage_path = doc_id[len("storage::"):]
        doc_id = ""
    if not doc_id and not storage_path:
        raise HTTPException(status_code=400, detail="Missing file id")
    if doc_id:
        url = (
            f"https://firestore.googleapis.com/v1/projects/{fd.PROJECT}"
            f"/databases/(default)/documents/cms_files/{urllib.parse.quote(doc_id, safe='')}"
        )
        req = urllib.request.Request(
            url, headers={"Authorization": f"Bearer {fd.token()}"}, method="DELETE"
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()

    if storage_path:
        bucket = _storage_bucket()
        obj_url = (
            "https://storage.googleapis.com/storage/v1/b/"
            + urllib.parse.quote(bucket, safe="")
            + "/o/"
            + urllib.parse.quote(storage_path, safe="")
        )
        try:
            req2 = urllib.request.Request(
                obj_url, headers={"Authorization": f"Bearer {fd.token()}"}, method="DELETE"
            )
            with urllib.request.urlopen(req2, timeout=60) as r2:
                r2.read()
        except Exception:  # noqa: BLE001 - the metadata record is already gone
            pass
    return {"ok": True, "id": doc_id or storage_path}


# ── "Delete All Data" (files + the SQL rows they created) ──────────────────
# Same behaviour as the old CMS: deleting a section's files must also delete
# the rows already upserted into Postgres, otherwise the map keeps showing
# them forever. Scope matches db_stats() so one section never takes another.
SECTION_FILE_CATEGORIES = {
    "sales": ["sales"],
    "rent": ["rent"],
    "current": sorted(CURRENT_LISTING_CATEGORIES),
    "current-sales": ["current-sale"],
    "current-rent": ["current-rent"],
    "current-tax": ["current-tax"],
    "tax": ["tax"],
    "schools": ["school"],
    "areas": ["boundary"],
}

TYPE_CONDITION = {
    # NULL and '' both mean "sale" in the mapper / the old engine.
    "sale": "coalesce(nullif(listing_type,''),'sale') = 'sale'",
    "rent": "listing_type = 'rent'",
    "tax": "listing_type = 'tax'",
}

SECTION_SQL_SCOPE = {
    # OWNER RULE (2026-10-25): "Delete Sales Data" wipes the WHOLE sales
    # bucket — historical rows AND active/undated listings — so the section can
    # be re-uploaded clean. Rent and tax buckets are never touched from here.
    "sales": (["sale"], "any"),
    "rent": (["rent"], "dated"),
    # Same scope as the old CMS: Current Listings wipes active sale + rent
    # rows. Tax rows are shared with the Tax Records section, so they are
    # never deleted from here.
    "current": (["sale", "rent"], "undated"),
    "current-sales": (["sale"], "undated"),
    "current-rent": (["rent"], "undated"),
    "current-tax": (["tax"], "any"),
    "tax": (["tax"], "any"),
}


def _delete_rows_for(section: str) -> int:
    scope = SECTION_SQL_SCOPE.get(section)
    if not scope:
        return 0  # schools / boundaries only have files, not property rows
    types, date_mode = scope
    cond = "(" + " OR ".join(TYPE_CONDITION[t] for t in types) + ")"
    if date_mode == "dated":
        cond += " AND close_date IS NOT NULL AND close_date <> ''"
    elif date_mode == "undated":
        cond += " AND (close_date IS NULL OR close_date = '')"
    return fd.sql_exec(f"DELETE FROM properties WHERE {cond}")


def clear_section(section: str) -> dict:
    """Delete every file of a CMS section and the rows those files created."""
    cats = SECTION_FILE_CATEGORIES.get(section)
    if cats is None:
        raise HTTPException(status_code=400, detail="Unknown section")
    # list_files() (not _fs_list) so Storage-only boundary files are included.
    seen: set[str] = set()
    doomed: list[dict] = []
    for cat in cats:
        for row in list_files(cat):
            rid = row.get("id")
            if rid and rid not in seen:
                seen.add(rid)
                doomed.append(row)
    deleted_files = 0
    for row in doomed:
        try:
            delete_file(row.get("id") or "", row.get("storagePath"))
            deleted_files += 1
        except Exception:  # noqa: BLE001 - keep deleting the rest
            pass
    deleted_rows = _delete_rows_for(section)
    return {
        "ok": True,
        "section": section,
        "files": deleted_files,
        "rows": deleted_rows,
    }


def list_collection(name: str) -> list[dict]:
    try:
        docs = fd._fs_list(name)
    except Exception:  # noqa: BLE001
        return []
    return docs[:50]


# ── resumable polygon assignment ─────────────────────────────────────────────

def assign_chunk(cls: str, after: dict | None, limit: int = 15000) -> dict:
    """Assign one page of rows for one boundary class.

    Keyset pagination on (mls_number, dataset_year); the client loops until
    `next` is null. Keeps every request inside Vercel's time budget.
    """
    col = POLY_COLUMN.get(cls)
    if not col:
        raise HTTPException(status_code=400, detail="Unknown boundary class")

    tree, geoms, names, fids, bases = engine._get_index(cls)
    if tree is None:
        return {"assigned": 0, "next": None, "done": True, "error": "No geometry"}

    where = [
        "upload_session_id IS NULL",
        f"{col} IS NULL",
        "lat IS NOT NULL", "lng IS NOT NULL", "lat <> 0", "lng <> 0",
    ]
    if after:
        m = fd.sql_literal(after.get("m") or "")
        y = int(after.get("y") or 0)
        where.append(
            f"(mls_number > {m} OR (mls_number = {m} AND dataset_year > {y}))"
        )
    text_col = TEXT_COLUMN.get(cls, "subdivisions")
    sql = (
        f"SELECT mls_number, dataset_year, lat, lng, {text_col} AS row_text FROM properties WHERE "
        + " AND ".join(where)
        + f" ORDER BY mls_number, dataset_year LIMIT {int(limit)}"
    )
    rows = fd.sql_rows(sql)
    if not rows:
        return {"assigned": 0, "next": None, "done": True, "remaining": 0}

    from shapely.geometry import Point

    values = []
    for row in rows:
        try:
            pt = Point(float(row["lng"]), float(row["lat"]))
        except (TypeError, ValueError):
            pt = None
        assigned = ""
        if pt is not None:
            hits = [k for k in tree.query(pt) if geoms[k].intersects(pt)]
            if hits:
                assigned = names[min(hits, key=lambda k: geoms[k].area)]
            else:
                key = fd.clean_boundary_name(row.get("row_text"))
                cands = [i for i, b in enumerate(bases) if b == key] if key else []
                if len(cands) == 1:
                    assigned = names[cands[0]]
                elif cands:
                    best = min(cands, key=lambda k: (
                        (geoms[k].centroid.x - pt.x) ** 2 + (geoms[k].centroid.y - pt.y) ** 2
                    ))
                    assigned = names[best]
                elif len(geoms):
                    near = tree.nearest(pt)
                    if geoms[near].distance(pt) * 111.0 <= 0.55:
                        assigned = names[near]
        values.append(
            "("
            + ", ".join([
                fd.sql_literal(row["mls_number"]),
                str(int(row["dataset_year"])),
                fd.sql_literal(assigned),
            ])
            + ")"
        )

    fd.sql_exec(
        f"UPDATE properties AS p SET {col} = v.poly "
        f"FROM (VALUES {', '.join(values)}) AS v(mls_number, dataset_year, poly) "
        "WHERE p.mls_number = v.mls_number AND p.dataset_year = v.dataset_year"
    )

    last = rows[-1]
    return {
        "assigned": len(rows),
        "next": {"m": last["mls_number"], "y": int(last["dataset_year"])},
        "done": len(rows) < limit,
    }


def db_stats(section: str) -> dict:
    """Rows already imported for a CMS section, by dataset year.

    The original CSV files may no longer be in Storage (a re-upload rehearsal
    deletes them), but their rows stay in Postgres — this is what the CMS
    shows so the owner can see the data is loaded.
    """
    if section in ("rent", "current-rent"):
        cond = "listing_type = 'rent'"
    elif section in ("tax", "current-tax"):
        cond = "listing_type = 'tax'"
    elif section == "current-sales":
        cond = "coalesce(listing_type,'sale') NOT IN ('rent','tax') AND (close_date IS NULL OR close_date = '')"
    elif section == "current":
        cond = "close_date IS NULL OR close_date = ''"
    else:
        cond = "coalesce(listing_type,'sale') NOT IN ('rent','tax') AND close_date IS NOT NULL AND close_date <> ''"

    rows = fd.sql_rows(
        "SELECT dataset_year AS yr, count(*)::int AS n FROM properties "
        f"WHERE upload_session_id IS NULL AND ({cond}) GROUP BY 1 ORDER BY 1"
    )
    by_year = [
        {"year": int(r.get("yr") or 0), "rows": int(r.get("n") or 0)}
        for r in rows
    ]
    return {"section": section, "total": sum(y["rows"] for y in by_year), "byYear": by_year}


def coverage_for(cls: str) -> dict:
    col = POLY_COLUMN.get(cls)
    r = fd.sql_rows(
        f"SELECT count(*) FILTER (WHERE {col} IS NULL AND lat IS NOT NULL AND lat <> 0)::int AS missing, "
        f"count(*) FILTER (WHERE {col} <> '')::int AS assigned "
        "FROM properties WHERE upload_session_id IS NULL"
    )[0]
    return {"missing": int(r.get("missing") or 0), "assigned": int(r.get("assigned") or 0)}
