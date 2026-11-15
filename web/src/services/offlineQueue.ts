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
  idempotencyKey: string; waiterId: string; waiterName: string; tableId: string; tableLabel: string; createdAt: string;
  items: { menuItemId: string; name: string; type: 'fixed' | 'custom'; isThali: boolean; quantity: number; unitPrice: number; description?: string }[];
  total: number; error?: string;
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
export const removePending = (key: string) => save(getPending().filter((x) => x.idempotencyKey !== key));

export const toOrderBody = (p: Pick<PendingOrder, 'idempotencyKey' | 'tableId' | 'items'>, offline?: { createdAt: string }) => ({
  idempotencyKey: p.idempotencyKey, tableId: p.tableId,
  items: p.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity, unitPrice: i.type === 'custom' ? i.unitPrice : undefined, description: i.description || undefined })),
  ...(offline ? { offline: true, clientCreatedAt: offline.createdAt } : {}),
});

let syncing: Promise<{ saved: Order[]; failed: PendingOrder[] }> | null = null;

/** Sends the current user's pending orders. Network/401 errors keep them queued; server rejections keep the reason. */
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
        saved.push(r.order);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 0 || e.status === 401 || e.status >= 500 || e.status === 429)) break; // retry later
        const withErr = { ...p, error: e instanceof Error ? e.message : String(e) };
        addPending(withErr);
        failed.push(withErr);
      }
    }
    return { saved, failed };
  })();
  syncing = run;
  void run.finally(() => { if (syncing === run) syncing = null; });
  return run;
}
