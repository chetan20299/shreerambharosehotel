import type { Order, Settings } from '../types';

/** Thermal printers use a basic code page: replace characters they cannot print. Bills are always English. */
export const ascii = (s: string) =>
  s.replace(/₹/g, 'Rs.').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...')
    .normalize('NFKD').replace(/[^\x20-\x7E]/g, '');

export const PROVISIONAL = 'PROVISIONAL';
export const HALL = { ac: 'AC Hall', nonac: 'Non-AC Hall' } as const;
export const columns =(paperWidth: 58 | 80) => (paperWidth === 80 ? 48 : 32);

const wrap = (s: string, w: number) => {
  const out: string[] = [];
  let line = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if ((line + ' ' + word).trim().length > w) { if (line) out.push(line); line = word.slice(0, w); }
    else line = (line + ' ' + word).trim();
  }
  if (line) out.push(line);
  return out.length ? out : [''];
};
export const lr = (l: string, r: string, w: number) => l + ' '.repeat(Math.max(1, w - l.length - r.length)) + r;
/** "left ... right" on one line when it fits, otherwise two lines (never wider than the paper). */
const pair = (l: string, r: string, w: number): Line[] =>
  l.length + r.length + 1 <= w ? [{ text: lr(l, r, w) }] : [...wrap(l, w), ...wrap(r, w)].map((text) => ({ text }));
export const center =(s: string, w: number) => ' '.repeat(Math.max(0, Math.floor((w - s.length) / 2))) + s;
const rs = (n: number) => n.toFixed(2);

export type Line = { text: string; bold?: boolean; big?: boolean; align?: 'left' | 'center' };

/** Receipt as plain text lines — used by ESC/POS, RawBT and the on-screen/PDF preview so all match. */
export function receiptLines(o: Order, s: Settings): Line[] {
  const w = columns(s.paperWidth);
  const hr = { text: '-'.repeat(w) };
  const lines: Line[] = [
    ...wrap(ascii(s.hotelName.toUpperCase()), w).map((t) => ({ text: t, bold: true, align: 'center' as const })),
    ...(s.address ? wrap(ascii(s.address), w).map((t) => ({ text: t, align: 'center' as const })) : []),
    ...(s.phone ? [{ text: ascii(`Ph: ${s.phone}`), align: 'center' as const }] : []),
    ...(s.gstin ? [{ text: ascii(`GSTIN: ${s.gstin}`), align: 'center' as const }] : []),
    hr,
    ...(o.billNo === PROVISIONAL ? [{ text: '** PROVISIONAL - NOT SAVED **', bold: true, align: 'center' as const }] : []),
    ...(o.tableId ? pair(`Bill No: ${o.billNo}`, `Table: ${ascii(o.tableLabel)}`, w) : [{ text: `Bill No: ${o.billNo}` }]),
    ...pair(`Date: ${o.date.split('-').reverse().join('-')}`, `Time: ${o.time.slice(0, 5)}`, w),
    ...wrap(ascii(`Waiter: ${o.waiterName}`), w).map((text) => ({ text })),
    ...(o.priceCategory ? [{ text: `Hall: ${HALL[o.priceCategory]}` }] : []),
    hr,
    { text: lr('Item', 'Amount', w), bold: true },
    { text: lr('  Qty x Rate', '', w).trimEnd() },
    hr,
  ];
  for (const it of o.items) {
    const name = it.description ? `${it.name} (${it.description})` : it.name;
    wrap(ascii(name), w).forEach((t) => lines.push({ text: t }));
    lines.push({ text: lr(`  ${it.quantity} x ${rs(it.unitPrice)}`, rs(it.amount), w) });
  }
  lines.push(hr, { text: lr('GRAND TOTAL', `Rs.${rs(o.total)}`, w), bold: true }, hr);
  if (o.status === 'cancelled') lines.push({ text: '*** CANCELLED ***', bold: true, align: 'center' });
  if (s.footer) wrap(ascii(s.footer), w).forEach((t) => lines.push({ text: t, align: 'center' }));
  return lines;
}
