// Local check of the Netlify function against the Firestore emulator (no Netlify account needed):
//   npx firebase emulators:exec --project demo-srbh --only firestore "node netlify/smoke-test.mjs"
// Exercises: path rewriting, bootstrap, login cookie, protected API, Firestore-backed backups.
import assert from 'node:assert/strict';

process.env.BOOTSTRAP_TOKEN = 'netlify-smoke-bootstrap-token-123456';
process.env.BACKUP_TARGET = 'firestore';
process.env.CACHE_TTL_MS = '10000';
await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`, { method: 'DELETE' });

const { handler, normalizePath } = await import('./functions/api.mjs');
assert.equal(normalizePath('/.netlify/functions/api/menu'), '/api/menu');
assert.equal(normalizePath('/api/menu'), '/api/menu');

const call = async (method, path, { body, cookie, csrf } = {}) => {
  const r = await handler({
    httpMethod: method, path, rawUrl: `https://example.netlify.app${path}`, queryStringParameters: {},
    headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': '1.2.3.4', ...(cookie && { cookie }), ...(csrf && { 'x-csrf-token': csrf }) },
    body: body ? JSON.stringify(body) : null, isBase64Encoded: false,
  }, {});
  const setCookie = r.multiValueHeaders?.['set-cookie']?.[0] ?? r.headers?.['set-cookie'];
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null, setCookie, headers: r.headers };
};

let r = await call('GET', '/.netlify/functions/api/menu');
assert.equal(r.status, 401); assert.equal(r.json.code, 'UNAUTHENTICATED');

r = await call('POST', '/api/bootstrap', { body: { secret: process.env.BOOTSTRAP_TOKEN, username: 'owner', displayName: 'Owner', password: 'Owner@12345' } });
assert.equal(r.status, 200, JSON.stringify(r.json));

r = await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'Owner@12345' } });
assert.equal(r.status, 200);
assert.match(String(r.setCookie), /__session=.*HttpOnly; Secure; SameSite=Strict/);
const cookie = String(r.setCookie).split(';')[0], csrf = r.json.csrfToken;

r = await call('GET', '/api/tables', { cookie });
assert.equal(r.status, 200); assert.equal(r.json.tables.length, 8);
assert.equal(r.headers['cache-control'], 'private, no-cache');

// order → delete with backup stored in Firestore (no Cloud Storage needed)
r = await call('POST', '/api/orders', { cookie, csrf, body: { idempotencyKey: crypto.randomUUID(), tableId: 't1', items: [{ menuItemId: 'thali-full', quantity: 2 }] } });
assert.equal(r.status, 201); assert.equal(r.json.order.total, 260);
const today = r.json.order.date;
r = await call('POST', '/api/orders/delete', { cookie, csrf, body: { mode: 'range', from: today, dryRun: false, confirm: 'DELETE' } });
assert.equal(r.status, 200, JSON.stringify(r.json)); assert.match(r.json.backupPath, /^firestore:backups\//);
r = await call('GET', '/api/backups', { cookie });
const name = r.json[0].name;
r = await call('GET', `/api/backups/${name}`, { cookie });
assert.equal(r.status, 200); assert.equal(r.json.transactions.length, 1); assert.equal(r.json.transactions[0].totalAmount, 260);

console.log('NETLIFY SMOKE TEST PASSED');
process.exit(0);
