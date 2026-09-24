/**
 * Browser-side Firebase Data Connect client for direct SQL operations.
 *
 * Property CSV imports bypass Vercel serverless entirely: parsed rows are
 * upserted directly into the Data Connect `properties` table. Each upload is
 * tagged with `uploadSessionId`; rows stay invisible to the map until the user
 * clicks "Add All", which calls commitPendingProperties(). If the page is
 * reloaded before committing, clearPendingProperties() deletes the staged rows.
 */
import { app } from './firebase';
import {
  getDataConnect,
  executeMutation,
  executeQuery,
  mutationRef,
  queryRef,
  type DataConnect,
  type MutationRef,
} from 'firebase/data-connect';

const connectorConfig = {
  location: process.env.NEXT_PUBLIC_DATACONNECT_LOCATION || 'us-central1',
  connector: process.env.NEXT_PUBLIC_DATACONNECT_CONNECTOR || 'default',
  service: process.env.NEXT_PUBLIC_DATACONNECT_SERVICE_ID || 'kwizi-sql',
};

let dc: DataConnect | null = null;

export function getClientDataConnect(): DataConnect {
  if (!dc) {
    dc = getDataConnect(app, connectorConfig);
  }
  return dc;
}

function mut(name: string, variables?: Record<string, unknown>): MutationRef<any, any> {
  return mutationRef(getClientDataConnect(), name, variables ?? {});
}

const CLIENT_BATCH = 500;

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
  const dc = getClientDataConnect();
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
    const ref = mutationRef(dc, 'stagePropertyRows', { rows: JSON.stringify(normalized) });
    await executeMutation(ref);
    inserted += batch.length;
    onProgress?.(inserted);
  }
  return inserted;
}

/**
 * Promote all staged rows to committed (visible to the map).
 */
export async function commitPendingProperties(): Promise<void> {
  await executeMutation(mut('commitPendingProperties'));
}

/**
 * Promote one upload session to committed.
 */
export async function commitPendingSession(sessionId: string): Promise<void> {
  await executeMutation(mut('commitPendingSession', { sessionId }));
}

/**
 * Delete every staged row. Called automatically on page mount to clean up
 * uploads that were never committed before a refresh.
 */
export async function clearPendingProperties(): Promise<void> {
  await executeMutation(mut('clearPendingProperties'));
}

/**
 * Delete a single upload session (used when the user discards one file before
 * committing the rest).
 */
export async function deletePendingSession(sessionId: string): Promise<void> {
  await executeMutation(mut('deletePendingSession', { sessionId }));
}

/**
 * Return the current committed row count from SQL. Excludes staged rows.
 */
export async function countCommittedProperties(): Promise<number> {
  const ref = queryRef(getClientDataConnect(), 'distinctValues', {});
  const res = await executeQuery(ref);
  const values = (res.data as any)?.values;
  return Number(values?.total_rows ?? 0);
}
