/**
 * Server-side Firebase Admin bootstrap (used by /api/query and any future
 * server route). Initializes the default admin app once and exposes the
 * Data Connect client for the SQL Connect service.
 *
 * Credentials (server env):
 *   FIREBASE_SERVICE_ACCOUNT  — JSON string of the service account key
 *                               (Vercel standard), or a path to the JSON file
 *                               (local dev).
 *   GOOGLE_APPLICATION_CREDENTIALS — path, used when the above is unset.
 *
 * Data Connect service ids (match dataconnect/dataconnect.yaml):
 *   DATACONNECT_LOCATION, DATACONNECT_SERVICE_ID, DATACONNECT_CONNECTOR
 */
import fs from 'fs';
import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getDataConnect, type DataConnect } from 'firebase-admin/data-connect';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

let adminApp: App | null = null;

function getAdminApp(): App {
  if (adminApp) return adminApp;
  const existing = getApps()[0];
  if (existing) {
    adminApp = existing;
    return existing;
  }

  let credential;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      const sa = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(fs.readFileSync(raw, 'utf8'));
      credential = cert(sa);
    } catch (err) {
      console.error('[firebaseAdmin] Failed to parse FIREBASE_SERVICE_ACCOUNT:', err);
      throw err;
    }
  }
  // Without a service account, firebase-admin falls back to Application
  // Default Credentials (GOOGLE_APPLICATION_CREDENTIALS / metadata server).
  try {
    adminApp = initializeApp({ credential });
  } catch (err) {
    console.error('[firebaseAdmin] initializeApp failed:', err);
    throw err;
  }
  return adminApp;
}

let dc: DataConnect | null = null;

export function getAdminDataConnect(): DataConnect {
  if (dc) return dc;
  dc = getDataConnect(
    {
      location: process.env.DATACONNECT_LOCATION || 'us-east4',
      serviceId: process.env.DATACONNECT_SERVICE_ID || 'resdogs-4c0ff-service',
      connector: process.env.DATACONNECT_CONNECTOR || 'default',
    },
    getAdminApp()
  );
  return dc;
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}

export function getAdminFirestore(): Firestore {
  return getFirestore(getAdminApp());
}

/** Admin Storage bucket handle (bucket id from NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET). */
/** SERVER-SIDE SQL GUARD (owner log 2026-10-15: /api/query 504 with a FIVE
 *  minute hang — a firebase-admin Data Connect fetch that never resolved;
 *  the SDK has no timeout of its own). Race the call against a deadline so
 *  a dead/hung backend connection frees the function with a clean,
 *  retry-able error instead of holding it to the 300s Fluid limit. */
export const SQL_GUARD_MS = 60_000;

export function dcWithTimeout<T>(p: Promise<T>, ms = SQL_GUARD_MS): Promise<T> {
  let killer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    killer = setTimeout(() => reject(new Error('SQL execution timed out (server-side guard)')), ms);
  });
  return Promise.race([p, deadline]).finally(() => {
    if (killer) clearTimeout(killer);
  }) as Promise<T>;
}

/** Storage guard for the query-cache read (a hung download also froze a
 *  function to the 300s limit). Returns null on timeout/error. */
export function storageWithTimeout<T>(p: Promise<T>, ms = 30_000): Promise<T> {
  return dcWithTimeout(p, ms);
}

export function getAdminStorageBucket() {
  const bucketId =
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
    `${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'myreatstat'}.appspot.com`;
  return getStorage(getAdminApp()).bucket(bucketId);
}
