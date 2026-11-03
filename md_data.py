"""md_data.py — MotherDuck data layer (replaces Firebase Data Connect SQL).

Drop-in for the pieces of `firebase_data` the app uses for SQL:
    sql_literal(value) -> str
    sql_rows(sql, use_cache=True) -> list[dict]
    sql_exec(sql) -> int

Firestore / Storage stay in `firebase_data` (CMS files + GeoJSON). Only the
analytical table `properties` lives in MotherDuck.
"""
import datetime as _dt
import decimal
import os
import re
import threading
import time

import duckdb

_ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.local")
_env_cache: dict[str, str] = {}
_local = threading.local()
_conn_lock = threading.Lock()

_CACHE: dict[str, tuple[float, list]] = {}
_CACHE_TTL = 120.0
_CACHE_MAX = 48


def _env(name: str, default: str | None = None) -> str:
    if name in _env_cache:
        return _env_cache[name]
    value = os.environ.get(name)
    if value is None and os.path.exists(_ENV_FILE):
        try:
            with open(_ENV_FILE, encoding="utf-8") as fh:
                for line in fh:
                    if line.strip().startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    if k.strip() == name:
                        value = v.strip().strip('"').strip("'")
                        break
        except OSError:
            pass
    _env_cache[name] = value if value is not None else (default or "")
    return _env_cache[name]


def _connection():
    """One DuckDB connection PER THREAD (DuckDB connections are not thread-safe;
    the report runs its six queries in a thread pool)."""
    con = getattr(_local, "con", None)
    if con is not None:
        return con
    with _conn_lock:
        token = _env("MOTHERDUCK_TOKEN")
        db = _env("MOTHERDUCK_DATABASE") or "real_stat"
        if not token:
            raise RuntimeError(
                "MotherDuck is not configured: set MOTHERDUCK_TOKEN and MOTHERDUCK_DATABASE."
            )
        con = duckdb.connect(f"md:{db}?motherduck_token={token}")
        _local.con = con
    return con


def sql_literal(value) -> str:
    """A value rendered as a SQL literal (safe for the embedded statement)."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def _norm(value):
    """JSON-friendly scalar (DuckDB returns Decimal/date/datetime objects)."""
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.isoformat()
    if isinstance(value, _dt.timedelta):
        return value.total_seconds()
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")
    return value


def sql_rows(sql: str, use_cache: bool = True) -> list[dict]:
    sql = " ".join(sql.split())
    now = time.time()
    if use_cache:
        hit = _CACHE.get(sql)
        if hit and (now - hit[0]) < _CACHE_TTL:
            return hit[1]
    con = _connection()
    cur = con.execute(sql)
    cols = [d[0] for d in (cur.description or [])]
    rows = [dict(zip(cols, (_norm(v) for v in r))) for r in cur.fetchall()]
    if use_cache:
        if len(_CACHE) > _CACHE_MAX:
            _CACHE.clear()
        _CACHE[sql] = (now, rows)
    return rows


def sql_exec(sql: str) -> int:
    """Run a non-SELECT statement. DuckDB exposes rowcount for writes."""
    con = _connection()
    cur = con.execute(" ".join(sql.split()))
    try:
        count = cur.rowcount
    except Exception:  # noqa: BLE001
        count = 0
    try:
        _CACHE.clear()
    except Exception:
        pass
    return int(count) if isinstance(count, int) and count > 0 else 0


def invalidate() -> None:
    _CACHE.clear()
