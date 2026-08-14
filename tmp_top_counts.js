const fs = require('fs');
const zlib = require('zlib');
function top(field) {
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const raw = zlib.gunzipSync(fs.readFileSync(`public/cache/master_cache_chunk_${i}.json.gz`)).toString('utf8');
    const parsed = JSON.parse(raw);
    const header = parsed.header;
    const r = parsed.rows;
    const idx = header.indexOf(field);
    for (const row of r) rows.push(row[idx]);
  }
  const map = {};
  for (const k of rows) {
    if (!k) continue;
    map[k] = (map[k] || 0) + 1;
  }
  const arr = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(field, arr);
}
for (const f of ['zipcodes', 'highschools', 'elementary', 'middle']) top(f);
