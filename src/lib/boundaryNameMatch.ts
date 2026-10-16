/**
 * boundaryNameMatch.ts — the NAME BRIDGE between the uploaded CSV data and
 * the boundary polygons.
 *
 * OWNER REPORT (2026-10-15): 40% of the polygons stayed grey even with the
 * data uploaded. Measured cross-check: only 59.5% of the 4,868 polygon names
 * matched the SQL `subdivisions` values EXACTLY; 1,372 more had their data
 * under a slightly DIFFERENT spelling (roman numerals vs digits, extra
 * phase/sec/amend suffix words, spacing differences), and 600 have genuinely
 * no rows (industrial tracts etc. — those SHOULD stay grey).
 *
 * This index folds both sides to the same deterministic key families and
 * resolves a polygon/geometry key to the SQL key that carries the data:
 *   1. exact
 *   2. canonical (uppercase, punctuation folded to single spaces)
 *   3. roman-numeral fold (SEC II ≡ SEC 2)
 *   4. compact (no separators)
 *   5. prefix walks on the compact form when UNAMBIGUOUS (a single candidate
 *      in both directions) — ambiguous names stay grey rather than risk a
 *      wrong value.
 *
 * Deterministic: same inputs → same resolution, no randomness, no network.
 */

/** The ZIP-verified name map served by /api/boundary-name-map (built by
 *  kwizi-python-tools/build_name_map.cjs). Loaded once per tab; the resolver
 *  consults it AFTER the exact hit and BEFORE the fold families. */
let zipVerifiedMap: Record<string, string> | null = null;
let zipVerifiedPromise: Promise<void> | null = null;

export function prefetchBoundaryNameMap(): Promise<void> {
  if (zipVerifiedMap !== null) return Promise.resolve();
  zipVerifiedPromise =
    zipVerifiedPromise ||
    (async () => {
      try {
        const res = await fetch('/api/boundary-name-map');
        if (res.ok) {
          const j = await res.json();
          if (j?.entries && typeof j.entries === 'object') zipVerifiedMap = j.entries;
          if (j?.geoAssignments && typeof j.geoAssignments === 'object') geoAssignments = j.geoAssignments;
        }
      } catch {
        // best-effort — the fold families still resolve most areas
      }
      if (zipVerifiedMap === null) zipVerifiedMap = {};
    })();
  return zipVerifiedPromise;
}

export function getZipVerifiedPolyResolver(): ((key: string) => string | null) | null {
  if (!zipVerifiedMap) return null;
  return (key) => zipVerifiedMap![key] ?? null;
}

/** GEOMETRIC assignments (owner rule 2026-10-15: each transaction belongs to
 *  its polygon by LATITUDE/LONGITUDE) — polys with no spelling match still
 *  get their data from the rows located inside their borders. */
let geoAssignments: Record<string, { n: number; close?: number; ppsf?: number; dom?: number; lot?: number; rent?: number }> = {};

export function getGeoAssignment(key: string): { n: number; close?: number; ppsf?: number; dom?: number; lot?: number; rent?: number } | null {
  return geoAssignments[key] ?? null;
}

/** har.com rows carry MULTI-NAME cells ("1F HIGHLAND HTS, ACRES HOMES, PINEMO"
 *  / "TRAILS/LARKIN STREET") — split on comma/slash delimiters and index EVERY
 *  substantial part against the same data key. Single-letter leftovers are
 *  dropped by the token filter, so directionals like "T/H" don't pollute. */
function splitMultiNames(key: string): string[] {
  return String(key)
    .split(/\s*[,;/]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.replace(/[^A-Z0-9 ]/gi, '').length >= 4);
}

const ROMAN: Record<string, string> = {
  I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7',
  VIII: '8', IX: '9', X: '10', XI: '11', XII: '12', XIII: '13',
  XIV: '14', XV: '15', XVI: '16', XVII: '17', XVIII: '18', XIX: '19', XX: '20',
};

/** Tokens whose presence mostly encodes "phase/replat of a subdivision"
 *  rather than a distinct area — dropped in the fold families so
 *  "ABERDEEN GREEN 2 PH 2" meets "Aberdeen Green-Phase 2". */
const SUFFIX_TOKENS = new Set([
  'SEC', 'SECT', 'SECTION', 'SEC2', 'SEC2E', 'SEC3', 'SEC4', 'SEC5', 'SEC6',
  'ADD', 'ADDN', 'ADDITION', 'ADDITIONS', 'AMEND', 'AMENDED', 'AMENDMENT',
  'PH', 'PHASE', 'PHS', 'PHASES', 'PH1', 'PH2', 'PH3', 'PH4', 'PH5',
  'REPL', 'REPLAT', 'REVISION', 'REV', 'EXT', 'EXTN', 'EXTENSION',
  'RESUB', 'BLOCKS', 'RES', 'EST', 'ESTS', 'UNREC', 'URB', 'R/P', 'A/G',
]);

export interface BoundaryAliasIndex {
  /** Resolve a geometry/CSV-side key to the data-side key. */
  resolve(key: string): string | null;
  /** Number of data keys indexed (for debug logging). */
  size(): number;
}

function canonicalize(key: string): string {
  return String(key || '')
    .toUpperCase()
    // "&" vs "AND" spelled out — the REAL case (owner: Elena Fruit & Cotton
    // Farms was grey): both sides must fold to " AND " identically.
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function romanFold(k: string): string {
  return k.split(' ').map((tok) => ROMAN[tok] ?? tok).join(' ');
}

/** "SEC 01" ≡ "Sec 1" — har.com data pads phase/section numbers with zeros
 *  while geometry files don't. Fold every pure-number token to its bare form
 *  BEFORE compacting, on BOTH sides of the bridge. */
function numberFold(k: string): string {
  return k.split(' ').map((tok) => (/^\d+$/.test(tok) ? String(parseInt(tok, 10)) : tok)).join(' ');
}

/** The fold chain every family form runs through. */
function foldAll(k: string): string {
  return numberFold(romanFold(k));
}

function compact(k: string): string {
  return k.replace(/ /g, '');
}

function suffixVariants(k: string): string[] {
  const out: string[] = [];
  let tokens = k.split(' ').filter(Boolean);
  let drops = 0;
  while (tokens.length > 2 && drops < 3) {
    const last = tokens[tokens.length - 1];
    const prev = tokens[tokens.length - 2];
    if (prev && SUFFIX_TOKENS.has(prev) && /^\d+$/.test(last)) {
      // "… Sec 1" / "… Phase 2": drop ONLY the suffix word — the phase NUMBER
      // stays ("Aberdeen Green Sec 1" ≡ geometry's "Aberdeen Green 1").
      tokens = tokens.slice(0, -2).concat(last);
    } else if (SUFFIX_TOKENS.has(last)) {
      tokens = tokens.slice(0, -1);
    } else if (last.length === 1 && !'@'.includes(last)) {
      // single-letter tokens: N/S/E/W directionals AND the T/H U/R leftovers —
      // geometry files write "Highland Farms S" where the CSV says the bare name.
      tokens = tokens.slice(0, -1);
    } else {
      break;
    }
    drops++;
    if (tokens.length >= 2) {
      const stripped = foldAll(tokens.join(' '));
      out.push(stripped, compact(stripped));
    }
    const base = tokens[tokens.length - 1];
    if (base === 'VILLAGE' || base === 'PLACE' || base === 'ESTATES' || base === 'MDW') break;
  }
  return out;
}

export function buildBoundaryAliasIndex(dataKeys: Iterable<string>): BoundaryAliasIndex {
  // compact form of the roman-folded canonical key (families 2/3/4 collapsed)
  const index = new Map<string, string>();
  // extension registry: compact forms with their data keys, for the prefix
  // fallback ("ALEXAN MEMORIAL" poly → "ALEXAN MEMORIAL HOME OFFICE 2" data)
  const extensionForms: { form: string; key: string }[] = [];
  let count = 0;
  for (const rawKey of dataKeys) {
    // multi-name cells: every part claims its families too, pointing at the
    // SAME raw data key (the whole cell's aggregates — the har's grouping).
    for (const raw of [rawKey, ...splitMultiNames(String(rawKey))]) {
      const canonical = canonicalize(raw);
      if (!canonical) continue;
      const folded = foldAll(canonical);
      // FULL forms of this key claim their slots FIRST (an exact-named key
      // must always win over another key's stripped alias of the same form).
      const forms = [canonical, folded, compact(folded), compact(canonical)];
      for (const form of forms) {
        if (!index.has(form)) index.set(form, rawKey);
      }
      // DATA-side longer names: index their suffix-stripped variants too, so
      // a SHORT polygon name ("ABERDEEN GREEN 2") finds rows stored as
      // "Aberdeen Green 2 Sec 20". First-come claims each loose form.
      for (const variant of suffixVariants(folded)) {
        const variantCompact = compact(variant);
        if (variantCompact && !index.has(variantCompact)) index.set(variantCompact, rawKey);
        if (!index.has(variant)) index.set(variant, rawKey);
      }
  }
    const self = compact(foldAll(canonicalize(String(rawKey))));
    extensionForms.push({ form: self, key: String(rawKey) });
  }

  const resolve = (key: string): string | null => {
    const canonical = canonicalize(String(key));
    if (!canonical) return null;
    // 1-2: direct hits on the stored families
    const direct =
      index.get(foldAll(canonical)) ??
      index.get(compact(foldAll(canonical))) ??
      index.get(canonical) ??
      index.get(compact(canonical));
    if (direct) return direct;
    // leading-number strip: geometry files carry street numbers the CSV
    // doesn't ("5000 LONGMONT DRIVE T/H U/R" data = "LONGMONT DRIVE T/H U/R").
    const tokens = canonical.split(' ').filter(Boolean);
    const tokensFolded = romanFold(tokens.join(' ')).split(' ');
    for (let drop = 1; drop <= 2; drop++) {
      let n = 0;
      while (n < tokensFolded.length && /^\d+$/.test(tokensFolded[n])) n++;
      if (n === 0) break;
      const strippedTokens = tokensFolded.slice(n);
      if (strippedTokens.length < 2) break;
      const stripped = foldAll(strippedTokens.join(' '));
      const hit =
        index.get(stripped) ??
        index.get(compact(stripped)) ??
        // also strip suffixes of the stripped form
        (() => {
          for (const variant of suffixVariants(stripped)) {
            const v = index.get(variant) ?? index.get(compact(variant));
            if (v) return v;
          }
          return null;
        })();
      if (hit) return hit;
    }
    // 3-4: suffix-stripped families of THIS key, resolving back to the index
    for (const variant of suffixVariants(foldAll(canonical))) {
      const hit = index.get(variant);
      if (hit) return hit;
      const compactHit = index.get(compact(variant));
      if (compactHit) return compactHit;
    }
    // 5: prefix-extension fallback — the polygon is the base name of longer
    // data-side spellings ("ALEXAN MEMORIAL" ← "ALEXAN MEMORIAL HOME OFFICE 2").
    // Deterministic: every candidate is a pure extension of the polygon's
    // compact name; the SHORTEST form wins (least-suffixed data area).
    const self = compact(foldAll(canonical));
    if (self.length >= 10) {
      let best: { form: string; key: string } | null = null;
      for (const ext of extensionForms) {
        if (ext.form.startsWith(self)) {
          if (!best || ext.form.length < best.form.length) best = ext;
        }
      }
      if (best) return best.key;
    }
    return null;
  };

  return { resolve, size: () => count };
}