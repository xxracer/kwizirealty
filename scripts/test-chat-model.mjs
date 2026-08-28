// Verifies the exact pieces /api/chat relies on: key auth + model + tools.
// Usage: node scripts/test-chat-model.mjs
import fs from 'fs';
import path from 'path';

// Load .env.local the way dotenv does (strips surrounding quotes).
const envPath = path.join(process.cwd(), '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^['"]/, '').replace(/['"]$/, '');
  }
}
const key = (process.env.GOOGLE_GENERATIVE_AI_API_KEY || '').trim();
console.log('GOOGLE_GENERATIVE_AI_API_KEY present:', !!key, `(len ${key.length}, prefix ${key.slice(0, 3)}…)`);

function failIsKey(v) {
  return !v || !(v.startsWith('AIza') || v.startsWith('AQ.'));
}
if (failIsKey(key)) {
  console.error('✗ Key looks malformed — check .env.local (no quotes, no spaces).');
  process.exit(1);
}

const body = {
  tools: [
    {
      functionDeclarations: [
        {
          name: 'selectMapAreas',
          description: 'Select areas on the map and optionally generate a report.',
          parameters: {
            type: 'object',
            properties: {
              areasToSearch: { type: 'array', items: { type: 'string' } },
              generateReport: { type: 'boolean' },
            },
            required: ['areasToSearch', 'generateReport'],
          },
        },
      ],
    },
  ],
  contents: [{ role: 'user', parts: [{ text: 'report for Tomball' }] }],
};

try {
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) }
  );
  const json = await res.json();
  if (!res.ok) {
    console.error(`✗ Google API HTTP ${res.status}:`, JSON.stringify(json.error || json).slice(0, 300));
    process.exit(1);
  }
  const parts = json.candidates?.[0]?.content?.parts || [];
  const toolCall = parts.find((p) => p.functionCall);
  console.log('✓ MODEL CALL OK — gemini-3.5-flash-lite responded.');
  console.log('  tool call:', toolCall ? JSON.stringify(toolCall.functionCall) : '(none)');
} catch (err) {
  console.error('✗ Request failed:', err.message);
  process.exit(1);
}