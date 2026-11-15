import { describe, it, expect } from 'vitest';
import { en } from '../i18n/en';
import { gu } from '../i18n/gu';
import { hi } from '../i18n/hi';
import { translate } from '../i18n';
import { receiptLines, ascii, columns } from '../printing/receipt';
import { buildReceipt, EscPos } from '../printing/escpos';
import { toCsv, toJson, reportFileName } from '../exports';
import { cartTotal, validExtra } from '../pages/OrderEntry';
import { presetRange, inr, addDays } from '../utils/format';
import { priceFor, type Order, type Settings } from '../types';

const order: Order = {
  id: 'abc', billNo: '261115-007', date: '2026-11-15', time: '13:05:09', waiterId: 'ramesh', waiterName: 'Ramesh',
  tableId: 't1', tableLabel: 'T1', status: 'billed', createdAt: '', total: 285, priceCategory: 'nonac',
  items: [
    { menuItemId: 'thali-full', name: 'Gujarati Thali – Full', type: 'fixed', isThali: true, quantity: 2, unitPrice: 130, amount: 260, description: '' },
    { menuItemId: 'extra', name: 'Extra', type: 'custom', isThali: false, quantity: 1, unitPrice: 25, amount: 25, description: '=cmd|"calc"' },
  ],
};
const settings: Settings = { hotelName: 'Shree Ram Bharose Hindu Hotel', address: 'Highway, Gujarat', phone: '98xxxxxx', gstin: '', footer: 'Thank you! Please visit again.', paperWidth: 58 };

describe('i18n', () => {
  const keys = Object.keys(en) as (keyof typeof en)[];
  it.each([['gu', gu], ['hi', hi]] as const)('%s has every key, non-empty, same placeholders', (_l, dict) => {
    for (const k of keys) {
      expect(dict[k], k).toBeTruthy();
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(ph(dict[k]), k).toBe(ph(en[k]));
    }
    expect(Object.keys(dict).sort()).toEqual([...keys].sort());
  });
  it('gu/hi strings are in their own scripts', () => {
    expect(gu['nav.tables']).toMatch(/[઀-૿]/);
    expect(hi['nav.tables']).toMatch(/[ऀ-ॿ]/);
  });
  it('interpolates', () => expect(translate('en', 'order.saved', { bill: '001' })).toBe('Order saved. Bill No. 001'));
});

describe('receipt', () => {
  it('fits the paper width and is printable ASCII (always English)', () => {
    for (const w of [58, 80] as const) for (const o of [order, { ...order, waiterName: 'Waiter With A Very Long Display Name 123', tableLabel: 'TERRACE-12', priceCategory: 'ac' as const }]) {
      const lines = receiptLines(o, { ...settings, paperWidth: w });
      for (const l of lines) {
        expect(l.text.length).toBeLessThanOrEqual(columns(w));
        expect(l.text).toMatch(/^[\x20-\x7E]*$/);
      }
      const text = lines.map((l) => l.text).join('\n');
      expect(text).toContain('Gujarati Thali - Full');
      expect(text).toContain('2 x 130.00');
      expect(text).toMatch(/GRAND TOTAL\s+Rs\.285\.00/);
      expect(text).toContain('Bill No: 261115-007');
      expect(text).toContain(o.priceCategory === 'ac' ? 'Hall: AC Hall' : 'Hall: Non-AC Hall');
    }
  });
  it('marks provisional bills', () => {
    expect(receiptLines({ ...order, billNo: 'PROVISIONAL' }, settings).map((l) => l.text).join()).toContain('PROVISIONAL - NOT SAVED');
  });
  it('ascii replaces rupee and dashes', () => expect(ascii('₹ – ગુ')).toBe('Rs. - '));
});

describe('ESC/POS', () => {
  it('starts with init, ends with cut, encodes text', () => {
    const b = buildReceipt([{ text: 'HI', bold: true, align: 'center' }]);
    expect([...b.slice(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...b.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    expect(String.fromCharCode(...b)).toContain('HI\n');
  });
  it('packs a raster image (GS v 0)', () => {
    const bits = new Uint8Array(16).fill(1);
    const b = new EscPos().raster(bits, 8, 2).encode();
    expect([...b]).toEqual([0x1d, 0x76, 0x30, 0x00, 1, 0, 2, 0, 0xff, 0xff]);
  });
});

describe('exports', () => {
  it('CSV: one row per item, quoted, formula-injection safe, BOM for Excel', () => {
    const csv = toCsv([order]);
    expect(csv.startsWith('﻿')).toBe(true);
    const rows = csv.slice(1).split('\r\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Order ID,Bill No,Date,Time,Waiter,Table,Hall,Item');
    expect(rows[2]).toContain(`"'=cmd|""calc"""`);
  });
  it('JSON matches the backup shape', () => {
    const j = JSON.parse(toJson([order], '2026-11-15', '2026-11-15'));
    expect(j).toMatchObject({ hotel: 'Shree Ram Bharose Hindu Hotel', fromDate: '2026-11-15', toDate: '2026-11-15' });
    expect(j.transactions[0]).toMatchObject({ orderId: 'abc', tableNumber: 'T1', totalAmount: 285, hall: 'Non-AC Hall' });
    expect(j.transactions[0].items[0]).toEqual({ menuItemId: 'thali-full', name: 'Gujarati Thali – Full', quantity: 2, price: 130, amount: 260, description: '' });
  });
  it('meaningful file names', () => {
    expect(reportFileName('Report', '2026-11-15', '2026-11-15', 'pdf')).toBe('Shree_Ram_Bharose_Hotel_Report_2026-11-15.pdf');
    expect(reportFileName('Report', '2026-11-01', '2026-11-15', 'csv')).toBe('Shree_Ram_Bharose_Hotel_Report_2026-11-01_to_2026-11-15.csv');
  });
});

describe('order entry math & filters', () => {
  it('cart total in paise', () => {
    expect(cartTotal([
      { key: 'a', menuItemId: 'x', name: 'x', type: 'fixed', isThali: true, quantity: 3, unitPrice: 0.1 },
      { key: 'b', menuItemId: 'y', name: 'y', type: 'custom', isThali: false, quantity: 1, unitPrice: 0.2 },
    ])).toBe(0.5);
  });
  it.each([['25', 25], ['25.5', 25.5], ['0', null], ['1.234', null], ['abc', null], ['100001', null], ['', null]])('extra amount %s → %s', (v, r) => {
    expect(validExtra(v)).toBe(r);
  });
  it('AC price falls back to Non-AC price', () => {
    expect(priceFor({ price: 130, acPrice: 150 }, 'ac')).toBe(150);
    expect(priceFor({ price: 130, acPrice: null }, 'ac')).toBe(130);
    expect(priceFor({ price: 130, acPrice: 150 }, 'nonac')).toBe(130);
  });
  it('date presets', () => {
    expect(presetRange('today', '2026-11-15')).toEqual({ from: '2026-11-15', to: '2026-11-15' });
    expect(presetRange('yesterday', '2026-11-01')).toEqual({ from: '2026-10-31', to: '2026-10-31' });
    expect(presetRange('last7', '2026-11-15')).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    expect(presetRange('last30', '2026-11-15').from).toBe(addDays('2026-11-15', -29));
  });
  it('formats INR with Indian grouping', () => expect(inr(123456.5)).toBe('₹1,23,456.5'));
});
