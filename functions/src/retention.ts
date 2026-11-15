import { db, Timestamp, FieldValue } from './db.js';
import { saveBackup } from './backup.js';
import { summarize, toExportJson, type Order } from './orders.js';
import { istToday, istToUtc } from './time.js';
import { FLOOR, readFloor, freeTable } from './store.js';

/**
 * Monthly retention policy (runs nightly + on demand):
 *  - Current IST month: full order detail is kept.
 *  - Earlier months: orders are rolled up into ONE `monthlySummaries/{YYYY-MM}` doc, backed up to Storage as JSON,
 *    then deleted. Summary write + order deletes happen in the same transaction (no double counting on retry).
 *  - Only the last 12 monthly summaries are kept; older ones are deleted.
 */
type Summary = ReturnType<typeof summarize>;
type Row = { amount: number } & Record<string, unknown>;

const monthOf = (date: string) => date.slice(0, 7);
export function addMonths(month: string, n: number) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function mergeRows<T extends Row>(a: T[], b: T[], key: keyof T, counters: (keyof T)[]): T[] {
  const m = new Map<unknown, T>(a.map((r) => [r[key], { ...r }]));
  for (const r of b) {
    const cur = m.get(r[key]);
    if (!cur) { m.set(r[key], { ...r }); continue; }
    for (const c of counters) (cur[c] as number) = Math.round(((cur[c] as number) + (r[c] as number)) * 100) / 100;
  }
  return [...m.values()];
}

/** Adds summary `b` into `a` (both shaped like summarize()). Exported for tests. */
export function mergeSummaries(a: Summary | undefined, b: Summary): Summary {
  if (!a) return b;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    orderCount: a.orderCount + b.orderCount,
    cancelledCount: a.cancelledCount + b.cancelledCount,
    totalAmount: r2(a.totalAmount + b.totalAmount),
    thaliCount: a.thaliCount + b.thaliCount,
    extraAmount: r2(a.extraAmount + b.extraAmount),
    byItem: mergeRows(a.byItem, b.byItem, 'menuItemId', ['quantity', 'amount']).sort((x, y) => y.amount - x.amount),
    byDay: mergeRows(a.byDay, b.byDay, 'key', ['orders', 'amount']).sort((x, y) => x.key.localeCompare(y.key)),
    byWaiter: mergeRows(a.byWaiter, b.byWaiter, 'key', ['orders', 'amount']).sort((x, y) => y.amount - x.amount),
    byTable: mergeRows(a.byTable, b.byTable, 'key', ['orders', 'amount']).sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true })),
    byCategory: mergeRows(a.byCategory ?? [], b.byCategory, 'key', ['orders', 'amount']).sort((x, y) => x.key.localeCompare(y.key)),
    byHour: mergeRows(a.byHour ?? [], b.byHour ?? [], 'key', ['orders', 'amount']).sort((x, y) => x.key.localeCompare(y.key)),
  };
}

const toOrder = (d: FirebaseFirestore.QueryDocumentSnapshot): Order => {
  const x = d.data();
  return { ...(x as Order), id: d.id, createdAt: x.createdAt?.toDate().toISOString() ?? '' };
};

export async function runMonthlyRollup(now = new Date()) {
  const currentMonth = monthOf(istToday(now));
  const cutoff = Timestamp.fromDate(istToUtc(`${currentMonth}-01`));
  const rolled: Record<string, number> = {};

  for (;;) {
    // ponytail: 400 orders per transaction (Firestore 500-write limit); loops until nothing older than this month remains.
    const snap = await db.collection('orders').where('createdAt', '<', cutoff).orderBy('createdAt').limit(400).get();
    if (snap.empty) break;
    const orders = snap.docs.map(toOrder);
    const month = monthOf(orders[0]!.date);
    const docs = snap.docs.filter((_d, i) => monthOf(orders[i]!.date) === month);
    const chunk = orders.filter((o) => monthOf(o.date) === month);

    const dates = chunk.map((o) => o.date).sort();
    await saveBackup(`monthly_${month}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`, toExportJson(chunk, dates[0]!, dates.at(-1)!));

    const ref = db.doc(`monthlySummaries/${month}`);
    await db.runTransaction(async (tx) => {
      const existing = (await tx.get(ref)).data() as (Summary & { month: string }) | undefined;
      // Re-read inside the transaction so a concurrent run can't double count.
      const fresh = await tx.getAll(...docs.map((d) => d.ref));
      const live = fresh.filter((d) => d.exists).map((d) => toOrder(d as FirebaseFirestore.QueryDocumentSnapshot));
      if (!live.length) return;
      const merged = mergeSummaries(existing, summarize(live));
      tx.set(ref, { ...merged, month, updatedAt: FieldValue.serverTimestamp() });
      for (const d of fresh) if (d.exists) tx.delete(d.ref);
      rolled[month] = (rolled[month] ?? 0) + live.length;
    });
  }

  // Per-day totals of rolled-up months are no longer needed (the month summary replaces them).
  const oldDays = await db.collection('dailyStats').where('date', '<', `${currentMonth}-01`).get();
  await Promise.all(oldDays.docs.map((d) => d.ref.delete()));

  // Keep only the last 12 months of summaries.
  const oldest = addMonths(currentMonth, -12);
  const stale = await db.collection('monthlySummaries').where('month', '<', oldest).get();
  await Promise.all(stale.docs.map((d) => d.ref.delete()));

  // Free tables pointing at orders that no longer exist.
  const floor = await readFloor();
  for (const [tid, t] of Object.entries(floor.tables)) {
    if (t.order && !(await db.doc(`orders/${t.order}`).get()).exists) await FLOOR().update(freeTable(tid));
  }

  const result = { currentMonth, rolled, summariesDeleted: stale.docs.map((d) => d.id) };
  await db.collection('auditLogs').add({ actorId: 'system', actorName: 'Monthly retention', action: 'retention.rollup', details: result, at: FieldValue.serverTimestamp() });
  return result;
}
