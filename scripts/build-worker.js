/**
 * Precompile the aggregation Web Worker for the browser.
 *
 * Turbopack's production build treats `new URL('./aggregateWorker.ts',
 * import.meta.url)` as a static asset (it copies the raw TypeScript instead of
 * bundling it), so the worker script is bundled ahead of time with esbuild
 * into public/workers/aggregateWorker.js and loaded by client.ts from that
 * fixed URL in both dev and production.
 *
 * Runs as part of `npm run dev` and `npm run build` (prebuild) — the bundle is
 * rebuilt from source on every start, so it can never go stale.
 */
const esbuild = require('esbuild');
const path = require('path');

const root = __dirname;
const entry = path.join(root, '..', 'src', 'lib', 'engineWorker', 'aggregateWorker.ts');
const outfile = path.join(root, '..', 'public', 'workers', 'aggregateWorker.js');

esbuild
  .build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    target: ['es2020'],
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  })
  .then(() => {
    console.log('[build-worker] aggregateWorker bundled → public/workers/aggregateWorker.js');
  })
  .catch((err) => {
    console.error('[build-worker] failed:', err);
    process.exit(1);
  });