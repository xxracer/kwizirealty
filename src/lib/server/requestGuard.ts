/**
 * requestGuard — lightweight protection for the public SQL read endpoints.
 *
 * The map is open to signed-out visitors (the admin login gate is optional),
 * so /api/query, /api/sql/distinct and /api/search cannot require a Firebase
 * ID token. Instead every request must be same-origin (browser-only callers)
 * and is rate-limited per client IP in a small in-memory window map. This is
 * deliberately dependency-free: the endpoints only serve aggregate data.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;
/** Cap the tracker so a spoofed IP flood cannot grow it unbounded. */
const MAX_TRACKED_IPS = 10_000;

const hits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

/** True when the request plausibly comes from our own frontend. */
export function isSameOrigin(req: Request): boolean {
  const host = req.headers.get('host');
  if (!host) return false;
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  // Non-browser clients (curl, cron) send no Origin; accept a matching Referer
  // or nothing at all — rate limiting is the real protection there.
  const referer = req.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch {
      return false;
    }
  }
  return true;
}

/** Returns false when the request should be rejected with 429. */
export function checkRateLimit(req: Request): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  if (hits.size > MAX_TRACKED_IPS) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
    if (hits.size > MAX_TRACKED_IPS) hits.clear();
  }
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_REQUESTS_PER_WINDOW;
}

/**
 * Combined guard for public read endpoints. Returns a 403/429 NextResponse to
 * send immediately, or null when the request may proceed.
 */
export function guardPublicRead(req: Request): Response | null {
  if (!isSameOrigin(req)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!checkRateLimit(req)) {
    return Response.json({ error: 'Too many requests' }, { status: 429 });
  }
  return null;
}