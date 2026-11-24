import { api, ApiError } from './api';
import type { Order } from '../types';

/**
 * Orders taken while offline. They stay "pending" (NOT saved) until the server confirms.
 * - Each has a fixed idempotency key → retries after a lost response can never duplicate.
 * - Each belongs to the waiter who took it; only that waiter's session sends it (shared phones are safe).
 * - Sent with offline=true + the time it was taken, so the server accepts it even if another waiter
 *   used the same table meanwhile (flagged as a conflict for the admin) and reports use the real sale time.
 */
export interface PendingOrder {
  idempotencyKey: string; waiterId: string; waiterName: string; hall?: 'ac' | 'nonac'; tableId: string; tableLabel: string; createdAt: string;
  items: { menuItemId: string; name: string; type: 'fixed' | 'custom'; isThali: boolean; quantity: number; unitPrice: number; description?: string }[];
  total: number; error?: string; printed?: boolean;
}
const KEY = 'srbh.pendingOrders';
const listeners = new Set<() => void>();

export function getPending(): PendingOrder[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}
function save(list: PendingOrder[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full: keep in memory listeners informed */ }
  listeners.forEach((l) => l());
}
export const subscribePending = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const addPending = (p: PendingOrder) => save([...getPending().filter((x) => x.idempotencyKey !== p.idempotencyKey), p]);
export const markPendingPrinted = (key: string) => {
  const p = getPending().find((x) => x.idempotencyKey === key);
  if (p) addPending({ ...p, printed: true });
};
export const removePending = (key: string) => save(getPending().filter((x) => x.idempotencyKey !== key));

export const toOrderBody = (p: Pick<PendingOrder, 'idempotencyKey' | 'items'> & { hall?: 'ac' | 'nonac'; tableId?: string }, offline?: { createdAt: string }) => ({
  idempotencyKey: p.idempotencyKey, ...(p.hall ? { hall: p.hall } : {}), ...(p.tableId ? { tableId: p.tableId } : {}),
  items: p.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity, unitPrice: i.type === 'custom' ? i.unitPrice : undefined, description: i.description || undefined })),
  ...(offline ? { offline: true, clientCreatedAt: offline.createdAt } : {}),
});

/**
 * Other changes made while offline (expenses, menu, settings, cancel, ...). Only operations that are safe to
 * send later are queued (see QUEUEABLE); everything else needs the internet and shows "turn on the internet".
 * Sent in the order they were made, by the user who made them.
 */
export interface PendingOp { key: string; userId: string; method: string; path: string; body?: Record<string, unknown>; createdAt: string }
const OPS_KEY = 'srbh.pendingOps';
const QUEUEABLE: [string, RegExp][] = [
  ['POST', /^\/expenses$/], ['DELETE', /^\/expenses\/[\w-]+$/],
  ['POST', /^\/orders\/[\w-]+\/(printed|cancel)$/],
  ['PATCH', /^\/menu\/(categories\/)?[\w-]+$/], ['DELETE', /^\/menu\/(categories\/)?[\w-]+$/],
  ['PUT', /^\/(settings|expense-items)$/], ['PATCH', /^\/users\/[\w-]+$/],
];
export function getPendingOps(): PendingOp[] {
  try { return JSON.parse(localStorage.getItem(OPS_KEY) ?? '[]'); } catch { return []; }
}
function saveOps(list: PendingOp[]) {
  try { localStorage.setItem(OPS_KEY, JSON.stringify(list)); } catch { /* storage full */ }
  listeners.forEach((l) => l());
}
export const removePendingOp = (key: string) => saveOps(getPendingOps().filter((x) => x.key !== key));
const sessionUserId = () => { try { return (JSON.parse(localStorage.getItem('srbh.session') ?? 'null')?.user?.id as string) ?? ''; } catch { return ''; } };

/** Queues an offline change if it is safe to send later. Returns false when it needs the internet. */
export function queueOp(method: string, path: string, body?: Record<string, unknown>) {
  const userId = sessionUserId();
  if (!userId || !QUEUEABLE.some(([m, r]) => m === method && r.test(path))) return false;
  if (body && 'password' in body && body.password) return false; // never keep passwords on the phone
  const key = `op${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // A new expense gets its id now, so sending it twice (lost reply) can never add it twice.
  const b = method === 'POST' && path === '/expenses' ? { ...body, clientId: key } : body;
  saveOps([...getPendingOps(), { key, userId, method, path, body: b, createdAt: new Date().toISOString() }]);
  return true;
}

const retryLater = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 401 || e.status >= 500 || e.status === 429);
// Already done on the server (deleted / cancelled by someone else) → nothing left to do.
const alreadyDone = (op: PendingOp, e: unknown) => e instanceof ApiError &&
  ((op.method === 'DELETE' && e.status === 404) || (op.path.endsWith('/cancel') && e.status === 409));

type SyncResult = { saved: Order[]; failed: PendingOrder[]; ops: number; failedOps: { op: PendingOp; error: string }[] };
let syncing: Promise<SyncResult> | null = null;

/** Sends the current user's pending orders, then their other queued changes. Network/401 errors keep them queued; server rejections keep the reason. */
export function syncPending(userId: string) {
  if (syncing) return syncing; // one sync at a time
  // Note: the in-flight marker is cleared via .finally on the stored promise. Clearing it inside the async body
  // breaks when the queue is empty (the body finishes synchronously before the assignment → stuck forever).
  const run = (async () => {
    const saved: Order[] = [], failed: PendingOrder[] = [];
    for (const p of getPending().filter((x) => x.waiterId === userId)) {
      try {
        const r = await api<{ order: Order }>('/orders', { method: 'POST', body: toOrderBody(p, { createdAt: p.createdAt }) });
        removePending(p.idempotencyKey);
        if (p.printed) await api(`/orders/${r.order.id}/printed`, { method: 'POST', noQueue: true }).catch(() => undefined);
        saved.push(r.order);
      } catch (e) {
        if (retryLater(e)) return { saved, failed, ops: 0, failedOps: [] }; // retry later
        const withErr = { ...p, error: e instanceof Error ? e.message : String(e) };
        addPending(withErr);
        failed.push(withErr);
      }
    }
    let ops = 0;
    const failedOps: SyncResult['failedOps'] = [];
    for (const op of getPendingOps().filter((x) => x.userId === userId)) {
      try { await api(op.path, { method: op.method, body: op.body, noQueue: true }); ops++; }
      catch (e) {
        if (retryLater(e)) break;
        if (!alreadyDone(op, e)) failedOps.push({ op, error: e instanceof Error ? e.message : String(e) });
      }
      removePendingOp(op.key);
    }
    if (saved.length || ops) dispatchEvent(new Event('srbh:synced')); // screens refresh their data
    return { saved, failed, ops, failedOps };
  })();
  syncing = run;
  void run.finally(() => { if (syncing === run) syncing = null; });
  return run;
}
