'use client';

import { useState } from 'react';
import { cmsStore, CMSFileRecord, CMSFileCategory } from '@/lib/cmsStore';
import { collection, getDocs } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { db, storage } from '@/lib/firebase';
import { RequireAdmin } from '@/components/RequireAuth';

export default function MigrationPage() {
  return (
    <RequireAdmin>
      <MigrationPageInner />
    </RequireAdmin>
  );
}

function MigrationPageInner() {
  const [status, setStatus] = useState<string>('Ready to migrate local files to Firebase');
  const [progress, setProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [isMigrating, setIsMigrating] = useState(false);
  const [isWiping, setIsWiping] = useState(false);

  const wipeAllData = async () => {
    if (!confirm('Are you ABSOLUTELY sure you want to delete ALL data from Firebase (Firestore and Storage)? This cannot be undone.')) return;
    
    setIsWiping(true);
    setStatus('Fetching list of files to delete...');
    try {
      const querySnapshot = await getDocs(collection(db, 'cms_files'));
      const docs = querySnapshot.docs;
      
      setProgress({ current: 0, total: docs.length });
      
      for (let i = 0; i < docs.length; i++) {
        setStatus(`Deleting ${docs[i].data().name}...`);
        await cmsStore.removeFile(docs[i].id);
        setProgress((prev) => ({ ...prev, current: i + 1 }));
      }
      
      setStatus('Deleting master_cache.csv...');
      try {
        await deleteObject(ref(storage, 'cms_files/master_cache.csv'));
      } catch (err) {
        // Might not exist, ignore
      }
      
      setStatus('All data successfully wiped from Firebase. You can now start a fresh migration.');
    } catch (err: any) {
      console.error(err);
      setStatus(`Error wiping data: ${err.message}`);
    } finally {
      setIsWiping(false);
    }
  };

  const startMigration = async () => {
    setIsMigrating(true);
    setStatus('Fetching manifest...');
    try {
      const res = await fetch('/csv/property-manifest.json?t=' + Date.now());
      if (!res.ok) throw new Error('Could not fetch manifest');
      const urls: string[] = await res.json();
      
      // Also include the local GeoJSON files
      const geojsonFiles = [
        '/csv/Elementary School ISD.geojson',
        '/csv/Houston_ISD.geojson',
        '/csv/Mapped Subdivisions.geojson',
        '/csv/Middle School ISD.geojson',
        '/csv/Zip.geojson'
      ];
      urls.push(...geojsonFiles);
      
      setProgress({ current: 0, total: urls.length });

      // Fetch existing file names directly from Firestore to avoid downloading full CSV contents
      setStatus('Checking existing files in Firebase...');
      const querySnapshot = await getDocs(collection(db, 'cms_files'));
      const existingFileNames = new Set(querySnapshot.docs.map(d => d.data().name));

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        // Extract filename preserving folder structure but removing /csv/ prefix
        const decodedUrl = decodeURIComponent(url);
        const fileName = decodedUrl.startsWith('/csv/') ? decodedUrl.replace('/csv/', '') : decodedUrl;
        
        if (existingFileNames.has(fileName)) {
          console.log(`Skipping ${fileName}, already exists in Firebase.`);
          setProgress((prev) => ({ ...prev, current: i + 1 }));
          continue;
        }

        setStatus(`Migrating ${fileName}...`);

        // Determine category
        const parts = url.toLowerCase().split('/');
        let category: CMSFileCategory = 'property';
        for (let j = parts.length - 1; j >= 0; j--) {
          const part = parts[j];
          if (part.endsWith('.geojson') || part.endsWith('.json')) { category = 'boundary'; break; }
          if (part.includes('tax')) { category = 'tax'; break; }
          if (part.includes('current for rent')) { category = 'current-rent'; break; }
          if (part.includes('current for sale')) { category = 'current-sale'; break; }
          if (part.includes('rent')) { category = 'rent'; break; }
          if (part.includes('sale')) { category = 'sales'; break; }
          if (part.includes('elem')) { category = 'school-elementary'; break; }
          if (part.includes('middle')) { category = 'school-middle'; break; }
          if (part.includes('high')) { category = 'school-high'; break; }
        }

        // Fetch CSV content
        const fileRes = await fetch(url);
        if (!fileRes.ok) {
          console.warn(`Could not fetch ${url}`);
          setProgress((prev) => ({ ...prev, current: i + 1 }));
          continue;
        }
        const text = await fileRes.text();

        // Save to Firebase
        const record: CMSFileRecord = {
          id: `migrated-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: fileName,
          size: new Blob([text]).size,
          category,
          rows: [], // We use rawContent for speed so PapaParse isn't needed during migration
          headers: [],
          uploadedAt: Date.now(),
          source: 'manual',
          rawContent: text,
        };

        await cmsStore.saveFile(record);
        setProgress((prev) => ({ ...prev, current: i + 1 }));
      }

      setStatus('Migration complete! Local files have been successfully uploaded to Firebase.');
      
    } catch (err: any) {
      console.error(err);
      setStatus(`Error during migration: ${err.message}`);
    } finally {
      setIsMigrating(false);
    }
  };

  return (
    <div className="p-8 max-w-2xl mx-auto bg-neutral-900 text-white min-h-screen">
      <h1 className="text-2xl font-bold mb-4">Local to Firebase Migration</h1>
      <p className="mb-6 text-gray-400">
        This tool will read all CSVs from your local <code>public/csv/property-manifest.json</code> and upload them directly to Firebase Storage using the proper folder structure.
      </p>
      
      <div className="mb-6 p-4 bg-neutral-800 rounded-lg">
        <p className="font-mono text-sm mb-2">Status: {status}</p>
        {progress.total > 0 && (
          <div className="w-full bg-neutral-700 h-2 rounded-full overflow-hidden">
            <div 
              className="bg-emerald-500 h-full transition-all duration-300"
              style={{ width: `${(progress.current / progress.total) * 100}%` }}
            />
          </div>
        )}
        {progress.total > 0 && (
          <p className="text-xs text-gray-500 mt-2 text-right">
            {progress.current} / {progress.total}
          </p>
        )}
      </div>

      <div className="flex gap-4">
        <button
          onClick={startMigration}
          disabled={isMigrating || isWiping}
          className="px-6 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
        >
          {isMigrating ? 'Migrating...' : 'Start Migration'}
        </button>
        
        <button
          onClick={wipeAllData}
          disabled={isMigrating || isWiping}
          className="px-6 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
        >
          {isWiping ? 'Wiping Data...' : 'Wipe Firebase Data'}
        </button>
      </div>
    </div>
  );
}
