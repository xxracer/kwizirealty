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
    const sa = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(fs.readFileSync(raw, 'utf8'));
    credential = cert(sa);
  }
  // Without a service account, firebase-admin falls back to Application
  // Default Credentials (GOOGLE_APPLICATION_CREDENTIALS / metadata server).
  adminApp = initializeApp({ credential });
  return adminApp;
}

let dc: DataConnect | null = null;

export function getAdminDataConnect(): DataConnect {
  if (dc) return dc;
  dc = getDataConnect(
    {
      location: process.env.DATACONNECT_LOCATION || 'us-central1',
      serviceId: process.env.DATACONNECT_SERVICE_ID || 'kwizi-sql',
      connector: process.env.DATACONNECT_CONNECTOR || 'default',
    },
    getAdminApp()
  );
  return dc;
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}
