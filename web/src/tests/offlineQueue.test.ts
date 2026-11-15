import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addPending, getPending, syncPending, type PendingOrder } from '../services/offlineQueue';

const p = (key: string, waiterId = 'w1'): PendingOrder => ({
  idempotencyKey: key, waiterId, waiterName: 'W', tableId: 't1', tableLabel: 'T1', createdAt: new Date().toISOString(), total: 130,
  items: [{ menuItemId: 'thali-full', name: 'Full', type: 'fixed', isThali: true, quantity: 1, unitPrice: 130 }],
});
const ok = (body: object) => new Response(JSON.stringify(body), { status: 201, headers: { 'content-type': 'application/json' } });

describe('offline queue sync', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('regression: a sync with an empty queue does not block later syncs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({ order: { id: 'x' } }));
    await syncPending('w1'); // empty queue
    addPending(p('k1'));
    const r = await syncPending('w1');
    expect(r.saved).toHaveLength(1);
    expect(getPending()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ idempotencyKey: 'k1', offline: true, tableId: 't1' });
  });

  it('only sends the logged-in waiter’s orders; keeps others', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({ order: { id: 'x' } }));
    addPending(p('a', 'w1')); addPending(p('b', 'w2'));
    await syncPending('w1');
    expect(getPending().map((x) => x.idempotencyKey)).toEqual(['b']);
  });

  it('keeps orders queued while offline, and records server rejections', async () => {
    addPending(p('a'));
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await syncPending('w1');
    expect(getPending()).toHaveLength(1);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ error: 'A menu item is no longer available' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const r = await syncPending('w1');
    expect(r.failed[0]!.error).toContain('no longer available');
    expect(getPending()[0]!.error).toContain('no longer available');
  });

  it('concurrent calls share one run (no double submit)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok({ order: { id: 'x' } }));
    addPending(p('a'));
    await Promise.all([syncPending('w1'), syncPending('w1')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
