import { db, FieldValue, Timestamp } from './db.js';
import { hashPassword } from './security.js';
import { istParts } from './time.js';
import { summarize, type Order } from './orders.js';

const CATEGORIES = [
  { id: 'gujarati', name: 'Gujarati', active: true, sort: 10 },
  { id: 'punjabi', name: 'Punjabi', active: true, sort: 20 },
  { id: 'dalbati', name: 'Dal Bati', active: true, sort: 30 },
  { id: 'chinese', name: 'Chinese', active: false, sort: 40 }, // disabled: waiters don't see it until admin enables it
  { id: 'beverages', name: 'Beverages', active: true, sort: 50 },
  { id: 'extras', name: 'Extras', active: true, sort: 90 },
];

const MENU = [
  { id: 'thali-full', name: 'Gujarati Thali – Full', price: 130, acPrice: 150, type: 'fixed', isThali: true, active: true, categoryId: 'gujarati', description: 'Unlimited rotli, dal, bhaat, 2 shaak, farsan, sweet', sort: 10 },
  { id: 'thali-small', name: 'Gujarati Thali – Small', price: 50, acPrice: 60, type: 'fixed', isThali: true, active: true, categoryId: 'gujarati', description: 'Rotli, dal, bhaat, 1 shaak', sort: 20 },
  { id: 'extra', name: 'Extra', price: 0, acPrice: null, type: 'custom', isThali: false, active: true, categoryId: 'extras', description: 'Custom amount (buttermilk, papad, sweet…)', sort: 90 },
  { id: 'punjabi-thali', name: 'Punjabi Thali', price: 160, acPrice: 180, type: 'fixed', isThali: true, active: true, categoryId: 'punjabi', description: 'Paneer sabzi, dal makhani, 3 roti, rice, salad', sort: 30 },
  { id: 'dal-bati', name: 'Dal Bati Churma', price: 120, acPrice: 140, type: 'fixed', isThali: false, active: true, categoryId: 'dalbati', description: '3 bati, dal, churma', sort: 40 },
  { id: 'veg-manchurian', name: 'Veg Manchurian', price: 110, acPrice: 130, type: 'fixed', isThali: false, active: true, categoryId: 'chinese', description: '', sort: 50 },
  { id: 'water-bottle', name: 'Water Bottle (1L)', price: 20, acPrice: 20, type: 'fixed', isThali: false, active: true, categoryId: 'beverages', description: '', sort: 60 },
  { id: 'cold-drink', name: 'Cold Drink', price: 40, acPrice: 45, type: 'fixed', isThali: false, active: true, categoryId: 'beverages', description: '', sort: 70 },
] as const;

/** Initial menu (1 doc), floor plan with 2 halls, doors and 8 tables (1 doc). Only fills what is empty. */
export async function seedBase() {
  if (!(await db.doc('config/menu').get()).exists) {
    await db.doc('config/menu').set({
      categories: Object.fromEntries(CATEGORIES.map(({ id, ...c }) => [id, c])),
      items: Object.fromEntries(MENU.map(({ id, ...m }) => [id, m])),
    });
  }
  if (!(await db.doc('floorLayouts/main').get()).exists) {
    const tables: Record<string, object> = {};
    for (let i = 1; i <= 8; i++) {
      const family = i > 6;
      // grid blocks (column x, row y); busy-state fields are absent while a table is available
      tables[`t${i}`] = {
        label: `T${i}`, sectionId: family ? 'family' : 'hall', seats: family ? 6 : 4,
        x: family ? 1 + (i - 7) * 3 : 1 + ((i - 1) % 3) * 2, y: family ? 2 : 2 + Math.floor((i - 1) / 3) * 2,
      };
    }
    await db.doc('floorLayouts/main').set({
      sections: [
        { id: 'hall', name: 'Non-AC Hall', priceCategory: 'nonac', cols: 7, rows: 7 },
        { id: 'family', name: 'AC Hall', priceCategory: 'ac', cols: 6, rows: 5 },
      ],
      fixtures: [
        { id: 'f-entry', sectionId: 'hall', type: 'entry', x: 3, y: 6 },
        { id: 'f-exit', sectionId: 'hall', type: 'exit', x: 6, y: 6 },
        { id: 'f-kitchen', sectionId: 'hall', type: 'kitchen', x: 0, y: 0 },
        { id: 'f-door', sectionId: 'family', type: 'door', x: 0, y: 4 },
      ],
      tables,
    });
  }
}

export const DEMO_USERS = [
  { username: 'admin', displayName: 'Owner (Admin)', role: 'admin', password: 'Admin@123' },
  { username: 'ramesh', displayName: 'Ramesh', role: 'waiter', password: 'Waiter@123' },
  { username: 'suresh', displayName: 'Suresh', role: 'waiter', password: 'Waiter@123' },
] as const;

/** Demo-only: users with known passwords + ~2 weeks of sample orders so dashboards/reports have data. */
export async function seedDemo() {
  await seedBase();
  if ((await db.doc('users/admin').get()).exists) return;
  for (const u of DEMO_USERS) {
    await db.doc(`users/${u.username}`).set({
      username: u.username, displayName: u.displayName, role: u.role, active: true,
      passwordHash: await hashPassword(u.password), failedLogins: 0,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
  }
  // Deterministic pseudo-random sample history (yesterday and earlier, so "today" starts clean).
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 9301 + 49297) % 233280) / 233280) * n;
  const batch = db.batch();
  const byDate = new Map<string, Order[]>();
  const waiters = DEMO_USERS.filter((u) => u.role === 'waiter');
  // Last 14 days + a few days in the previous two months (so the monthly rollup has something to demonstrate).
  const days = [70, 64, 58, 51, 45, 40, 36, ...Array.from({ length: 14 }, (_, i) => 14 - i)];
  for (const day of days) {
    const count = 6 + Math.floor(rnd(8));
    for (let k = 0; k < count; k++) {
      const at = new Date(Date.now() - day * 86_400_000);
      at.setUTCHours(6 + Math.floor(rnd(10)), Math.floor(rnd(60)), Math.floor(rnd(60))); // 11:30–21:30 IST
      const { date, time } = istParts(at);
      const w = waiters[Math.floor(rnd(waiters.length))]!;
      const full = Math.floor(rnd(4)), small = full ? Math.floor(rnd(2)) : 1 + Math.floor(rnd(2));
      const tableNo = 1 + Math.floor(rnd(8));
      const ac = tableNo > 6; // T7, T8 are in the AC hall
      const pf = ac ? MENU[0].acPrice : MENU[0].price, ps = ac ? MENU[1].acPrice : MENU[1].price;
      const items = [
        ...(full ? [{ menuItemId: 'thali-full', name: MENU[0].name, type: 'fixed', isThali: true, quantity: full, unitPrice: pf, amount: full * pf, description: '' }] : []),
        ...(small ? [{ menuItemId: 'thali-small', name: MENU[1].name, type: 'fixed', isThali: true, quantity: small, unitPrice: ps, amount: small * ps, description: '' }] : []),
        ...(rnd(1) < 0.4 ? [{ menuItemId: 'extra', name: 'Extra', type: 'custom', isThali: false, quantity: 1, unitPrice: 20, amount: 20, description: 'Chaas' }] : []),
      ];
      const ref = db.collection('orders').doc();
      const doc = {
        billNo: `${date.slice(2).replaceAll('-', '')}-${String(k + 1).padStart(3, '0')}`, date, time,
        waiterId: w.username, waiterName: w.displayName, tableId: `t${tableNo}`, tableLabel: `T${tableNo}`,
        items, total: items.reduce((s, i) => s + i.amount, 0), status: 'billed', printCount: 1, priceCategory: ac ? 'ac' : 'nonac',
        createdAt: Timestamp.fromDate(at), demo: true,
      };
      batch.set(ref, doc);
      byDate.set(date, [...(byDate.get(date) ?? []), { ...doc, id: ref.id, createdAt: at.toISOString() } as unknown as Order]);
    }
  }
  await batch.commit();
  const stats = db.batch();
  for (const [date, list] of byDate) stats.set(db.doc(`dailyStats/${date}`), { ...summarize(list), date, seq: list.length });
  await stats.commit();
}
