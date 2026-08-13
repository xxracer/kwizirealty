const fs = require('fs');
const path = require('path');
const proj4 = require('proj4');

// EPSG:3857 to EPSG:4326
const fromProj = 'EPSG:3857';
const toProj = 'EPSG:4326';

function transformCoords(coords) {
    if (typeof coords[0] === 'number') {
        const [x, y] = coords;
        const [lng, lat] = proj4(fromProj, toProj, [x, y]);
        return [lng, lat];
    }
    return coords.map(transformCoords);
}

const csvDir = path.join(__dirname, 'public', 'csv');
const files = fs.readdirSync(csvDir).filter(f => f.endsWith('.geojson'));

console.log('Found geojson files:', files);

files.forEach(file => {
    const filePath = path.join(csvDir, file);
    console.log(`Processing ${file}...`);
    
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch(e) {
        console.error('Error reading file', e);
        return;
    }
    
    let data;
    try {
        data = JSON.parse(raw);
    } catch(e) {
        console.error('Error parsing JSON for', file, e);
        return;
    }
    
    // Check if it's actually 3857 or not by checking CRS or just looking at coords
    // If coords are huge (>1000) it's likely 3857.
    let needsConversion = false;
    
    if (data.crs && data.crs.properties && typeof data.crs.properties.name === 'string' && data.crs.properties.name.includes('3857')) {
        needsConversion = true;
    } else {
        // Sample a coord
        try {
            let f = data.features[0];
            let c = f.geometry.coordinates;
            while(typeof c[0] !== 'number') { c = c[0]; }
            if (Math.abs(c[0]) > 1000) {
                needsConversion = true;
            }
        } catch(e) {}
    }
    
    if (!needsConversion) {
        console.log(`  Skipping ${file}, likely already EPSG:4326`);
        return;
    }
    
    console.log(`  Converting ${file} to EPSG:4326...`);
    
    data.features.forEach(feature => {
        if (feature.geometry && feature.geometry.coordinates) {
            feature.geometry.coordinates = transformCoords(feature.geometry.coordinates);
        }
    });
    
    // Remove the old crs property to default to 4326
    delete data.crs;
    
    fs.writeFileSync(filePath, JSON.stringify(data));
    console.log(`  Saved ${file}`);
});
console.log('Done.');
