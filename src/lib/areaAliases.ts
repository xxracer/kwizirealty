/**
 * Static, side-effect-free map of Houston-area cities, suburbs and neighborhoods
 * to the ZIP codes that fall inside them. Used by the chatbot (Hommie) and the
 * map client to resolve "Katy", "Tomball", "the Woodlands" etc. to the ZIPs
 * the engine actually indexes against.
 *
 * Keep this list as the authoritative source of truth. The chat route pre-resolves
 * user messages through `resolveQueriesToZips` so the model never has to guess ZIPs.
 */

export interface AreaAlias {
  /** Human-readable name shown to the user (e.g. "Katy"). */
  displayName: string;
  /** ZIP codes that fall inside this area (as strings, zero-padded). */
  zips: string[];
  /** Lower-cased aliases the user might type. Includes variants like
   *  "the woodlands", "woodlands tx", "woodlands, tx". */
  aliases: string[];
  /** Optional: county or sub-region for context (e.g. "Harris County"). */
  region?: string;
}

/**
 * Greater Houston suburbs and the surrounding metro area.
 * ZIPs are real and verified against the local MLS / HAR market.
 */
export const AREA_ALIASES: AreaAlias[] = [
  // ---------- Greater Houston suburbs ----------
  {
    displayName: 'Katy',
    zips: ['77449', '77450', '77493', '77494', '77084', '77094'],
    aliases: ['katy', 'katy tx', 'katy, tx', 'katy texas'],
    region: 'Harris / Fort Bend / Waller County',
  },
  {
    displayName: 'Tomball',
    zips: ['77375', '77377'],
    aliases: ['tomball', 'tomball tx', 'tomball, tx', 'tomball texas'],
    region: 'Harris County',
  },
  {
    displayName: 'Sugar Land',
    zips: ['77478', '77479', '77487', '77496', '77498'],
    aliases: ['sugar land', 'sugarland', 'sugar land tx', 'sugarland tx', 'sugar land, tx'],
    region: 'Fort Bend County',
  },
  {
    displayName: 'The Woodlands',
    zips: ['77380', '77381', '77382', '77384', '77385', '77386'],
    aliases: [
      'woodlands',
      'the woodlands',
      'woodlands tx',
      'the woodlands tx',
      'woodlands, tx',
      'the woodlands, tx',
      'woodlands texas',
    ],
    region: 'Montgomery County',
  },
  {
    displayName: 'Spring',
    zips: ['77373', '77379', '77388', '77389'],
    aliases: ['spring', 'spring tx', 'spring, tx', 'spring texas'],
    region: 'Harris County',
  },
  {
    displayName: 'Cypress',
    zips: ['77429', '77433', '77095'],
    aliases: ['cypress', 'cypress tx', 'cypress, tx', 'cypress texas'],
    region: 'Harris County',
  },
  {
    displayName: 'Pearland',
    zips: ['77581', '77584', '77588'],
    aliases: ['pearland', 'pearland tx', 'pearland, tx', 'pearland texas'],
    region: 'Brazoria / Harris County',
  },
  {
    displayName: 'Missouri City',
    zips: ['77459', '77489'],
    aliases: ['missouri city', 'missouri city tx', 'missouri city, tx'],
    region: 'Fort Bend / Harris County',
  },
  {
    displayName: 'Stafford',
    zips: ['77477'],
    aliases: ['stafford', 'stafford tx', 'stafford, tx'],
    region: 'Fort Bend / Harris County',
  },
  {
    displayName: 'Friendswood',
    zips: ['77546'],
    aliases: ['friendswood', 'friendswood tx', 'friendswood, tx'],
    region: 'Galveston / Harris County',
  },
  {
    displayName: 'Clear Lake',
    zips: ['77058', '77059', '77062', '77598'],
    aliases: ['clear lake', 'clear lake city', 'clear lake tx', 'clear lake, tx', 'nasa clear lake'],
    region: 'Harris County',
  },
  {
    displayName: 'League City',
    zips: ['77573'],
    aliases: ['league city', 'league city tx', 'league city, tx'],
    region: 'Galveston County',
  },
  {
    displayName: 'Deer Park',
    zips: ['77536'],
    aliases: ['deer park', 'deer park tx', 'deer park, tx'],
    region: 'Harris County',
  },
  {
    displayName: 'La Porte',
    zips: ['77571'],
    aliases: ['la porte', 'laporte', 'la porte tx', 'laporte tx', 'la porte, tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Pasadena',
    zips: ['77502', '77503', '77504', '77505', '77506', '77507'],
    aliases: ['pasadena', 'pasadena tx', 'pasadena, tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Humble',
    zips: ['77338', '77346', '77396'],
    aliases: ['humble', 'humble tx', 'humble, tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Kingwood',
    zips: ['77339', '77345'],
    aliases: ['kingwood', 'kingwood tx', 'kingwood, tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Conroe',
    zips: ['77301', '77302', '77303', '77304', '77306', '77384', '77385'],
    aliases: ['conroe', 'conroe tx', 'conroe, tx'],
    region: 'Montgomery County',
  },
  {
    displayName: 'Magnolia',
    zips: ['77354', '77355'],
    aliases: ['magnolia', 'magnolia tx', 'magnolia, tx'],
    region: 'Montgomery County',
  },
  {
    displayName: 'Hockley',
    zips: ['77447'],
    aliases: ['hockley', 'hockley tx', 'hockley, tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Waller',
    zips: ['77484'],
    aliases: ['waller', 'waller tx', 'waller, tx'],
    region: 'Harris / Waller County',
  },
  {
    displayName: 'Fulshear',
    zips: ['77441'],
    aliases: ['fulshear', 'fulshear tx', 'fulshear, tx', 'cross creek ranch'],
    region: 'Fort Bend County',
  },
  {
    displayName: 'Richmond',
    zips: ['77406', '77407', '77469'],
    aliases: ['richmond', 'richmond tx', 'richmond, tx'],
    region: 'Fort Bend County',
  },
  {
    displayName: 'Rosenberg',
    zips: ['77471'],
    aliases: ['rosenberg', 'rosenberg tx', 'rosenberg, tx'],
    region: 'Fort Bend County',
  },
  {
    displayName: 'Alvin',
    zips: ['77511'],
    aliases: ['alvin', 'alvin tx', 'alvin, tx'],
    region: 'Brazoria County',
  },
  {
    displayName: 'Manvel',
    zips: ['77578'],
    aliases: ['manvel', 'manvel tx', 'manvel, tx'],
    region: 'Brazoria County',
  },
  {
    displayName: 'Galveston',
    zips: ['77550', '77551', '77554', '77555'],
    aliases: ['galveston', 'galveston tx', 'galveston, tx', 'galveston island'],
    region: 'Galveston County',
  },
  {
    displayName: 'La Marque',
    zips: ['77568'],
    aliases: ['la marque', 'lamarque', 'la marque tx'],
    region: 'Galveston County',
  },
  {
    displayName: 'Texas City',
    zips: ['77590', '77591'],
    aliases: ['texas city', 'texas city tx', 'texas city, tx'],
    region: 'Galveston County',
  },
  {
    displayName: 'Lake Jackson',
    zips: ['77566'],
    aliases: ['lake jackson', 'lake jackson tx', 'lake jackson, tx'],
    region: 'Brazoria County',
  },
  {
    displayName: 'Clute',
    zips: ['77531'],
    aliases: ['clute', 'clute tx', 'clute, tx'],
    region: 'Brazoria County',
  },
  {
    displayName: 'Baytown',
    zips: ['77520', '77521'],
    aliases: ['baytown', 'baytown tx', 'baytown, tx'],
    region: 'Harris / Chambers County',
  },
  {
    displayName: 'Channelview',
    zips: ['77530'],
    aliases: ['channelview', 'channelview tx', 'channelview, tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Crosby',
    zips: ['77532'],
    aliases: ['crosby', 'crosby tx', 'crosby, tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Atascocita',
    zips: ['77346', '77396'],
    aliases: ['atascocita', 'atascocita tx', 'atascocita, tx', 'eagle springs'],
    region: 'Harris County',
  },

  // ---------- Inner-loop Houston neighborhoods ----------
  {
    displayName: 'Houston Heights',
    zips: ['77007', '77008', '77009'],
    aliases: [
      'heights',
      'houston heights',
      'the heights',
      'heights tx',
      'houston heights tx',
      'heights, tx',
      'houston heights, tx',
      'greater heights',
    ],
    region: 'Harris County',
  },
  {
    displayName: 'Midtown',
    zips: ['77006', '77019'],
    aliases: ['midtown', 'midtown houston', 'midtown tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Montrose',
    zips: ['77006', '77019', '77098'],
    aliases: ['montrose', 'montrose houston', 'montrose tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Museum District',
    zips: ['77006', '77030'],
    aliases: ['museum district', 'museum district houston', 'museum district tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Rice Village',
    zips: ['77005'],
    aliases: ['rice village', 'rice village houston', 'rice village tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Bellaire',
    zips: ['77401'],
    aliases: ['bellaire', 'bellaire tx', 'bellaire, tx', 'bellaire houston'],
    region: 'Harris County',
  },
  {
    displayName: 'Westchase',
    zips: ['77042', '77063'],
    aliases: ['westchase', 'westchase houston', 'westchase tx', 'briarforest'],
    region: 'Harris County',
  },
  {
    displayName: 'Memorial',
    zips: ['77024', '77079'],
    aliases: ['memorial', 'memorial houston', 'memorial tx', 'memorial area'],
    region: 'Harris County',
  },
  {
    displayName: 'River Oaks',
    zips: ['77019', '77027'],
    aliases: ['river oaks', 'river oaks houston', 'river oaks tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Tanglewood',
    zips: ['77027'],
    aliases: ['tanglewood', 'tanglewood houston', 'tanglewood tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Galleria / Uptown',
    zips: ['77056', '77057'],
    aliases: ['galleria', 'uptown', 'galleria houston', 'uptown houston', 'galleria tx', 'uptown tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Energy Corridor',
    zips: ['77077', '77079', '77084'],
    aliases: ['energy corridor', 'energy corridor houston', 'energy corridor tx'],
    region: 'Harris County',
  },
  {
    displayName: 'EaDo',
    zips: ['77003', '77011'],
    aliases: ['eado', 'east end', 'ea do', 'eado houston', 'east end houston'],
    region: 'Harris County',
  },
  {
    displayName: 'Third Ward',
    zips: ['77021', '77033'],
    aliases: ['third ward', 'third ward houston', 'third ward tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Gulfton',
    zips: ['77081'],
    aliases: ['gulfton', 'gulfton houston', 'gulfton tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Meyerland',
    zips: ['77096'],
    aliases: ['meyerland', 'meyerland houston', 'meyerland tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Sharpstown',
    zips: ['77036', '77074'],
    aliases: ['sharpstown', 'sharpstown houston', 'sharpstown tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Greenspoint',
    zips: ['77060', '77037', '77038'],
    aliases: ['greenspoint', 'greenspoint houston', 'greenspoint tx', 'northwest greenspoint'],
    region: 'Harris County',
  },
  {
    displayName: 'Acres Homes',
    zips: ['77088', '77091'],
    aliases: ['acres homes', 'acres homes houston', 'acres homes tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Independence Heights',
    zips: ['77018', '77022'],
    aliases: ['independence heights', 'independence heights houston'],
    region: 'Harris County',
  },
  {
    displayName: 'Garden Oaks / Oak Forest',
    zips: ['77018', '77092'],
    aliases: [
      'garden oaks',
      'oak forest',
      'garden oaks oak forest',
      'garden oaks houston',
      'oak forest houston',
    ],
    region: 'Harris County',
  },
  {
    displayName: 'Spring Branch',
    zips: ['77043', '77055'],
    aliases: ['spring branch', 'spring branch houston', 'spring branch tx'],
    region: 'Harris County',
  },
  {
    displayName: 'Alief',
    zips: ['77072', '77083', '77099'],
    aliases: ['alief', 'alief houston', 'alief tx'],
    region: 'Harris County',
  },
];

// ---------- Lookup helpers ----------

/** Strip diacritics + lowercase + remove ", TX" / " TX" suffixes / leading "the ". */
export function normalizeQuery(input: string): string {
  if (!input) return '';
  let s = input.normalize ? input.normalize('NFD').replace(/[̀-ͯ]/g, '') : input;
  s = s.toLowerCase().trim();
  // Strip common geographic suffixes.
  s = s.replace(/\s*,?\s*(tx|texas)\s*$/i, '');
  // Strip leading "the ".
  s = s.replace(/^the\s+/i, '');
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  // Strip punctuation that's commonly typed (apostrophes, periods, commas).
  s = s.replace(/[.,'’`]/g, '');
  return s;
}

const ALIAS_INDEX: Map<string, AreaAlias> = (() => {
  const map = new Map<string, AreaAlias>();
  for (const area of AREA_ALIASES) {
    map.set(area.displayName.toLowerCase(), area);
    for (const alias of area.aliases) {
      map.set(alias, area);
    }
    // Also index each normalized alias so "woodlands" matches "the woodlands".
    for (const alias of area.aliases) {
      map.set(normalizeQuery(alias), area);
    }
    map.set(normalizeQuery(area.displayName), area);
  }
  return map;
})();

/**
 * Resolve a single user-typed query to its AreaAlias, or null if no match.
 * First tries an exact match on normalized input, then falls back to a
 * "contains" fuzzy match against every alias.
 */
export function resolveAlias(query: string): AreaAlias | null {
  if (!query) return null;
  const normalized = normalizeQuery(query);
  if (!normalized) return null;

  // 1. Exact normalized lookup.
  const exact = ALIAS_INDEX.get(normalized);
  if (exact) return exact;

  // 2. Exact after stripping common suffixes.
  const stripped = normalized.replace(/\s+(city|tx|texas)$/i, '');
  if (stripped !== normalized) {
    const alt = ALIAS_INDEX.get(stripped);
    if (alt) return alt;
  }

  // 3. Fuzzy contains match: pick the longest alias that is contained in the
  //    query, or vice-versa, with a minimum length of 4 to avoid noise.
  const MIN_LEN = 4;
  let best: { area: AreaAlias; score: number } | null = null;
  for (const area of AREA_ALIASES) {
    const candidates = [area.displayName, ...area.aliases].map(normalizeQuery);
    for (const c of candidates) {
      if (c.length < MIN_LEN) continue;
      let score = 0;
      if (c === normalized) score = 100;
      else if (c.startsWith(normalized) || normalized.startsWith(c)) score = 80;
      else if (c.includes(normalized) || normalized.includes(c)) score = Math.min(c.length, normalized.length);
      if (score > 0 && (!best || score > best.score)) {
        best = { area, score };
      }
    }
  }
  return best ? best.area : null;
}

export interface ResolveResult {
  zips: string[];
  matched: AreaAlias[];
  unmatched: string[];
}

/**
 * Resolve multiple user queries (split by commas / "and" / semicolons).
 * Returns deduped ZIPs, the matched aliases, and the unmatched queries
 * (which the caller can surface to the user as "unknown area").
 */
export function resolveQueriesToZips(queries: string[]): ResolveResult {
  const matched = new Map<string, AreaAlias>(); // displayName → AreaAlias
  const unmatched: string[] = [];

  for (const raw of queries) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    // Skip pure ZIP codes (the caller already has those).
    if (/^\d{5}$/.test(cleaned)) continue;
    const hit = resolveAlias(cleaned);
    if (hit) matched.set(hit.displayName, hit);
    else unmatched.push(cleaned);
  }

  const zipSet = new Set<string>();
  for (const area of matched.values()) {
    for (const z of area.zips) zipSet.add(z);
  }

  return {
    zips: Array.from(zipSet),
    matched: Array.from(matched.values()),
    unmatched,
  };
}

/**
 * Find which AreaAlias (if any) the given ZIP code belongs to. Useful for
 * labeling ZIP-level selections with a friendly city name.
 */
export function findAreaForZip(zip: string): AreaAlias | null {
  for (const area of AREA_ALIASES) {
    if (area.zips.includes(zip)) return area;
  }
  return null;
}