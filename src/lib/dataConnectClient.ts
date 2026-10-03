/**
 * Browser-side Firebase Data Connect client for direct SQL operations.
 *
 * Property CSV imports bypass Vercel serverless entirely: parsed rows are
 * upserted directly into the Data Connect `properties` table. Each upload is
 * tagged with `uploadSessionId`; rows stay invisible to the map until the user
 * clicks "Add All", which calls commitPendingProperties(). If the page is
 * reloaded before committing, clearPendingProperties() deletes the staged rows.
 *
 * NOTE: we call the Data Connect REST API directly rather than using the
 * `executeMutation`/`executeQuery` helpers from the JS SDK. The SDK was returning
 * UNAUTHENTICATED (401) because it was not attaching the Firebase Auth ID token
 * to requests even when the admin user was signed in. By manually attaching
 * `Authorization: Bearer <idToken>` we keep the browser-to-SQL path while
 * honoring the connector's `authMode: USER`.
 */
import { app, auth } from './firebase';

const connectorConfig = {
  location: process.env.NEXT_PUBLIC_DATACONNECT_LOCATION || 'us-central1',
  connector: process.env.NEXT_PUBLIC_DATACONNECT_CONNECTOR || 'default',
  service: process.env.NEXT_PUBLIC_DATACONNECT_SERVICE_ID || 'kwizi-sql',
};

const projectId =
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
  app.options.projectId;

const CLIENT_BATCH = 500;

/** Web API key of the project — what makes an unsigned (anonymous) request a
 *  valid one, exactly like the Firebase JS SDK does. Without it Google rejects
 *  the call with "Expected OAuth 2 access token, login cookie or other valid
 *  authentication credential" (seen when a fresh browser with no signed-in
 *  session tries to upload). */
const apiKey =
  app.options.apiKey || process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '';

function connectorName(): string {
  return `projects/${projectId}/locations/${connectorConfig.location}/services/${connectorConfig.service}/connectors/${connectorConfig.connector}`;
}

/** Token cache — `getIdToken(true)` FORCES a network refresh, and the staging
 *  loop calls dataConnectFetch once per 500-row batch. Forcing a refresh per
 *  batch hammered Google's token endpoint until it answered with
 *  `auth/quota-exceeded` (daily/rolling STS quota). Cache the token per signed-in
 *  user for ~45 min; the SDK itself keeps it current without forcing. */
let cachedToken: string | null = null;
let cachedTokenUid = '';
let cachedTokenAt = 0;
const TOKEN_TTL_MS = 45 * 60 * 1000;
/** Flipped when Google rejects the stored session — later calls go straight to
 *  the anonymous API-key path instead of paying a rejected request first. */
let sessionRejected = false;

async function getIdToken(): Promise<string | null> {
  // Auth is currently OFF in this app (anyone can use the admin page), and the
  // staging ops are @auth(level: PUBLIC), so a signed-in user is optional. When
  // a session exists we still attach its token — the day auth is switched back
  // on these ops go to USER again and this code keeps working unchanged.
  // A session whose stored credential no longer refreshes (e.g. a leftover
  // login from before the auth-flow changes) must NOT break uploads: it falls
  // back to the anonymous API-key path instead of throwing.
  try {
    await auth.authStateReady();
    const user = auth.currentUser;
    if (!user) {
      if (!sessionRejected) console.log('[dataConnect] no signed-in user — calling PUBLIC ops anonymously');
      return null;
    }
    if (sessionRejected) {
      console.log('[dataConnect] stored session already rejected by Google — calling PUBLIC ops anonymously');
      return null;
    }
    if (cachedToken && cachedTokenUid === user.uid && Date.now() - cachedTokenAt < TOKEN_TTL_MS) {
      return cachedToken;
    }
    const token = await user.getIdToken(false);
    cachedToken = token;
    cachedTokenUid = user.uid;
    cachedTokenAt = Date.now();
    console.log('[dataConnect] auth ok:', user.email);
    return token;
  } catch (err) {
    console.warn('[dataConnect] session token unavailable — falling back to API key:', (err as Error)?.message);
    cachedToken = null;
    return null;
  }
}

async function dataConnectFetch<T>(
  method: 'executeMutation' | 'executeQuery',
  operationName: string,
  payload: Record<string, unknown>
): Promise<{ data?: T }> {
  const token = await getIdToken();
  const name = connectorName();
  const url = `https://firebasedataconnect.googleapis.com/v1beta/${name}:${method}`;

  // Per the Data Connect REST reference: both executeQuery and executeMutation
  // take { operationName, variables }; the connector resource name lives in the
  // URL, not the body. Variables use the protobuf Struct JSON mapping.
  const body = { operationName, variables: payload };

  const send = async (credential: 'token' | 'apiKey'): Promise<Response> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (credential === 'token' && token) {
      headers.Authorization = `Bearer ${token}`;
    } else {
      // Anonymous request to a @auth(level: PUBLIC) op: sign it with the web API
      // key — same credential the Firebase JS SDK attaches. No key = Google's
      // "invalid authentication credentials" rejection.
      headers['x-goog-api-key'] = apiKey;
    }
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  };

  let res = await send(token ? 'token' : 'apiKey');

  // A stored session Google no longer accepts (stale login from before the
  // auth-flow changes) is rejected exactly like NO credential at all. Retry
  // once with the API key — the browser-facing ops are @auth(level: PUBLIC),
  // so the anonymous retry is always valid.
  if (!res.ok && token) {
    let detailMessage = '';
    try {
      const detail: any = await res.json();
      detailMessage = String(detail?.error?.message ?? detail ?? '');
    } catch {
      // fall through with an empty message
    }
    const retriable =
      res.status === 401 ||
      res.status === 403 ||
      /invalid authentication credentials/i.test(detailMessage);
    if (retriable) {
      console.warn('[dataConnect] stored session rejected — retrying anonymously with the API key');
      sessionRejected = true; // skip the dead token from the next batches on
      cachedToken = null;
      res = await send('apiKey');
    }
  }

  if (!res.ok) {
    let detail: any;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    const message =
      (detail?.error?.message) ||
      (typeof detail === 'string' ? detail : `Data Connect ${res.status}`);
    throw new Error(`Data Connect ${operationName} failed: ${message}`);
  }

  const json = await res.json();
  // GraphQL-style responses carry errors even on HTTP 200.
  if (json.errors?.length) {
    const first = json.errors[0];
    throw new Error(`Data Connect ${operationName} failed: ${first.message || JSON.stringify(first)}`);
  }
  return json;
}

/**
 * Upsert property rows in batches, tagging them with the upload session id.
 * Uses the custom `stagePropertyRows` mutation that performs a Postgres
 * bulk INSERT ... ON CONFLICT from a JSON array string. Data Connect does
 * not provide an auto-generated `upsertMany`, so this SQL bypass avoids
 * thousands of single-row round trips.
 */
export async function stagePropertyRows(
  rows: Record<string, unknown>[],
  onProgress?: (done: number) => void
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CLIENT_BATCH) {
    const batch = rows.slice(i, i + CLIENT_BATCH);
    const now = new Date().toISOString();
    // Int64 must be passed as a string to stay inside Data Connect's safe range.
    const normalized = batch.map((r) => ({
      ...r,
      closeDateTs: r.closeDateTs != null ? String(r.closeDateTs) : r.closeDateTs,
      updatedAt: r.updatedAt ?? now,
    }));
    await dataConnectFetch('executeMutation', 'stagePropertyRows', { rows: JSON.stringify(normalized) });
    inserted += batch.length;
    onProgress?.(inserted);
  }
  return inserted;
}

/**
 * Promote all staged rows to committed (visible to the map).
 */
export async function commitPendingProperties(): Promise<void> {
  await dataConnectFetch('executeMutation', 'commitPendingProperties', {});
}

/**
 * Copy each property's latest tax record (listing_type='tax' bucket) onto its
 * sale rows so the report panel and the tax map metric see real tax data.
 * Idempotent — safe to call after every commit that touched tax or sale rows.
 */
export async function mergeTaxIntoSaleRows(): Promise<void> {
  await dataConnectFetch('executeMutation', 'mergeTaxIntoSaleRows', {});
}

/**
 * Promote one upload session to committed.
 */
export async function commitPendingSession(sessionId: string): Promise<void> {
  await dataConnectFetch('executeMutation', 'commitPendingSession', { sessionId });
}

/**
 * Delete every staged row. Called automatically on page mount to clean up
 * uploads that were never committed before a refresh.
 */
export async function clearPendingProperties(): Promise<void> {
  await dataConnectFetch('executeMutation', 'clearPendingProperties', {});
}

/**
 * Delete a single upload session (used when the user discards one file before
 * committing the rest).
 */
export async function deletePendingSession(sessionId: string): Promise<void> {
  await dataConnectFetch('executeMutation', 'deletePendingSession', { sessionId });
}

/**
 * Return the current committed row count from SQL. Excludes staged rows.
 */
export async function countCommittedProperties(): Promise<number> {
  const res = await dataConnectFetch<{ values: { total_rows: number } }>('executeQuery', 'distinctValues', {});
  return Number(res.data?.values?.total_rows ?? 0);
}
