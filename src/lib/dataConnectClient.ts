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
import { onAuthStateChanged, type User } from 'firebase/auth';

const connectorConfig = {
  location: process.env.NEXT_PUBLIC_DATACONNECT_LOCATION || 'us-central1',
  connector: process.env.NEXT_PUBLIC_DATACONNECT_CONNECTOR || 'default',
  service: process.env.NEXT_PUBLIC_DATACONNECT_SERVICE_ID || 'kwizi-sql',
};

const projectId =
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
  app.options.projectId;

const CLIENT_BATCH = 500;

function connectorName(): string {
  return `projects/${projectId}/locations/${connectorConfig.location}/services/${connectorConfig.service}/connectors/${connectorConfig.connector}`;
}

async function getIdToken(): Promise<string> {
  // Auth state is restored asynchronously after a page reload. Wait until it is
  // settled before reading currentUser, otherwise all Data Connect calls fail
  // with UNAUTHENTICATED even though the admin user is logged in.
  const settledUser = await new Promise<User | null>(
    (resolve) => {
      if (auth.currentUser) {
        resolve(auth.currentUser);
        return;
      }
      const unsub = onAuthStateChanged(auth, (user) => {
        if (user) {
          unsub();
          resolve(user);
        }
      });
      // Safety cap: if auth never settles after a few seconds, fall back so the
      // caller gets a clear "not signed in" error instead of hanging forever.
      setTimeout(() => {
        unsub();
        resolve(auth.currentUser);
      }, 3000);
    }
  );
  const user = settledUser;
  if (!user) {
    throw new Error('You must be signed in to upload data to the database.');
  }
  return user.getIdToken(true);
}

async function dataConnectFetch<T>(
  method: 'executeMutation' | 'executeQuery',
  operationName: string,
  payload: Record<string, unknown>
): Promise<{ data?: T }> {
  const token = await getIdToken();
  const name = `${connectorName()}/${method === 'executeMutation' ? 'mutations' : 'queries'}/${operationName}`;
  const url = `https://firebasedataconnect.googleapis.com/v1alpha/${connectorName()}:${method}`;

  const body =
    method === 'executeMutation'
      ? { name, operationName, arguments: payload }
      : { name, operationName, variables: payload };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

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

  return res.json();
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
