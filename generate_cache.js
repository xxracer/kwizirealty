const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MANIFEST_PATH = path.join(PUBLIC_DIR, 'csv', 'property-manifest.json');
const OUTPUT_PATH = path.join(PUBLIC_DIR, 'csv', 'master_cache.csv');

function cleanNumber(val) {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return isFinite(val) ? val : 0;
  const cleaned = String(val).replace(/[^0-9.\-]+/g, '');
  const n = Number(cleaned);
  return isFinite(n) ? n : 0;
}

function cleanDate(raw) {
  if (!raw) return { date: '', year: 0, ts: 0 };
  const parts = String(raw).split('/');
  if (parts.length === 3) {
    const y = parseInt(parts[2], 10);
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    const year = isFinite(y) ? y : 0;
    const ts = year && m && d ? new Date(year, m - 1, d).getTime() : 0;
    return { date: raw, year, ts };
  }
  return { date: String(raw), year: 0, ts: 0 };
}

function cleanBool(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1' || v === 'y';
}

function cleanBoundaryName(raw) {
  const v = String(raw || '').toUpperCase().trim();
  if (!v || v === 'NA' || v === 'N/A' || v === 'NONE' || v === 'NULL' || v === 'UNKNOWN' || v === 'UNINCORPORATED') return '';
  return v
    .replace(/\s+/g, ' ')
    .replace(/\b(WLDS|WLDNGS|WLNDS)\b/g, 'WOODLANDS')
    .replace(/\b(VLG|VILL|VILLG|VILLAS)\b/g, 'VILLAGE')
    .replace(/\b(EST|ESTS)\b/g, 'ESTATES')
    .replace(/\b(PL|PLAT)\b/g, 'PLACE')
    .replace(/\b(CRE|CRK)\b/g, 'CREEK')
    .replace(/\b(MEADOWS|MEADOW)\b/g, 'MDW')
    .replace(/\b(RANCH|RNCH)\b/g, 'RNCH')
    .replace(/\bGROVE\b/g, 'GRV')
    .replace(/\bHEIGHTS\b/g, 'HTS')
    .replace(/\bSTATION\b/g, 'STA')
    .replace(/\bNORTH\b/g, 'N')
    .replace(/\bSOUTH\b/g, 'S')
    .replace(/\bEAST\b/g, 'E')
    .replace(/\bWEST\b/g, 'W')
    .replace(/\bAT\b/g, '@')
    .replace(/\bOF\b/g, 'OF')
    .replace(/\bTHE\b/g, 'THE')
    .trim();
}

function cleanDistrictCode(raw) {
  const v = String(raw || '').trim();
  if (!v || v.toUpperCase() === 'NA' || v.toUpperCase() === 'N/A') return '';
  const name = v.replace(/^\d+\s*-\s*/, '').trim();
  if (!name) return '';
  if (/ISD$/i.test(name) || /SCHOOL\s+DISTRICT$/i.test(name)) {
    return cleanBoundaryName(name);
  }
  return cleanBoundaryName(name + ' Independent School District');
}

async function run() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('Manifest not found:', MANIFEST_PATH);
    return;
  }

  const urls = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const allData = [];
  const zipSet = new Set();
  
  let processedFiles = 0;

  for (const url of urls) {
    // Determine type
    const lower = url.toLowerCase();
    const isSale = lower.includes('sale') && !lower.includes('current');
    const isRent = lower.includes('rent') && !lower.includes('current');
    const isCurrentSale = lower.includes('current for sale');
    const isCurrentRent = lower.includes('current for rent');
    const type = isSale ? 'sale' : isRent ? 'rent' : isCurrentSale ? 'current-sale' : isCurrentRent ? 'current-rent' : 'unknown';

    if (type === 'unknown') continue;

    const fullPath = path.join(PUBLIC_DIR, url.replace(/^\//, ''));
    if (!fs.existsSync(fullPath)) {
      console.warn('File not found:', fullPath);
      continue;
    }

    const csvText = fs.readFileSync(fullPath, 'utf8');
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    
    for (const row of parsed.data) {
      const zip = String(row['Zip'] || '').trim();
      const lat = cleanNumber(row['Latitude']);
      const lng = cleanNumber(row['Longitude']);
      const price = cleanNumber(row['Close Price'] || row['List Price'] || row['Original List Price']);

      if (!zip || lat === 0 || lng === 0 || price === 0) {
        continue; // missing coordinates, zip, or price
      }

      zipSet.add(zip);

      const dDOM = cleanDate(row['Close Date']);
      const item = {
        mlsNumber: String(row['MLS Number'] || '').trim(),
        address: String(row['Address'] || '').trim(),
        zip,
        lat,
        lng,
        propertyType: String(row['Property Type'] || '').trim(),
        subdivisions: cleanBoundaryName(row['Subdivision']),
        marketArea: cleanBoundaryName(row['Market Area']),
        schoolDistrict: cleanDistrictCode(row['School District']),
        elementary: cleanBoundaryName(row['Elementary School']),
        middle: cleanBoundaryName(row['Middle School']),
        highschools: cleanBoundaryName(row['High School']),
        beds: cleanNumber(row['Bedrooms']),
        baths: cleanNumber(row['Baths Total'] || row['Baths']),
        sqft: cleanNumber(row['Building SqFt'] || row['SqFt Total']),
        lotSize: cleanNumber(row['Lot Size']),
        yearBuilt: cleanNumber(row['Year Built']),
        pool: cleanBool(row['Private Pool']),
        dom: cleanNumber(row['DOM']),
        cdom: cleanNumber(row['CDOM']),
        closeDate: dDOM.date,
        closeDateTs: dDOM.ts,
        closeDateYear: dDOM.year,
        closePrice: cleanNumber(row['Close Price']),
        listPrice: cleanNumber(row['List Price']),
        originalListPrice: cleanNumber(row['Original List Price']),
        estRentalPrice: cleanNumber(row['Est. Rental Price']),
        annualHOAFee: cleanNumber(row['Maintenance Fee']),
        taxAmount: cleanNumber(row['Tax Amount']),
        taxRate: cleanNumber(row['Tax Rate']),
        taxYear: cleanNumber(row['Tax Year']),
        status: String(row['Status'] || '').trim(),
        type,
        // Optional
        area: String(row['Area'] || '').trim(),
      };

      allData.push(item);
    }
    
    processedFiles++;
    console.log(`Processed ${processedFiles}/${urls.length}: ${url}`);
  }

  // Handle property-manifest.json duplicate handling logic
  // We keep the last one seen if mlsNumber is identical
  const uniqueMap = new Map();
  for (const item of allData) {
    const k = item.mlsNumber || `${item.address}|${item.zip}`;
    uniqueMap.set(k, item);
  }

  const finalData = Array.from(uniqueMap.values());
  const csvContent = Papa.unparse(finalData);

  fs.writeFileSync(OUTPUT_PATH, csvContent);
  console.log(`Successfully generated master_cache.csv with ${finalData.length} unique properties!`);
}

run().catch(console.error);
