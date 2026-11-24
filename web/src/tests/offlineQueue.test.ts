import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addPending, getPending, getPendingOps, syncPending, type PendingOrder } from '../services/offlineQueue';
import { handle } from '../services/firebaseBackend';

// The backend is Firestore (firebaseBackend.handle); fake it here.
vi.mock('../services/firebaseBackend', () => ({ handle: vi.fn() }));
const backend = vi.mocked(handle);

const p = (key: string, waiterId = 'w1'): PendingOrder => ({
  idempotencyKey: key, waiterId, waiterName: 'W', tableId: 't1', tableLabel: 'T1', createdAt: new Date().toISOString(), total: 130,
  items: [{ menuItemId: 'thali-full', name: 'Full', type: 'fixed', isThali: true, quantity: 1, unitPrice: 130 }],
});

describe('offline queue sync', () => {
  beforeEach(() => { localStorage.clear(); backend.mockReset(); });

  it('regression: a sync with an empty queue does not block later syncs', async () => {
    backend.mockResolvedValue({ order: { id: 'x' } });
    await syncPending('w1'); // empty queue
    addPending(p('k1'));
    const r = await syncPending('w1');
    expect(r.saved).toHaveLength(1);
    expect(getPending()).toHaveLength(0);
    expect(backend).toHaveBeenCalledTimes(1);
    const body = backend.mock.calls[0]![3];
    expect(body).toMatchObject({ idempotencyKey: 'k1', offline: true, tableId: 't1' });
  });

  it('only sends the logged-in waiter’s orders; keeps others', async () => {
    backend.mockResolvedValue({ order: { id: 'x' } });
    addPending(p('a', 'w1')); addPending(p('b', 'w2'));
    await syncPending('w1');
    expect(getPending().map((x) => x.idempotencyKey)).toEqual(['b']);
  });

  it('keeps orders queued while offline, and records server rejections', async () => {
    addPending(p('a'));
    backend.mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 0 }));
    await syncPending('w1');
    expect(getPending()).toHaveLength(1);
    backend.mockRejectedValueOnce(Object.assign(new Error('A menu item is no longer available'), { status: 400 }));
    const r = await syncPending('w1');
    expect(r.failed[0]!.error).toContain('no longer available');
    expect(getPending()[0]!.error).toContain('no longer available');
  });

  it('concurrent calls share one run (no double submit)', async () => {
    backend.mockResolvedValue({ order: { id: 'x' } });
    addPending(p('a'));
    await Promise.all([syncPending('w1'), syncPending('w1')]);
    expect(backend).toHaveBeenCalledTimes(1);
  });
});

describe('offline changes (generic queue)', () => {
  const offline = () => Object.assign(new Error('offline'), { status: 0 });
  beforeEach(() => {
    localStorage.clear(); backend.mockReset();
    localStorage.setItem('srbh.session', JSON.stringify({ user: { id: 'w1' }, csrf: '' }));
  });

  it('queues safe writes when offline, refuses the rest, and syncs them in order once online', async () => {
    const { api, ApiError } = await import('../services/api');
    backend.mockRejectedValue(offline());
    expect(await api('/expenses', { method: 'POST', body: { description: 'Milk', amount: 50 } })).toEqual({ queued: true });
    expect(await api('/expenses/e1', { method: 'DELETE' })).toEqual({ queued: true });
    await expect(api('/orders/delete', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError); // needs internet
    await expect(api('/users/u1', { method: 'PATCH', body: { password: 'secret123' } })).rejects.toBeInstanceOf(ApiError); // never stored
    const ops = getPendingOps();
    expect(ops.map((o) => o.path)).toEqual(['/expenses', '/expenses/e1']);
    expect(ops[0]!.body).toMatchObject({ clientId: ops[0]!.key }); // resend-safe id

    backend.mockReset();
    backend.mockResolvedValueOnce({ id: 'x' }).mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    const r = await syncPending('w1');
    expect(r.ops).toBe(1); // the DELETE was already done on the server: dropped silently
    expect(r.failedOps).toHaveLength(0);
    expect(getPendingOps()).toHaveLength(0);
  });

  it('keeps changes queued while still offline', async () => {
    const { api } = await import('../services/api');
    backend.mockRejectedValue(offline());
    await api('/settings', { method: 'PUT', body: { footer: 'x' } });
    const r = await syncPending('w1');
    expect(r.ops).toBe(0);
    expect(getPendingOps()).toHaveLength(1);
  });
});
