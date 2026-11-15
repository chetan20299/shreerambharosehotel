import { gzipSync, gunzipSync } from 'node:zlib';
import { bucket, db, FieldValue } from './db.js';

/**
 * JSON backups (before deletions and monthly roll-ups).
 *  - BACKUP_TARGET=storage (default, Firebase/Blaze): Cloud Storage `backups/<name>`.
 *  - BACKUP_TARGET=firestore (Netlify + Spark plan, where Storage is unavailable): gzip-compressed in Firestore,
 *    split into ≤900 KB chunks (`backups/<name>` + `backups/<name>/chunks/<i>`). ~4,500 orders ≈ 150 KB gzipped.
 */
const target = () => (process.env.BACKUP_TARGET === 'firestore' ? 'firestore' : 'storage');
const CHUNK = 900_000;
export const backupNameOk = (n: string) => /^[A-Za-z0-9_.-]+\.json$/.test(n);

export async function saveBackup(name: string, data: unknown) {
  const json = JSON.stringify(data, null, 2);
  if (target() === 'storage') {
    await bucket().file(`backups/${name}`).save(json, { contentType: 'application/json' });
    return `backups/${name}`;
  }
  const gz = gzipSync(json);
  const ref = db.collection('backups').doc(name);
  const chunks = Math.ceil(gz.length / CHUNK) || 1;
  const batch = db.batch();
  for (let i = 0; i < chunks; i++) batch.set(ref.collection('chunks').doc(String(i)), { data: gz.subarray(i * CHUNK, (i + 1) * CHUNK) });
  batch.set(ref, { name, size: json.length, gzSize: gz.length, chunks, createdAt: FieldValue.serverTimestamp() });
  await batch.commit();
  return `firestore:backups/${name}`;
}

export async function listBackups(): Promise<{ name: string; size: number; created: string | null }[]> {
  if (target() === 'storage') {
    const [files] = await bucket().getFiles({ prefix: 'backups/' });
    return files.map((f) => ({ name: f.name.slice('backups/'.length), size: Number(f.metadata.size ?? 0), created: (f.metadata.timeCreated as string) ?? null })).reverse();
  }
  const snap = await db.collection('backups').orderBy('createdAt', 'desc').limit(100).get();
  return snap.docs.map((d) => ({ name: d.id, size: d.data().size ?? 0, created: d.data().createdAt?.toDate().toISOString() ?? null }));
}

/** Returns the backup JSON text, or null if it does not exist. */
export async function readBackup(name: string): Promise<Buffer | null> {
  if (target() === 'storage') {
    const [buf] = await bucket().file(`backups/${name}`).download().catch(() => [null]);
    return buf;
  }
  const ref = db.collection('backups').doc(name);
  const meta = (await ref.get()).data();
  if (!meta) return null;
  const parts = await ref.collection('chunks').get();
  const ordered = parts.docs.sort((a, b) => Number(a.id) - Number(b.id)).map((d) => Buffer.from(d.data().data));
  return gunzipSync(Buffer.concat(ordered));
}
