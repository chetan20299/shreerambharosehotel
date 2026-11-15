export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface MenuItem {
  id: string; name: string; price: number; type: 'fixed' | 'custom';
  isThali: boolean; active: boolean; description?: string; sort?: number;
  /** Price in AC hall; null/undefined = same as `price` (Non-AC). */
  acPrice?: number | null;
}
export type PriceCategory = 'ac' | 'nonac';
export const CATEGORY_LABEL: Record<PriceCategory, string> = { ac: 'AC Hall', nonac: 'Non-AC Hall' };
export interface LineInput { menuItemId: string; quantity: number; unitPrice?: number; description?: string }
export interface OrderItem {
  menuItemId: string; name: string; type: 'fixed' | 'custom'; isThali: boolean;
  quantity: number; unitPrice: number; amount: number; description: string;
}
export interface Order {
  id: string; billNo: string; date: string; time: string;
  waiterId: string; waiterName: string; tableId: string; tableLabel: string;
  items: OrderItem[]; total: number; status: 'confirmed' | 'billed' | 'cancelled';
  createdAt: string; printCount?: number; cancelReason?: string; offline?: boolean; conflict?: boolean;
  priceCategory?: PriceCategory;
}

const MAX_PRICE = 100_000;
const isTwoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

/** Server-authoritative pricing. Money math in integer paise. Snapshots name/price at order time. */
export function buildItems(lines: LineInput[], menu: Map<string, MenuItem>, category: PriceCategory = 'nonac') {
  if (!lines.length) throw new HttpError(400, 'Order has no items');
  let totalP = 0;
  const items: OrderItem[] = lines.map((l) => {
    const m = menu.get(l.menuItemId);
    if (!m || !m.active) throw new HttpError(400, 'A menu item is no longer available. Refresh the menu.');
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 500) throw new HttpError(400, 'Invalid quantity');
    const unit = m.type === 'custom' ? l.unitPrice : category === 'ac' ? (m.acPrice ?? m.price) : m.price;
    if (unit == null || !(unit > 0) || unit > MAX_PRICE || !isTwoDecimals(unit)) {
      throw new HttpError(400, `Invalid amount for ${m.name}`);
    }
    const unitP = Math.round(unit * 100);
    const amountP = unitP * l.quantity;
    totalP += amountP;
    return {
      menuItemId: m.id, name: m.name, type: m.type, isThali: m.isThali,
      quantity: l.quantity, unitPrice: unitP / 100, amount: amountP / 100,
      description: (l.description ?? '').trim().slice(0, 120),
    };
  });
  return { items, total: totalP / 100 };
}

type Bucket = { key: string; label: string; orders: number; amount: number };

/** Aggregates for dashboard + reports. Cancelled orders are counted separately and excluded from totals. */
export function summarize(orders: Order[]) {
  const live = orders.filter((o) => o.status !== 'cancelled');
  const byItem = new Map<string, { menuItemId: string; name: string; isThali: boolean; type: string; quantity: number; amount: number }>();
  const add = (m: Map<string, Bucket>, key: string, label: string, amt: number) => {
    const b = m.get(key) ?? { key, label, orders: 0, amount: 0 };
    b.orders += 1; b.amount += amt; m.set(key, b);
  };
  const byDay = new Map<string, Bucket>(), byWaiter = new Map<string, Bucket>(), byTable = new Map<string, Bucket>(), byCategory = new Map<string, Bucket>(), byHour = new Map<string, Bucket>();
  let totalP = 0, extraP = 0, thalis = 0;
  for (const o of live) {
    const oP = Math.round(o.total * 100);
    totalP += oP;
    add(byDay, o.date, o.date, oP); add(byWaiter, o.waiterId, o.waiterName, oP); add(byTable, o.tableId, o.tableLabel, oP);
    const cat = o.priceCategory ?? 'nonac';
    add(byCategory, cat, CATEGORY_LABEL[cat], oP);
    const h = (o.time ?? '00').slice(0, 2);
    add(byHour, h, `${h}:00`, oP);
    for (const it of o.items) {
      const aP = Math.round(it.amount * 100);
      const b = byItem.get(it.menuItemId) ?? { menuItemId: it.menuItemId, name: it.name, isThali: it.isThali, type: it.type, quantity: 0, amount: 0 };
      b.quantity += it.quantity; b.amount += aP; byItem.set(it.menuItemId, b);
      if (it.isThali) thalis += it.quantity;
      if (it.type === 'custom') extraP += aP;
    }
  }
  const rupees = <T extends { amount: number }>(x: T) => ({ ...x, amount: x.amount / 100 });
  return {
    orderCount: live.length,
    cancelledCount: orders.length - live.length,
    totalAmount: totalP / 100,
    thaliCount: thalis,
    extraAmount: extraP / 100,
    byItem: [...byItem.values()].map(rupees).sort((a, b) => b.amount - a.amount),
    byDay: [...byDay.values()].map(rupees).sort((a, b) => a.key.localeCompare(b.key)),
    byWaiter: [...byWaiter.values()].map(rupees).sort((a, b) => b.amount - a.amount),
    byTable: [...byTable.values()].map(rupees).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    byCategory: [...byCategory.values()].map(rupees).sort((a, b) => a.key.localeCompare(b.key)),
    byHour: [...byHour.values()].map(rupees).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export const HOTEL_NAME = 'Shree Ram Bharose Hindu Hotel';

/** Backup/export JSON shape (matches the spec's example). */
export const toExportJson = (orders: Order[], fromDate: string, toDate: string) => ({
  hotel: HOTEL_NAME,
  exportDate: new Date().toISOString(),
  fromDate, toDate,
  transactions: orders.map((o) => ({
    orderId: o.id, billNo: o.billNo, date: o.date, time: o.time, waiterId: o.waiterId, waiterName: o.waiterName,
    tableNumber: o.tableLabel, hall: CATEGORY_LABEL[o.priceCategory ?? 'nonac'], status: o.status, createdAt: o.createdAt,
    items: o.items.map((i) => ({ menuItemId: i.menuItemId, name: i.name, quantity: i.quantity, price: i.unitPrice, amount: i.amount, description: i.description })),
    totalAmount: o.total,
  })),
});
