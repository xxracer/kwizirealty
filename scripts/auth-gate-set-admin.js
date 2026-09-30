/**
 * Set the admin-login flag in the shared auth gate (cms_config/auth) via the
 * Firestore REST API with the local gcloud ADC credentials. One-shot op.
 */
async function getAccessToken() {
  const adcPath = `${process.env.APPDATA}/gcloud/legacy_credentials/maijelcancines2@gmail.com/adc.json`;
  const adc = require('fs').readFileSync(adcPath, 'utf8');
  const parsed = JSON.parse(adc);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: parsed.client_id,
      client_secret: parsed.client_secret,
      refresh_token: parsed.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`token refresh failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()).access_token;
}

(async () => {
  const token = await getAccessToken();
  const url =
    'https://firestore.googleapis.com/v1/projects/myreatstat/databases/(default)/documents/cms_config/auth?updateMask.fieldPaths=adminLoginRequired';
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: { adminLoginRequired: { booleanValue: true } } }),
  });
  console.log('PATCH HTTP', res.status);
  const json = await res.json();
  console.log(JSON.stringify(json.fields ?? json, null, 2));
  if (!res.ok) {
    console.error('write failed — flag NOT changed');
    process.exit(1);
  }
  console.log('DONE: adminLoginRequired = true');
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});