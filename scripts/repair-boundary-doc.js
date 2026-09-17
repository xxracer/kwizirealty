/**
 * One-off repair (2026-09-17): the client's 64MB Mapped Subdivisions.geojson
 * upload DID reach Storage (65,171,634 bytes, 4,983 features, plain JSON) but
 * the cms_files metadata doc was never updated (stale uploadedAt/size and an
 * old download token). This refreshes the doc to point at the live object.
 * Run: node scripts/repair-boundary-doc.js
 */
import fs from 'fs';
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

// Load .env.local without printing any values.
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const app = admin.initializeApp({
  credential: admin.cert(svc),
  storageBucket: svc.project_id + '.firebasestorage.app',
});
const db = getFirestore(app);
const bucket = getStorage(app).bucket();

const FILE_NAME = 'Mapped Subdivisions.geojson';
const STORAGE_PATH = `cms_files/${FILE_NAME}`;

const [files] = await bucket.getFiles({ prefix: STORAGE_PATH });
const obj = files.find((f) => f.name === STORAGE_PATH);
if (!obj) throw new Error('Storage object not found');
const [md] = await obj.getMetadata();
const token = md.metadata?.firebaseStorageDownloadTokens?.split(',').pop();
console.log('object size:', md.size, 'updated:', md.updated, 'hasToken:', !!token);

let storageUrl;
if (token) {
  storageUrl = `https://firebasestorage.googleapis.com/v0/b/${md.bucket}/o/${encodeURIComponent(STORAGE_PATH)}?alt=media&token=${token}`;
} else {
  storageUrl = `https://firebasestorage.googleapis.com/v0/b/${md.bucket}/o/${encodeURIComponent(STORAGE_PATH)}?alt=media`;
}

// Verify the URL actually serves the new object before touching the doc.
const res = await fetch(storageUrl, { method: 'GET', headers: { Range: 'bytes=0-15' } });
console.log('url check status:', res.status);
if (!res.ok) throw new Error('download URL check failed: ' + res.status);

// Find the metadata doc for this boundary file.
const snap = await db.collection('cms_files').where('category', '==', 'boundary').get();
let docId = null;
for (const d of snap.docs) {
  if (d.data().name === FILE_NAME) docId = d.id;
}
if (!docId) throw new Error('cms_files doc for ' + FILE_NAME + ' not found');

const now = Date.now();
await db.collection('cms_files').doc(docId).set(
  {
    size: Number(md.size),
    uploadedAt: now,
    storageUrl,
    storagePath: STORAGE_PATH,
    rowCount: 0,
  },
  { merge: true }
);
await db.collection('cms_meta').doc('boundaries').set(
  { authoritative: true, at: now },
  { merge: true }
);
console.log('repaired doc', docId, '-> size', md.size, 'uploadedAt', new Date(now).toISOString());
await app.delete();