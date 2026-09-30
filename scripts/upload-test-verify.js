/** Final check: datasetStatus + per-year/type mix after the upload tests. */
const fs = require('fs');
const KEY = fs
  .readFileSync(`${__dirname}/../.env.local`, 'utf8')
  .split('\n')
  .find((l) => l.startsWith('NEXT_PUBLIC_FIREBASE_API_KEY'))
  .split('=')[1]
  .replace(/"/g, '')
  .trim();
const url =
  'https://firebasedataconnect.googleapis.com/v1beta/projects/myreatstat/locations/us-central1/services/kwizi-sql/connectors/default:executeQuery';
async function q(op) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({ operationName: op, variables: {} }),
  });
  const j = await res.json();
  return j?.data?.status ?? j?.data?.rows;
}
(async () => {
  console.log('datasetStatus:', JSON.stringify(await q('datasetStatus')));
  console.log('rowMixByYear :', JSON.stringify(await q('rowMixByYear')));
  console.log('rowMixSaleMix:', JSON.stringify(await q('rowMixSaleMix')));
})();