// Single gateway to the backend. All data goes through the `api` Cloud Function (same origin, /api/*).
// - 20 s timeout, one automatic retry for GETs on network errors
// - in-flight counter drives the global top progress bar
// - errors carry { status, code, requestId } from the server's uniform error shape
let csrfToken = '';
let onUnauthorized: (() => void) | undefined;

export const setCsrf = (t: string) => { csrfToken = t; };
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
const TIMEOUT_MS = 20_000;

async function once(url: string, init: RequestInit) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw (e as Error).name === 'AbortError' ? new ApiError(408, 'timeout', 'TIMEOUT') : new ApiError(0, 'offline', 'OFFLINE');
  } finally { clearTimeout(timer); }
}

/** True while the in-browser demo is active (set by the Demo buttons). */
const demoActive = () => { try { return !!localStorage.getItem('srbh.demo'); } catch { return false; } };

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; query?: Query; silent?: boolean } = {}): Promise<T> {
  if (demoActive()) { // in-browser sample backend: never touches the real server or database
    if (!opts.silent) bump(1);
    try {
      const { handle } = await import('../demo/mockServer');
      const q = Object.fromEntries(Object.entries(opts.query ?? {}).filter((e): e is [string, string] => !!e[1]));
      return (await handle(opts.method ?? 'GET', path, q, (opts.body ?? {}) as Record<string, unknown>)) as T;
    } catch (e) {
      const err = e as { status?: number; message?: string };
      throw new ApiError(err.status ?? 500, err.message ?? 'Demo error');
    } finally { if (!opts.silent) bump(-1); }
  }
  const qs = opts.query ? new URLSearchParams(Object.entries(opts.query).filter((e): e is [string, string] => !!e[1])).toString() : '';
  const method = opts.method ?? 'GET';
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  };
  if (!opts.silent) bump(1);
  try {
    let res: Response;
    try { res = await once(`/api${path}${qs ? `?${qs}` : ''}`, init); }
    catch (e) {
      // Reads are safe to retry once; writes are not (orders use idempotency keys and their own queue).
      if (method !== 'GET' || !(e instanceof ApiError) || e.status !== 0) throw e;
      await new Promise((r) => setTimeout(r, 800));
      res = await once(`/api${path}${qs ? `?${qs}` : ''}`, init);
    }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => ({})) : await res.blob();
    if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/me')) onUnauthorized?.();
    if (!res.ok) {
      const d = data as { error?: string; code?: string; requestId?: string };
      throw new ApiError(res.status, d?.error ?? `HTTP ${res.status}`, d?.code ?? '', d?.requestId ?? res.headers.get('x-request-id') ?? undefined);
    }
    return data as T;
  } finally { if (!opts.silent) bump(-1); }
}
