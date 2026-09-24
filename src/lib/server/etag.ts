/**
 * etag.ts — helpers for HTTP conditional requests (ETag / If-None-Match).
 *
 * Generates a short, stable ETag from the request body plus the current dataset
 * version. The browser caches the response and revalidates on every request.
 * When nothing changed, the server replies 304 Not Modified with an empty
 * body, avoiding the transfer of large JSON payloads.
 */
import { createHash } from 'crypto';
import { NextResponse } from 'next/server';

const ETAG_LENGTH = 32;

/** Build a strong ETag string from a request payload + dataset version. */
export function generateETag(body: unknown, datasetVersion: string): string {
  const payload = JSON.stringify(body) + '::' + datasetVersion;
  const hash = createHash('sha256').update(payload).digest('hex');
  return `"${hash.slice(0, ETAG_LENGTH)}"`;
}

/** Read the ETag the browser sent for revalidation. */
export function getClientETag(req: Request): string | null {
  return req.headers.get('if-none-match');
}

/** True when the client already has the current version of the response. */
export function isMatch(req: Request, etag: string): boolean {
  return getClientETag(req) === etag;
}

/** 304 Not Modified response with the current ETag. */
export function notModifiedResponse(etag: string): NextResponse {
  return new NextResponse(null, {
    status: 304,
    headers: {
      ETag: etag,
      'Cache-Control': 'private, must-revalidate',
    },
  });
}

/** Attach ETag and revalidation cache headers to a JSON response. */
export function withETag<T>(body: T, etag: string): NextResponse<T> {
  const res = NextResponse.json(body);
  res.headers.set('ETag', etag);
  res.headers.set('Cache-Control', 'private, must-revalidate');
  return res;
}
