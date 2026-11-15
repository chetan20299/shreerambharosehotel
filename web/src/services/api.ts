// Single gateway to the backend (Firestore + Firebase Auth via firebaseBackend.ts).
// - in-flight counter drives the global top progress bar
let onUnauthorized: (() => void) | undefined;

export const setCsrf = (_t: string) => { /* sessions are Firebase Auth now; kept for callers */ };
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

/** status 0 = no network, 408 = timed out. */
export class ApiError extends Error {
  status: number; code: string; requestId?: string;
  constructor(status: number, message: string, code = '', requestId?: string) {
    super(message); this.status = status; this.code = code; this.requestId = requestId;
  }
}

// ---- in-flight tracking for the progress bar ----
let inFlight = 0;
const listeners = new Set<() => void>();
const bump = (d: number) => { inFlight += d; listeners.forEach((l) => l()); };
export const subscribeInFlight = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getInFlight = () => inFlight;

type Query = Record<string, string | undefined>;

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; query?: Query; silent?: boolean } = {}): Promise<T> {
  // Free plan: no server. The app talks to Firestore + Firebase Auth directly (see firebaseBackend.ts).
  if (!opts.silent) bump(1);
  try {
    const { handle } = await import('./firebaseBackend');
    const q = Object.fromEntries(Object.entries(opts.query ?? {}).filter((e): e is [string, string] => !!e[1]));
    return (await handle(opts.method ?? 'GET', path, q, (opts.body ?? {}) as Record<string, unknown>)) as T;
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const status = err.status ?? 500;
    if (status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/me')) onUnauthorized?.();
    throw status === 0 ? new ApiError(0, 'offline', 'OFFLINE') : new ApiError(status, err.message ?? 'Error');
  } finally { if (!opts.silent) bump(-1); }
}
