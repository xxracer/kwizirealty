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
    boundaries = []
    for f in files:
        cat = f.get("category") or "unknown"
        by_category[cat] = by_category.get(cat, 0) + 1
        if cat == "boundary":
            boundaries.append({
                "name": f.get("name"),
                "size": f.get("size"),
                "uploadedAt": f.get("uploadedAt"),
            })
    boundaries.sort(key=lambda b: -(float(b.get("uploadedAt") or 0)))

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

def list_files(category: str | None = None) -> list[dict]:
    files = fd._fs_list("cms_files")
    if category:
        files = [f for f in files if (f.get("category") or "") == category]
    files.sort(key=lambda f: -(float(f.get("uploadedAt") or 0)))
    return [
        {
            "id": f.get("_id"),
            "name": f.get("name"),
            "category": f.get("category"),
            "size": f.get("size"),
            "uploadedAt": f.get("uploadedAt"),
            "storagePath": f.get("storagePath"),
            "rowCount": f.get("rowCount"),
        }
        for f in files
    ]


def delete_file(doc_id: str, storage_path: str | None = None) -> dict:
    if not doc_id:
        raise HTTPException(status_code=400, detail="Missing file id")
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
    return {"ok": True, "id": doc_id}


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

    tree, geoms, names = engine._get_index(cls)
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
    sql = (
        "SELECT mls_number, dataset_year, lat, lng FROM properties WHERE "
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
