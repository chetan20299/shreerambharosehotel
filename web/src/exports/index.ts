import type { Order, Settings, Summary } from '../types';
import { ascii, receiptLines } from '../printing/receipt';

// All exported files are English-only, regardless of the UI language.
export const HOTEL = 'Shree Ram Bharose Hindu Hotel';
const FILE_PREFIX = 'Shree_Ram_Bharose_Hotel';

export const reportFileName = (kind: string, from: string, to: string, ext: string) =>
  `${FILE_PREFIX}_${kind}_${from}${to !== from ? `_to_${to}` : ''}.${ext}`;

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

/** One row per order item (detailed report). Guards against CSV/formula injection. */
export function toCsv(orders: Order[]) {
  const head = ['Order ID', 'Bill No', 'Date', 'Time', 'Waiter', 'Item', 'Note', 'Quantity', 'Rate', 'Amount', 'Order Total', 'Status'];
  const rows = orders.flatMap((o) => o.items.map((i) => [
    o.id, o.billNo, o.date, o.time, o.waiterName, i.name, i.description, i.quantity,
    i.unitPrice.toFixed(2), i.amount.toFixed(2), o.total.toFixed(2), o.status,
  ]));
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export const toJson = (orders: Order[], from: string, to: string) => JSON.stringify({
  hotel: HOTEL, exportDate: new Date().toISOString(), fromDate: from, toDate: to,
  transactions: orders.map((o) => ({
    orderId: o.id, billNo: o.billNo, date: o.date, time: o.time, waiterId: o.waiterId, waiterName: o.waiterName,
    status: o.status, createdAt: o.createdAt,
    items: o.items.map((i) => ({ menuItemId: i.menuItemId, name: i.name, quantity: i.quantity, price: i.unitPrice, amount: i.amount, description: i.description })),
    totalAmount: o.total,
  })),
}, null, 2);

async function pngDataUrl(src: string) {
  const blob = await (await fetch(src)).blob();
  return new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob); });
}

const rs = (n: number) => `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function reportPdf(orders: Order[], summary: Summary, range: string) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const logo = await pngDataUrl('/brand/logo-horizontal.png').catch(() => null);
  if (logo) doc.addImage(logo, 'PNG', 14, 10, 70, 17.8);
  doc.setFontSize(16).setFont('helvetica', 'bold').text(HOTEL, 196, 16, { align: 'right' });
  doc.setFontSize(10).setFont('helvetica', 'normal')
    .text(`Sales report: ${range}`, 196, 22, { align: 'right' })
    .text(`Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`, 196, 27, { align: 'right' });
  autoTable(doc, {
    startY: 34, theme: 'grid', headStyles: { fillColor: [180, 68, 27] },
    head: [['Total orders', 'Total thalis', 'Extra collection', 'Total collection', 'Cancelled']],
    body: [[summary.orderCount, summary.thaliCount, rs(summary.extraAmount), rs(summary.totalAmount), summary.cancelledCount]],
  });
  autoTable(doc, {
    theme: 'striped', headStyles: { fillColor: [31, 95, 74] },
    head: [['Item-wise summary', 'Quantity', 'Amount']],
    body: summary.byItem.map((i) => [ascii(i.name) + (i.isThali ? ' (thali)' : ''), i.quantity, rs(i.amount)]),
    foot: [['Total', summary.byItem.reduce((s, i) => s + i.quantity, 0), rs(summary.totalAmount)]],
    footStyles: { fillColor: [251, 239, 211], textColor: [43, 29, 20] },
  });
  autoTable(doc, {
    theme: 'grid', styles: { fontSize: 8 }, headStyles: { fillColor: [43, 29, 20] },
    head: [['Bill No', 'Date', 'Time', 'Waiter', 'Item', 'Qty', 'Rate', 'Amount', 'Total', 'Status']],
    body: orders.flatMap((o) => o.items.map((i, k) => [
      k ? '' : o.billNo, k ? '' : o.date, k ? '' : o.time.slice(0, 5), k ? '' : ascii(o.waiterName),
      ascii(i.name + (i.description ? ` (${i.description})` : '')), i.quantity, i.unitPrice.toFixed(2), i.amount.toFixed(2),
      k ? '' : o.total.toFixed(2), k ? '' : o.status,
    ])),
    foot: [['', '', '', '', '', '', '', 'Total', summary.totalAmount.toFixed(2), '']],
  });
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) doc.setPage(p).setFontSize(8).text(`Page ${p} of ${pages}`, 196, 290, { align: 'right' });
  return doc.output('blob');
}

export async function billPdf(order: Order, settings: Settings) {
  const { jsPDF } = await import('jspdf');
  const lines = receiptLines(order, settings);
  const width = settings.paperWidth === 80 ? 80 : 58;
  const fs = settings.paperWidth === 80 ? 8.5 : 7.2;
  const lh = fs * 0.42;
  const doc = new jsPDF({ unit: 'mm', format: [width, 34 + lines.length * lh + 10] });
  const logo = await pngDataUrl('/brand/logo-bill.png').catch(() => null);
  if (logo) doc.addImage(logo, 'PNG', width / 2 - 12, 4, 24, 24);
  doc.setFont('courier');
  let y = 34;
  for (const l of lines) {
    doc.setFont('courier', l.bold ? 'bold' : 'normal').setFontSize(fs);
    doc.text(l.text, l.align === 'center' ? width / 2 : 3, y, { align: l.align === 'center' ? 'center' : 'left' });
    y += lh;
  }
  return doc.output('blob');
}

export type DeliverResult = 'shared' | 'downloaded' | 'cancelled';

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Android share sheet (WhatsApp etc.) when supported; otherwise downloads. Reports "shared" only when the OS confirms. */
export async function shareOrDownload(blob: Blob, filename: string, title: string): Promise<DeliverResult> {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title, text: title }); return 'shared'; }
    catch (e) { if ((e as DOMException).name === 'AbortError') return 'cancelled'; }
  }
  download(blob, filename);
  return 'downloaded';
}
