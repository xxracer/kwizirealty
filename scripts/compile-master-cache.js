const { initializeApp } = require('firebase/app');
const { getStorage, ref, listAll, getDownloadURL, uploadBytes } = require('firebase/storage');
const fs = require('fs');
const Papa = require('papaparse');
const config = require('../src/lib/firebase-config-script.js');

const app = initializeApp(config);
const storage = getStorage(app);

async function compileCache() {
  console.log('Fetching file list from Firebase Storage...');
  async function listAllRecursive(directoryRef) {
    let allItems = [];
    const res = await listAll(directoryRef);
    allItems.push(...res.items);
    for (const folderRef of res.prefixes) {
      const nestedItems = await listAllRecursive(folderRef);
      allItems.push(...nestedItems);
    }
    return allItems;
  }

  const listRef = ref(storage, 'cms_files/');
  const items = await listAllRecursive(listRef);
  const csvRefs = items.filter(item => item.name.endsWith('.csv') && !item.name.includes('master_cache.csv'));
  console.log('Found', csvRefs.length, 'CSV files.');

  let allData = [];
  let header = null;

  for (let i = 0; i < csvRefs.length; i++) {
    const itemRef = csvRefs[i];
    console.log(`Downloading ${i+1}/${csvRefs.length}: ${itemRef.name}`);
    const url = await getDownloadURL(itemRef);
    const fetchRes = await fetch(url);
    const text = await fetchRes.text();
    
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    if (parsed.data.length > 0) {
      if (!header) header = Object.keys(parsed.data[0]);
      allData = allData.concat(parsed.data);
    }
  }

  console.log('Total rows combined:', allData.length);
  if (allData.length === 0) return console.log('No data to compile.');

  console.log('Generating master_cache.csv...');
  const csvText = Papa.unparse(allData, { quotes: true });
  
  const blob = new Blob([csvText], { type: 'text/csv' });
  const masterRef = ref(storage, 'cms_files/master_cache.csv');
  
  console.log('Uploading master_cache.csv to Firebase...');
  await uploadBytes(masterRef, blob);
  console.log('Done!');
}

compileCache().catch(console.error);