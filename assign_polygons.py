"""
assign_polygons.py — one-time (and re-runnable) polygon assignment.

Creates the five polygon columns on `properties`, then assigns every row with
coordinates to the polygon that contains it ("smallest containing polygon
wins"), for each boundary class:

    subdivisions, zipcodes, highschools, elementary, middle

After this runs, the map/report group by the polygon column in SQL — exact and
fast — instead of by the CSV's subdivision text (which only matches ~50 % of
the rows).

    python assign_polygons.py            # all classes
    python assign_polygons.py subdivisions zipcodes

Re-run it after a big upload; rows that already match are skipped when
`--only-missing` is passed.
"""

import sys
import time

from shapely.geometry import Point

import engine
import firebase_data as fd

CLASSES = ["subdivisions", "zipcodes", "highschools", "elementary", "middle"]
CHUNK = 1000
TEXT_COL = {
    "subdivisions": "subdivisions", "zipcodes": "zipcodes",
    "highschools": "highschools", "elementary": "elementary", "middle": "middle",
}


def ensure_columns(classes):
    """Create the polygon columns — only possible for the table owner.

    The app's service account can UPDATE but not ALTER, so when this fails the
    owner runs `schema_poly_columns.sql` in the Cloud SQL console once.
    """
    print("[assign] checking schema…")
    existing = {
        r["column_name"]
        for r in fd.sql_rows(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'properties' AND column_name LIKE 'poly_id_%'"
        )
    }
    for cls in classes:
        col = f"poly_id_{cls}"
        if col in existing:
            print(f"  {col} already present")
            continue
        try:
            fd.sql_exec(f"ALTER TABLE properties ADD COLUMN IF NOT EXISTS {col} TEXT")
        except RuntimeError as exc:
            msg = str(exc)
            if "must be owner" in msg or "permission denied" in msg:
                raise SystemExit(
                    "\n[assign] The database refuses ALTER TABLE for this account.\n"
                    "         Run RESDOGS/schema_poly_columns.sql once in the\n"
                    "         Cloud SQL console (as the owner), then re-run:\n"
                    "             python assign_polygons.py --only-missing\n"
                ) from None
            raise
        print(f"  {col} ok")
    print("[assign] schema ready")


def pull_rows(only_missing: bool, classes):
    where = (
        "upload_session_id IS NULL AND lat IS NOT NULL AND lng IS NOT NULL "
        "AND lat <> 0 AND lng <> 0"
    )
    if only_missing:
        cond = " OR ".join(f"(poly_id_{c} IS NULL OR poly_id_{c} = '')" for c in classes)
        where += f" AND ({cond})"
    sql = ("SELECT mls_number, dataset_year, lat, lng, subdivisions, zipcodes, "
           f"highschools, elementary, middle FROM properties WHERE {where}")
    t0 = time.time()
    rows = fd.sql_rows(sql)
    print(f"[assign] {len(rows):,} rows with coordinates in {time.time() - t0:.1f}s")
    return rows


def assign(rows, indexes):
    """[(mls, year, {class: name})] for every row."""
    out = []
    total = len(rows)
    started = time.time()
    for n, row in enumerate(rows, 1):
        try:
            pt = Point(float(row["lng"]), float(row["lat"]))
        except (TypeError, ValueError):
            continue
        names = {}
        for cls, (tree, geoms, names_list, fids, bases) in indexes.items():
            if tree is None:
                names[cls] = ""
                continue
            hits = tree.query(pt)
            # Keep only real containment — the tree returns bbox candidates.
            hits = [k for k in hits if geoms[k].intersects(pt)]
            if hits:
                best = min(hits, key=lambda k: geoms[k].area)
            else:
                # Fallback for points a few metres outside the polygon: use
                # the row's ZIP / school / subdivision text (the owner's
                # "geolocation + zip code + street name" rule).
                key = fd.clean_boundary_name(row.get(TEXT_COL[cls]))
                cands = [i for i, b in enumerate(bases) if b == key] if key else []
                if len(cands) == 1:
                    best = cands[0]
                elif cands:
                    best = min(cands, key=lambda k: (
                        (geoms[k].centroid.x - pt.x) ** 2 + (geoms[k].centroid.y - pt.y) ** 2
                    ))
                else:
                    best = None
                # Last resort: a point a few metres outside the layer (street,
                # sidewalk, rounded corner) belongs to the nearest polygon.
                if best is None and len(geoms):
                    near = tree.nearest(pt)
                    if geoms[near].distance(pt) * 111.0 <= 0.55:
                        best = near
            names[cls] = names_list[best] if best is not None else ""
        out.append((row["mls_number"], int(row["dataset_year"]), names))
        if n % 25000 == 0:
            rate = n / max(1e-9, time.time() - started)
            print(f"  assigned {n:,}/{total:,}  ({rate:.0f} rows/s)")
    return out


def write(assigned, classes):
    # The VALUES alias exposes the bare class names; the SET clause maps them
    # onto the real columns.
    alias_cols = ", ".join(classes)
    set_clause = ", ".join(f"poly_id_{c} = v.{c}" for c in classes)
    print(f"[assign] writing {len(assigned):,} rows in chunks of {CHUNK}…")
    done = 0
    for i in range(0, len(assigned), CHUNK):
        chunk = assigned[i : i + CHUNK]
        values = []
        for mls, year, names in chunk:
            vals = [
                fd.sql_literal(mls),
                str(int(year)),
                *(fd.sql_literal(names.get(c, "")) for c in classes),
            ]
            values.append("(" + ", ".join(vals) + ")")
        sql = (
            f"UPDATE properties AS p SET {set_clause} "
            f"FROM (VALUES {', '.join(values)}) AS v(mls_number, dataset_year, {alias_cols}) "
            "WHERE p.mls_number = v.mls_number AND p.dataset_year = v.dataset_year"
        )
        fd.sql_exec(sql)
        done += len(chunk)
        print(f"  wrote {done:,}/{len(assigned):,}")
    print("[assign] done")


def reset_columns(classes):
    """Clear the derived polygon columns so every row is recomputed."""
    print("[assign] clearing the polygon columns…")
    sets = ", ".join(f"poly_id_{c} = NULL" for c in classes)
    n = fd.sql_exec(f"UPDATE properties SET {sets}")
    print(f"[assign] cleared ({n:,} rows touched)")


def main(argv):
    only_missing = "--only-missing" in argv
    if "--reset" in argv:
        only_missing = False
    classes = [a for a in argv if a in CLASSES] or CLASSES

    ensure_columns(classes)
    if "--reset" in argv:
        reset_columns(classes)
    indexes = {}
    for cls in classes:
        t0 = time.time()
        tree, geoms, names, fids, bases = engine._get_index(cls)
        print(f"[assign] {cls}: {len(geoms)} polygons ({time.time() - t0:.1f}s)")
        indexes[cls] = (tree, geoms, names, fids, bases)

    rows = pull_rows(only_missing, classes)
    if not rows:
        print("[assign] nothing to do")
        return
    assigned = assign(rows, indexes)
    write(assigned, classes)


if __name__ == "__main__":
    main(sys.argv[1:])
