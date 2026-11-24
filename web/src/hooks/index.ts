import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from '../services/api';
import { getPending, getPendingOps, subscribePending } from '../services/offlineQueue';

export function useOnline() {
  return useSyncExternalStore(
    (cb) => { addEventListener('online', cb); addEventListener('offline', cb); return () => { removeEventListener('online', cb); removeEventListener('offline', cb); }; },
    () => navigator.onLine,
  );
}

let pendingSnapshot = getPending();
let pendingRaw = JSON.stringify(pendingSnapshot);
export function usePending() {
  return useSyncExternalStore(subscribePending, () => {
    const raw = JSON.stringify(getPending());
    if (raw !== pendingRaw) { pendingRaw = raw; pendingSnapshot = JSON.parse(raw); }
    return pendingSnapshot;
  });
}

let opsSnapshot = getPendingOps();
let opsRaw = JSON.stringify(opsSnapshot);
export function usePendingOps() {
  return useSyncExternalStore(subscribePending, () => {
    const raw = JSON.stringify(getPendingOps());
    if (raw !== opsRaw) { opsRaw = raw; opsSnapshot = JSON.parse(raw); }
    return opsSnapshot;
  });
}

const CACHE_PREFIX = 'srbh.cache:';
export const clearApiCache = () => {
  try { Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX)).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
};
function readCache<T>(key: string): { at: number; data: T } | null {
  try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + key) ?? 'null'); } catch { return null; }
}

/**
 * GET with loading/error state.
 * - poll: refetch every N ms while the tab is visible.
 * - cache: keep the last good response on this phone; when offline it is returned with `staleAt` set.
 */
export function useApi<T>(path: string | null, query?: Record<string, string | undefined>, opts: { poll?: number; cache?: boolean } = {}) {
  const qkey = JSON.stringify(query ?? {});
  const ckey = `${path}?${qkey}`;
  const [data, setData] = useState<T | null>(() => (opts.cache && path ? readCache<T>(ckey)?.data ?? null : null));
  const [staleAt, setStaleAt] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!path);
  const load = useCallback(async (quiet = false) => {
    if (!path) return;
    if (!quiet) setLoading(true);
    try {
      const d = await api<T>(path, { query });
      setData(d); setError(null); setStaleAt(null);
      if (opts.cache) try { localStorage.setItem(CACHE_PREFIX + ckey, JSON.stringify({ at: Date.now(), data: d })); } catch { /* full */ }
    } catch (e) {
      const cached = opts.cache && e instanceof ApiError && e.status === 0 ? readCache<T>(ckey) : null;
      if (cached) { setData(cached.data); setStaleAt(cached.at); setError(null); } else setError(e);
    } finally { setLoading(false); }
  }, [ckey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const id = opts.poll ? setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, opts.poll) : undefined;
    const onOnline = () => void load(true);
    addEventListener('online', onOnline);
    addEventListener('srbh:synced', onOnline);
    return () => { clearInterval(id); removeEventListener('online', onOnline); removeEventListener('srbh:synced', onOnline); };
  }, [load, opts.poll]);
  return { data, error, loading, staleAt, reload: load, setData };
}

// "Focus mode" hides the phone bottom bar while a full-screen task is open (e.g. editing the floor plan).
let focusMode = false;
const focusListeners = new Set<() => void>();
export const setFocusMode = (v: boolean) => { focusMode = v; focusListeners.forEach((l) => l()); };
export const useFocusMode = () => useSyncExternalStore((cb) => { focusListeners.add(cb); return () => { focusListeners.delete(cb); }; }, () => focusMode);
