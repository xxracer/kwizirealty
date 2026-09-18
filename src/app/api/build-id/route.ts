export const dynamic = 'force-dynamic';

/**
 * Deployment watchdog endpoint. Returns the deployment this request is being
 * SERVED by (Vercel routes every request to the current production
 * deployment, even when the page that made the request belongs to an older
 * one). The map page compares this against the deployment its own JS bundle
 * was built in and auto-reloads once when they differ — so a new deploy
 * reaches every visitor without clearing the browser cache.
 */
export async function GET() {
  const buildId =
    process.env.VERCEL_DEPLOYMENT_ID ?? process.env.NEXT_PUBLIC_VERCEL_DEPLOYMENT_ID ?? 'local';
  return Response.json(
    { buildId },
    { headers: { 'cache-control': 'no-store, max-age=0' } }
  );
}