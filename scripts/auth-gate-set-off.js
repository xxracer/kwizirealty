/** Disable admin login requirement in cms_config/auth (owner request 2026-09-30). */
const fs = require('fs');
async function getAccessToken() {
  const adcPath = `${process.env.APPDATA}/gcloud/legacy_credentials/maijelcancines2@gmail.com/adc.json`;
  const parsed = JSON.parse(fs.readFileSync(adcPath, 'utf8'));
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
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}
(async () => {
  const token = await getAccessToken();
  const url =
    'https://firestore.googleapis.com/v1/projects/myreatstat/databases/(default)/documents/cms_config/auth?updateMask.fieldPaths=adminLoginRequired';
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { adminLoginRequired: { booleanValue: false } } }),
  });
  console.log('PATCH HTTP', res.status, res.ok ? '— adminLoginRequired = FALSE (login desactivado)' : 'FAILED');
})();