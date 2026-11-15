import { describe, it, expect } from 'vitest';
import { buildItems, summarize, HttpError, type MenuItem, type Order } from '../../src/orders.js';
import { istParts, istRange, addDays } from '../../src/time.js';
import { hashPassword, verifyPassword, parseCookies, sessionCookie, safeEqual } from '../../src/security.js';

const menu = new Map<string, MenuItem>([
  ['thali-full', { id: 'thali-full', name: 'Gujarati Thali – Full', price: 130, type: 'fixed', isThali: true, active: true }],
  ['thali-small', { id: 'thali-small', name: 'Gujarati Thali – Small', price: 50, type: 'fixed', isThali: true, active: true }],
  ['extra', { id: 'extra', name: 'Extra', price: 0, type: 'custom', isThali: false, active: true }],
  ['old', { id: 'old', name: 'Old', price: 10, type: 'fixed', isThali: false, active: false }],
]);

describe('pricing', () => {
  it('uses server prices and computes totals', () => {
    const r = buildItems([{ menuItemId: 'thali-full', quantity: 2, unitPrice: 1 }, { menuItemId: 'thali-small', quantity: 3 }], menu);
    expect(r.items[0]).toMatchObject({ unitPrice: 130, amount: 260, isThali: true });
    expect(r.total).toBe(410);
  });
  it('accepts custom extra amount with description', () => {
    const r = buildItems([{ menuItemId: 'thali-full', quantity: 2 }, { menuItemId: 'extra', quantity: 1, unitPrice: 35.5, description: ' Chaas ' }], menu);
    expect(r.total).toBe(295.5);
    expect(r.items[1]).toMatchObject({ amount: 35.5, description: 'Chaas', type: 'custom' });
  });
  it('avoids float drift (0.1 + 0.2)', () => {
    expect(buildItems([{ menuItemId: 'extra', quantity: 1, unitPrice: 0.1 }, { menuItemId: 'extra', quantity: 1, unitPrice: 0.2 }], menu).total).toBe(0.3);
  });
  it.each([
    [[{ menuItemId: 'extra', quantity: 1, unitPrice: 0 }]],
    [[{ menuItemId: 'extra', quantity: 1, unitPrice: -5 }]],
    [[{ menuItemId: 'extra', quantity: 1, unitPrice: 1.234 }]],
    [[{ menuItemId: 'extra', quantity: 1 }]],
    [[{ menuItemId: 'thali-full', quantity: 0 }]],
    [[{ menuItemId: 'thali-full', quantity: 1.5 }]],
    [[{ menuItemId: 'old', quantity: 1 }]],
    [[{ menuItemId: 'nope', quantity: 1 }]],
    [[]],
  ])('rejects invalid lines %j', (lines) => {
    expect(() => buildItems(lines, menu)).toThrow(HttpError);
  });
});

const order = (o: Partial<Order>): Order => ({
  id: 'x', billNo: '1', date: '2026-11-15', time: '12:00:00', waiterId: 'w1', waiterName: 'Ramesh', tableId: 't1', tableLabel: 'T1',
  items: [], total: 0, status: 'billed', createdAt: '', ...o,
});

describe('summarize', () => {
  it('aggregates and excludes cancelled', () => {
    const a = buildItems([{ menuItemId: 'thali-full', quantity: 2 }, { menuItemId: 'extra', quantity: 1, unitPrice: 20 }], menu);
    const b = buildItems([{ menuItemId: 'thali-small', quantity: 1 }], menu);
    const s = summarize([
      order({ id: 'a', ...a }),
      order({ id: 'b', ...b, waiterId: 'w2', waiterName: 'Suresh', tableId: 't2', tableLabel: 'T2', date: '2026-11-14' }),
      order({ id: 'c', ...a, status: 'cancelled' }),
    ]);
    expect(s).toMatchObject({ orderCount: 2, cancelledCount: 1, totalAmount: 330, thaliCount: 3, extraAmount: 20 });
    expect(s.byItem.find((i) => i.menuItemId === 'thali-full')).toMatchObject({ quantity: 2, amount: 260 });
    expect(s.byDay.map((d) => d.key)).toEqual(['2026-11-14', '2026-11-15']);
    expect(s.byWaiter[0]).toMatchObject({ label: 'Ramesh', amount: 280 });
  });
});

describe('IST time', () => {
  it('formats in Asia/Kolkata', () => {
    expect(istParts(new Date('2026-11-14T20:00:00Z'))).toEqual({ date: '2026-11-15', time: '01:30:00' });
  });
  it('builds half-open ranges', () => {
    const r = istRange('2026-11-15', '2026-11-15');
    expect(r.start.toISOString()).toBe('2026-11-14T18:30:00.000Z');
    expect(r.end.toISOString()).toBe('2026-11-15T18:30:00.000Z');
    const t = istRange('2026-11-15', '2026-11-15', '12:00', '14:30');
    expect(t.start.toISOString()).toBe('2026-11-15T06:30:00.000Z');
    expect(t.end.toISOString()).toBe('2026-11-15T09:01:00.000Z');
  });
  it('adds days across months', () => expect(addDays('2026-03-01', -1)).toBe('2026-02-28'));
});

describe('security', () => {
  it('hashes and verifies passwords (no plaintext in hash)', async () => {
    const h = await hashPassword('Secret#123');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(h).not.toContain('Secret');
    expect(await verifyPassword('Secret#123', h)).toBe(true);
    expect(await verifyPassword('secret#123', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await hashPassword('Secret#123')).not.toBe(h); // salted
  });
  it('builds a hardened cookie and parses it', () => {
    const c = sessionCookie('abc', 60);
    expect(c).toContain('HttpOnly'); expect(c).toContain('Secure'); expect(c).toContain('SameSite=Strict');
    expect(parseCookies('a=1; __session=tok%3D; b=2').__session).toBe('tok=');
  });
  it('safeEqual', () => { expect(safeEqual('ab', 'ab')).toBe(true); expect(safeEqual('ab', 'abc')).toBe(false); });
});

import { mergeSummaries, addMonths } from '../../src/retention.js';
describe('monthly retention math', () => {
  it('addMonths crosses years', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', -12)).toBe('2025-11');
  });
  it('merges summaries by key without float drift', () => {
    const a = summarize([order({ id: 'a', ...buildItems([{ menuItemId: 'thali-full', quantity: 1 }, { menuItemId: 'extra', quantity: 1, unitPrice: 0.1 }], menu) })]);
    const b = summarize([order({ id: 'b', ...buildItems([{ menuItemId: 'thali-full', quantity: 2 }, { menuItemId: 'extra', quantity: 1, unitPrice: 0.2 }], menu), waiterId: 'w2', waiterName: 'S' })]);
    const m = mergeSummaries(a, b);
    expect(m).toMatchObject({ orderCount: 2, totalAmount: 390.3, thaliCount: 3, extraAmount: 0.3 });
    expect(m.byItem.find((i) => i.menuItemId === 'thali-full')).toMatchObject({ quantity: 3, amount: 390 });
    expect(m.byWaiter).toHaveLength(2);
    expect(m.byDay).toEqual([{ key: '2026-11-15', label: '2026-11-15', orders: 2, amount: 390.3 }]);
    expect(mergeSummaries(undefined, a)).toBe(a);
  });
});

describe('AC / Non-AC pricing', () => {
  const m2 = new Map(menu);
  m2.set('thali-full', { ...menu.get('thali-full')!, acPrice: 150 });
  it('uses acPrice in AC hall, base price otherwise, and falls back when acPrice is null', () => {
    expect(buildItems([{ menuItemId: 'thali-full', quantity: 2 }], m2, 'ac').total).toBe(300);
    expect(buildItems([{ menuItemId: 'thali-full', quantity: 2 }], m2, 'nonac').total).toBe(260);
    expect(buildItems([{ menuItemId: 'thali-small', quantity: 1 }], m2, 'ac').total).toBe(50);
    expect(buildItems([{ menuItemId: 'extra', quantity: 1, unitPrice: 15 }], m2, 'ac').total).toBe(15);
  });
  it('summarizes by hall', () => {
    const s = summarize([
      order({ id: 'a', ...buildItems([{ menuItemId: 'thali-full', quantity: 1 }], m2, 'ac'), priceCategory: 'ac' }),
      order({ id: 'b', ...buildItems([{ menuItemId: 'thali-full', quantity: 1 }], m2) }),
    ]);
    expect(s.byCategory).toEqual([
      { key: 'ac', label: 'AC Hall', orders: 1, amount: 150 },
      { key: 'nonac', label: 'Non-AC Hall', orders: 1, amount: 130 },
    ]);
  });
});
