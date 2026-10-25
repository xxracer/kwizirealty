"""
firebase_data.py — RESDOGS' ONLY data source: Firebase.

Everything comes from OUR Firebase project (the same one `new kwizi` uses):

  - Data Connect / Cloud SQL  → the `properties` table (the live dataset)
  - Firestore                 → `cms_files` (which boundary file is current)
  - Cloud Storage             → the boundary GeoJSON / GPKG the map draws

NO DuckDB. NO MotherDuck. NO local database.

The heavy lifting lives in Postgres: `_executeReturning` runs arbitrary SQL
against the same Cloud SQL instance the web app queries, so the per-polygon
aggregates are computed by the database, not in Python.
"""

import gzip
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ── env ───────────────────────────────────────────────────────────────────────

def _env(name, default=None):
    val = os.environ.get(name)
    if val:
        return val
    try:
        with open(os.path.join(BASE_DIR, ".env.local"), encoding="utf-8") as fh:
            env = fh.read()
        m = re.search(r"^" + name + r"=(.*)$", env, re.M)
        if m:
            v = m.group(1).strip()
            return v[1:-1] if v.startswith('"') and v.endswith('"') else v
    except FileNotFoundError:
        pass
    return default


PROJECT = _env("NEXT_PUBLIC_FIREBASE_PROJECT_ID") or "resdogs-4c0ff"
LOCATION = _env("NEXT_PUBLIC_DATACONNECT_LOCATION") or "us-east4"
SERVICE = _env("DATACONNECT_SERVICE_ID") or "resdogs-4c0ff-service"
DC_URL = (
    f"https://firebasedataconnect.googleapis.com/v1/projects/{PROJECT}"
    f"/locations/{LOCATION}/services/{SERVICE}:executeGraphql"
)
FIRESTORE_API = "https://firestore.googleapis.com/v1/projects/{p}/databases/(default)/documents/{path}"
STORAGE_API = "https://storage.googleapis.com/storage/v1/b/{bucket}/o"

# The public Storage download endpoint (no auth needed for these objects).
def storage_download_url(object_path: str) -> str:
    bucket = _env("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET") or f"{PROJECT}.firebasestorage.app"
    return f"https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{urllib.parse.quote(object_path, safe='')}?alt=media"

# ── auth ──────────────────────────────────────────────────────────────────────

_tok = {"value": None, "exp": 0.0}
_lock = threading.Lock()


class _UrllibResponse:
    def __init__(self, status, headers, data):
        self.status = status
        self.headers = headers
        self.data = data


class _UrllibTransport:
    """google-auth transport built on stdlib urllib.

    The bundled Vercel runtime did not have `requests`, and
    `google.auth.transport.requests` raised ImportError on every Firebase
    call (map, /api/me, CMS lists). This adapter removes that dependency.
    """

    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kwargs):
        req = urllib.request.Request(
            url, data=body, headers=headers or {}, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or 60) as resp:
                return _UrllibResponse(resp.status, dict(resp.headers), resp.read())
        except urllib.error.HTTPError as exc:
            return _UrllibResponse(exc.code, dict(exc.headers or {}), exc.read())


def token() -> str:
    with _lock:
        now = time.time()
        if _tok["value"] and now < _tok["exp"] - 60:
            return _tok["value"]
        from google.oauth2 import service_account

        sa = json.loads(_env("FIREBASE_SERVICE_ACCOUNT"))
        creds = service_account.Credentials.from_service_account_info(
            sa, scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        if not creds.valid:
            creds.refresh(_UrllibTransport())
        _tok["value"] = creds.token
        try:
            from datetime import datetime
            if creds.expiry:
                _tok["exp"] = now + (creds.expiry - datetime.utcnow()).total_seconds()
            else:
                _tok["exp"] = now + 3000
        except Exception:  # noqa: BLE001
            _tok["exp"] = now + 3000
        return _tok["value"]


_TRANSIENT = (408, 429, 500, 502, 503, 504)


def _gql(query: str, variables=None, retry=True):
    """Execute GraphQL with retries.

    Data Connect occasionally answers 503 UNAVAILABLE (or drops the TLS
    connection) while a query is in flight. Without a retry the map/report
    shows an empty result; with it the request simply succeeds a moment later.
    """
    body = json.dumps({"query": query, **({"variables": variables} if variables else {})}).encode()
    last_error = None
    for attempt in range(4):
        req = urllib.request.Request(
            DC_URL,
            data=body,
            headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                out = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 401 and retry:
                _tok["value"] = None
                retry = False
                continue
            detail = e.read().decode("utf-8", "replace")[:300]
            if e.code in _TRANSIENT and attempt < 3:
                last_error = f"Data Connect HTTP {e.code}: {detail}"
                time.sleep(1.2 * (attempt + 1))
                continue
            raise RuntimeError(f"Data Connect HTTP {e.code}: {detail}")
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            if attempt < 3:
                last_error = str(e)
                _tok["value"] = None
                time.sleep(1.2 * (attempt + 1))
                continue
            raise RuntimeError(f"Data Connect connection failed: {e}") from None
        if out.get("errors"):
            raise RuntimeError(f"Data Connect error: {str(out['errors'])[:400]}")
        return out["data"]
    raise RuntimeError(f"Data Connect unavailable after retries: {last_error}")


# ── raw SQL through the connector ─────────────────────────────────────────────
#
# The auto-GraphQL surface exposes `_executeReturning(sql: SQL_Mutation!)`
# which runs an arbitrary SELECT against the same Cloud SQL instance and
# returns the rows. That is how the per-polygon aggregates are computed:
# the database does the GROUP BY, Python only shapes the answer.

def sql_literal(value) -> str:
    """A value rendered as a SQL literal (safe for the embedded statement)."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def sql_exec(sql: str) -> int:
    """Run a non-SELECT statement (DDL / UPDATE) and return the affected rows.

    Retries a couple of times: a long UPDATE can lose the TLS connection
    mid-flight (WinError 10053 / RemoteDisconnected) and the statement is
    idempotent for our use (explicit UPDATE by key).
    """
    sql = " ".join(sql.split())
    escaped = sql.replace("\\", "\\\\").replace('"', '\\"')
    query = 'mutation Exec { _execute(sql: "' + escaped + '") }'
    last = None
    for attempt in range(3):
        try:
            data = _gql(query)
            return int(data.get("_execute") or 0)
        except (urllib.error.URLError, ConnectionError, OSError) as exc:
            last = exc
            _tok["value"] = None
            time.sleep(1.5 * (attempt + 1))
    raise last if last else RuntimeError("sql_exec failed")


_SQL_CACHE: dict[str, tuple[float, list]] = {}
_SQL_CACHE_TTL = 120.0
_SQL_CACHE_MAX = 48


def sql_rows(sql: str, use_cache: bool = True) -> list[dict]:
    """Run a SELECT and return its rows as dicts.

    Results are memoized for a short window: the map asks for the same
    aggregate on every pan/zoom, and the dataset only changes when the owner
    uploads. The cache is per-instance (Vercel keeps warm instances alive).
    Pass ``use_cache=False`` for writes-adjacent reads (an upload that must
    compare against what was committed a second ago).
    """
    # The statement travels inside a GraphQL string literal, which forbids
    # raw newlines — collapse all whitespace first.
    sql = " ".join(sql.split())
    now = time.time()
    hit = _SQL_CACHE.get(sql)
    if use_cache and hit and (now - hit[0]) < _SQL_CACHE_TTL:
        return hit[1]

    escaped = sql.replace("\\", "\\\\").replace('"', '\\"')
    query = (
        'mutation Exec { _executeReturning(sql: "'
        + escaped
        + '") }'
    )
    data = _gql(query)
    rows = data.get("_executeReturning") or []
    if use_cache:
        if len(_SQL_CACHE) > _SQL_CACHE_MAX:
            _SQL_CACHE.clear()
        _SQL_CACHE[sql] = (now, rows)
    return rows


# ── name cleaning (the SAME normalizer the polygons + rows share) ─────────────
#
# Ported verbatim from `new kwizi/src/lib/engineCore.ts` (cleanBoundaryName /
# cleanSchoolName / expandBoundaryName) so a polygon name and a row name always
# normalize to the same key.

_ABBREV_TO_WORD = {
    "W": "WEST",
    "E": "EAST",
    "N": "NORTH",
    "S": "SOUTH",
    "HTS": "HEIGHTS",
    "MDW": "MEADOWS",
    "GRV": "GROVE",
    "@": "AT",
}

_SCHOOL_ABBREV = {
    "ES": "ELEMENTARY",
    "MS": "MIDDLE",
    "HS": "HIGH",
    "ELEM": "ELEMENTARY",
    "MID": "MIDDLE",
    "HIGHSCH": "HIGH",
    "K": "KINDERGARTEN",
}


def clean_boundary_name(raw) -> str:
    """Polygon/row name normalizer (the map's feature key)."""
    v = str(raw or "").upper().strip()
    if not v or v in ("NA", "N/A", "NONE", "NULL", "UNKNOWN", "UNINCORPORATED"):
        return ""
    v = re.sub(r"\s+", " ", v)
    v = re.sub(r"[.,']", "", v)
    v = re.sub(r"\s+", " ", v).strip()
    # Whole-word abbreviation folding (W MEMORIAL -> WEST MEMORIAL).
    for token in list(v.split()):
        if token in _ABBREV_TO_WORD:
            v = v.replace(token, _ABBREV_TO_WORD[token], 1)
    return v.strip()


def clean_school_name(raw) -> str:
    """School boundary name normalizer."""
    v = clean_boundary_name(raw)
    if not v:
        return ""
    parts = v.split(" ")
    out = []
    for p in parts:
        out.append(_SCHOOL_ABBREV.get(p, p))
    return " ".join(out)


def expand_boundary_name(raw) -> str:
    """Human-facing label for a polygon (the owner's 'west memorial' fix)."""
    v = clean_boundary_name(raw)
    if not v:
        return ""
    return v.title()


# ── Firestore: which boundary file is CURRENT ────────────────────────────────

BOUNDARY_FILE_NAMES = {
    "subdivisions": "Mapped Subdivisions.geojson",
    "neighborhoods": "Mapped Subdivisions.geojson",
    "zipcodes": "Zip.geojson",
    "highschools": "Houston_ISD.geojson",
    "elementary": "Elementary School ISD.geojson",
    "middle": "Middle School ISD.geojson",
}


def _fs_value(value):
    """Python value -> Firestore REST value object."""
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, (list, tuple)):
        return {"arrayValue": {"values": [_fs_value(v) for v in value]}}
    if isinstance(value, dict):
        return {"mapValue": {"fields": {k: _fs_value(v) for k, v in value.items()}}}
    return {"stringValue": str(value)}


def _fs_decode(value):
    """Firestore REST value object -> Python value (nested maps included)."""
    if not isinstance(value, dict):
        return value
    if "stringValue" in value:
        return value["stringValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "booleanValue" in value:
        return value["booleanValue"]
    if "nullValue" in value:
        return None
    if "timestampValue" in value:
        return value["timestampValue"]
    if "arrayValue" in value:
        return [_fs_decode(v) for v in (value["arrayValue"].get("values") or [])]
    if "mapValue" in value:
        return {
            k: _fs_decode(v)
            for k, v in (value["mapValue"].get("fields") or {}).items()
        }
    return next(iter(value.values())) if value else None


def fs_write(collection: str, doc_id: str | None, fields: dict, merge: bool = False) -> str:
    """Create/replace (merge=False) or patch (merge=True) a Firestore doc."""
    base = (
        f"https://firestore.googleapis.com/v1/projects/{PROJECT}"
        f"/databases/(default)/documents/{collection}"
    )
    body = json.dumps({"fields": {k: _fs_value(v) for k, v in fields.items()}}).encode()
    if doc_id:
        url = f"{base}/{urllib.parse.quote(doc_id, safe='')}"
        if merge:
            mask = "&".join(
                "updateMask.fieldPaths=" + urllib.parse.quote(k, safe="")
                for k in fields
            )
            url += "?" + mask
        method = "PATCH"
    else:
        url = base
        method = "POST"
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.loads(r.read().decode())
    return (out.get("name") or "").rsplit("/", 1)[-1]


def fs_delete(collection: str, doc_id: str) -> None:
    url = (
        f"https://firestore.googleapis.com/v1/projects/{PROJECT}"
        f"/databases/(default)/documents/{collection}/{urllib.parse.quote(doc_id, safe='')}"
    )
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token()}"}, method="DELETE"
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        r.read()


def _fs_list(path: str) -> list[dict]:
    url = FIRESTORE_API.format(p=PROJECT, path=path) + "?pageSize=300"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token()}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.loads(r.read().decode("utf-8"))
    docs = []
    for d in out.get("documents", []):
        f = d.get("fields", {})
        doc = {k: _fs_decode(v) for k, v in f.items()}
        # Keep the document id so the CMS can delete records.
        doc["_id"] = (d.get("name") or "").rsplit("/", 1)[-1]
        docs.append(doc)
    return docs


def current_boundary_file(class_name: str) -> dict | None:
    """cms_files record for the class' file, latest by uploadedAt."""
    name = BOUNDARY_FILE_NAMES.get(class_name)
    if not name:
        return None
    docs = [d for d in _fs_list("cms_files") if d.get("name") == name]
    if not docs:
        return None
    docs.sort(key=lambda d: float(d.get("uploadedAt") or 0), reverse=True)
    return docs[0]


def fetch_boundary_geojson(class_name: str) -> dict:
    """The current boundary file for a class, as a GeoJSON FeatureCollection."""
    rec = current_boundary_file(class_name)
    if not rec or not rec.get("storageUrl"):
        return {"type": "FeatureCollection", "features": []}
    url = rec["storageUrl"]
    req = urllib.request.Request(url, headers={"User-Agent": "kwizi-resdogs"})
    with urllib.request.urlopen(req, timeout=180) as r:
        buf = r.read()
    if buf[:2] == b"\x1f\x8b":
        buf = gzip.decompress(buf)
    return json.loads(buf.decode("utf-8"))
