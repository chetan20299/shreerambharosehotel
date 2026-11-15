// Each E2E run starts from an empty EMULATOR database (demo data re-seeds on first demo login).
// Refuses to touch anything that is not the local emulator.
export default async function globalSetup() {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('E2E reset only runs against a local emulator');
  if (process.env.E2E_BASE_URL?.includes('4173')) return; // static preview (in-browser demo test): no emulator
  const res = await fetch(`http://${host}/emulator/v1/projects/demo-srbh/databases/(default)/documents`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Could not reset emulator: ${res.status}`);
}
