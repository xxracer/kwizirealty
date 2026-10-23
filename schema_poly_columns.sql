-- RESDOGS — one-time schema step for exact per-polygon numbers.
--
-- Run this ONCE in the database `kwizi` on the Cloud SQL instance behind the
-- `resdogs-4c0ff-service` Data Connect service:
--   Firebase console → Data Connect → resdogs-4c0ff-service → Cloud SQL →
--   "Open Cloud SQL Studio" (or the Cloud SQL console → SQL → Query).
--
-- The service account the app uses can UPDATE rows but cannot ALTER the
-- table (it is not the owner), so this step needs the owner's console.
-- After running it, launch:  python assign_polygons.py --only-missing

ALTER TABLE properties ADD COLUMN IF NOT EXISTS poly_id_subdivisions TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS poly_id_zipcodes     TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS poly_id_highschools  TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS poly_id_elementary   TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS poly_id_middle       TEXT;

CREATE INDEX IF NOT EXISTS idx_properties_poly_subdivisions ON properties(poly_id_subdivisions);
CREATE INDEX IF NOT EXISTS idx_properties_poly_zipcodes     ON properties(poly_id_zipcodes);
CREATE INDEX IF NOT EXISTS idx_properties_poly_highschools  ON properties(poly_id_highschools);
CREATE INDEX IF NOT EXISTS idx_properties_poly_elementary   ON properties(poly_id_elementary);
CREATE INDEX IF NOT EXISTS idx_properties_poly_middle       ON properties(poly_id_middle);
