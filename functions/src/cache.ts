/**
 * In-process cache to keep Firestore reads inside the free tier (see docs/FREE_TIER_PLAN.md).
 *
 * Safe because the `api` function runs with maxInstances: 1 — every write passes through this same process and
 * invalidates what it changed. A short TTL is the safety net for the only other writer (the nightly retention job).
 * ponytail: single-instance cache; if maxInstances is ever raised, switch to a Firestore "version" doc per area.
 */
const store = new Map<string, { at: number; value: unknown }>();

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  store.set(key, { at: Date.now(), value });
  return value;
}

export const peek = <T>(key: string) => store.get(key)?.value as T | undefined;
export const put = (key: string, value: unknown) => { store.set(key, { at: Date.now(), value }); };

/** Removes every entry whose key starts with one of the prefixes. */
export function invalidate(...prefixes: string[]) {
  for (const k of store.keys()) if (prefixes.some((p) => k.startsWith(p))) store.delete(k);
}

/** Removes entries matching a predicate on their value (e.g. all cached sessions of one user). */
export function invalidateWhere(prefix: string, match: (v: unknown) => boolean) {
  for (const [k, v] of store) if (k.startsWith(prefix) && match(v.value)) store.delete(k);
}

/** Which cached areas a write to a given API path can change. */
export function areasFor(path: string): string[] {
  if (path.startsWith('/menu')) return ['menu'];
  if (path.startsWith('/settings')) return ['settings'];
  if (path.startsWith('/users')) return ['users'];
  if (/^\/(tables|layout|orders|maintenance|demo|bootstrap)/.test(path)) return ['tables', 'orders:', 'dash:'];
  return [];
}
