import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { Filters, filterQuery, initialFilters } from '../components/Filters';
import { ShareBar, SimpleChart } from '../components/Chart';
import { Empty, PageHeader, SkeletonGrid, useUi } from '../components/ui';
import { inr } from '../utils/format';
import type { Order, Summary, TableStatus } from '../types';

interface Dash {
  from: string; to: string; summary: Summary; recent: Order[];
  previous: { from: string; to: string; orderCount: number; totalAmount: number; thaliCount: number; extraAmount: number } | null;
  tableStatus: Partial<Record<TableStatus, number>>; activeWaiters: { id: string; displayName: string }[];
}
const C = { primary: '#B4441B', secondary: '#1F5F4A', ac: '#1D4E89', nonac: '#E2A62B' };
const STATUS_ICON: Record<TableStatus, string> = { available: '🟢', in_progress: '🟡', occupied: '🟠', billed: '🟣' };
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

function Card({ title, subtitle, children, className = '' }: { title: string; subtitle?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-4 min-w-0 ${className}`}>
      <div className="mb-3"><h2 className="font-bold">{title}</h2>{subtitle && <div className="text-sm text-muted">{subtitle}</div>}</div>
      {children}
    </section>
  );
}

/** KPI tile with change vs the previous period of equal length. */
function Kpi({ label, value, now, prev, tone = 'text-ink', note }: { label: string; value: string | number; now?: number; prev?: number | null; tone?: string; note?: string }) {
  const delta = prev != null && now != null ? (prev === 0 ? (now > 0 ? 100 : 0) : Math.round(((now - prev) / prev) * 100)) : null;
  return (
    <div className="card p-3 sm:p-4 min-w-0">
      <div className="text-sm font-semibold text-muted truncate">{label}</div>
      <div className={`text-xl sm:text-2xl font-bold mt-1 tabular-nums ${tone}`}>{value}</div>
      {delta != null && (
        <div className={`text-xs font-semibold mt-1 ${delta > 0 ? 'text-success' : delta < 0 ? 'text-error' : 'text-muted'}`}>
          {delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} {Math.abs(delta)}% <span className="text-muted font-normal">{note}</span>
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const { t } = useI18n();
  const { errorText } = useUi();
  const [f, setF] = useState(initialFilters('today'));
  // Free-tier pacing: refresh every 2 min while visible (server answers from cache + per-day totals).
  const { data, loading, error } = useApi<Dash>('/dashboard', filterQuery(f), { poll: 120_000 });
  const s = data?.summary;
  const prev = data?.previous;
  const n = data ? days(data.from, data.to) : 1;
  const vs = t('dash.vsPrev', { n });

  let run = 0;
  const trend = (s?.byDay ?? []).map((d) => (run += d.amount));
  const avg = s && s.orderCount ? s.totalAmount / s.orderCount : 0;
  const prevAvg = prev && prev.orderCount ? prev.totalAmount / prev.orderCount : prev ? 0 : null;
  const peak = s?.byHour?.length ? [...s.byHour].sort((a, b) => b.amount - a.amount)[0] : undefined;
  const bestDay = s && s.byDay.length > 1 ? [...s.byDay].sort((a, b) => b.amount - a.amount)[0] : undefined;
  const topItem = s?.byItem.length ? [...s.byItem].sort((a, b) => b.quantity - a.quantity)[0] : undefined;
  const hours = (() => { // continuous hour axis between first and last busy hour (gaps shown as zero)
    const hs = (s?.byHour ?? []).map((h) => Number(h.key));
    if (!hs.length) return [];
    const out = [];
    for (let h = Math.min(...hs); h <= Math.max(...hs); h++) {
      const b = s!.byHour!.find((x) => Number(x.key) === h);
      out.push({ label: `${String(h).padStart(2, '0')}:00`, amount: b?.amount ?? 0, orders: b?.orders ?? 0 });
    }
    return out;
  })();

  return (
    <div>
      <PageHeader title={t('dash.title')} />
      <Filters value={f} onChange={setF} admin times={false} />
      {loading && !data ? (
        <div className="space-y-4"><SkeletonGrid count={5} className="grid-cols-2 md:grid-cols-3 xl:grid-cols-5" /><SkeletonGrid count={4} className="grid-cols-1 lg:grid-cols-2" h="h-64" /></div>
      ) : error && !data ? <Empty text={errorText(error)} /> : s && data && (
        <div className="space-y-4">
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
            <Kpi label={t('dash.sales')} value={inr(s.totalAmount)} now={s.totalAmount} prev={prev?.totalAmount} tone="text-primary" note={vs} />
            <Kpi label={t('dash.orders')} value={s.orderCount} now={s.orderCount} prev={prev?.orderCount} note={vs} />
            <Kpi label={t('dash.avgBill')} value={inr(Math.round(avg))} now={avg} prev={prevAvg} note={vs} />
            <Kpi label={t('dash.thalis')} value={s.thaliCount} now={s.thaliCount} prev={prev?.thaliCount} tone="text-secondary" note={vs} />
            <Kpi label={t('reports.extra')} value={inr(s.extraAmount)} now={s.extraAmount} prev={prev?.extraAmount} tone="text-primary-dark" note={vs} />
          </div>
          {prev && prev.orderCount === 0 && s.orderCount > 0 && <p className="text-xs text-muted -mt-2">{t('dash.noPrev')}</p>}

          {s.orderCount > 0 && (
            <div className="grid gap-4 lg:grid-cols-3">
              <Card title={t('dash.insights')} className="lg:col-span-1">
                <ul className="space-y-2 text-sm">
                  {peak && <li className="flex gap-2"><span aria-hidden>⏰</span><span>{t('dash.peak', { hour: peak.label })} · <b>{inr(peak.amount)}</b></span></li>}
                  {bestDay && <li className="flex gap-2"><span aria-hidden>📅</span><span>{t('dash.bestDay', { day: bestDay.label })} · <b>{inr(bestDay.amount)}</b></span></li>}
                  {topItem && <li className="flex gap-2"><span aria-hidden>🍽️</span><span>{t('dash.topItem', { name: topItem.name })} · <b>×{topItem.quantity}</b></span></li>}
                  {s.byItem.filter((i) => i.isThali).map((i) => <li key={i.menuItemId} className="flex gap-2"><span aria-hidden>•</span><span>{i.name}: <b>{i.quantity}</b> · {inr(i.amount)}</span></li>)}
                </ul>
              </Card>
              <Card title={t('dash.hallSplit')} className="lg:col-span-2">
                <ShareBar parts={(['nonac', 'ac'] as const).map((k) => {
                  const b = s.byCategory?.find((c) => c.key === k);
                  return { label: `${k === 'ac' ? '❄️' : '🌀'} ${t(`hall.${k}`)} · ${b?.orders ?? 0} ${t('dash.orders')}`, value: b?.amount ?? 0, color: k === 'ac' ? C.ac : C.nonac, display: inr(b?.amount ?? 0) };
                })} />
              </Card>
            </div>
          )}

          {s.orderCount === 0 ? <Empty text={t('orders.none')} /> : (
            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              <Card title={t('dash.dailySales')} subtitle={`${t('dash.avgBill')}: ${inr(Math.round(avg))}`}>
                <SimpleChart type="bar" label={t('dash.dailySales')} labels={s.byDay.map((d) => d.label.slice(5))} values={s.byDay.map((d) => d.amount)} color={C.primary} format={inr}
                  extra={(i) => `${s.byDay[i]!.orders} ${t('dash.orders')}`} />
              </Card>
              <Card title={t('dash.trend')}>
                <SimpleChart type="line" label={t('dash.trend')} labels={s.byDay.map((d) => d.label.slice(5))} values={trend} color={C.secondary} format={inr} />
              </Card>
              {hours.length > 0 && (
                <Card title={t('dash.busyHours')} subtitle={peak && t('dash.peak', { hour: peak.label })}>
                  <SimpleChart type="bar" label={t('dash.busyHours')} labels={hours.map((h) => h.label)} values={hours.map((h) => h.amount)} color={C.primary} format={inr}
                    extra={(i) => `${hours[i]!.orders} ${t('dash.orders')}`} />
                </Card>
              )}
              <Card title={t('dash.itemQty')}>
                <SimpleChart type="hbar" share label={t('dash.itemQty')} labels={s.byItem.map((i) => i.name)} values={s.byItem.map((i) => i.quantity)} color={C.secondary}
                  extra={(i) => inr(s.byItem[i]!.amount)} />
              </Card>
              <Card title={t('dash.waiterSales')}>
                <SimpleChart type="hbar" share label={t('dash.waiterSales')} labels={s.byWaiter.map((w) => w.label)} values={s.byWaiter.map((w) => w.amount)} color={C.primary} format={inr}
                  extra={(i) => `${s.byWaiter[i]!.orders} ${t('dash.orders')}`} />
              </Card>
              <Card title={t('dash.tableOrders')}>
                <SimpleChart type="bar" label={t('dash.tableOrders')} labels={s.byTable.map((x) => x.label)} values={s.byTable.map((x) => x.orders)} color={C.secondary}
                  extra={(i) => inr(s.byTable[i]!.amount)} />
              </Card>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <Card title={t('dash.activeWaiters')}>
              {data.activeWaiters.length ? <div className="flex flex-wrap gap-2">{data.activeWaiters.map((w) => <span key={w.id} className="chip bg-secondary-soft text-secondary">● {w.displayName}</span>)}</div>
                : <p className="text-muted">{t('common.noData')}</p>}
            </Card>
            <Card title={t('dash.tableStatus')}>
              <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2">
                {(['available', 'in_progress', 'occupied'] as TableStatus[]).map((st) => (
                  <div key={st} className="rounded-xl border border-line p-2 flex items-center justify-between gap-2 min-h-12">
                    <span className="text-sm min-w-0">{STATUS_ICON[st]} {t(`tables.${st}`)}</span><b className="tabular-nums">{data.tableStatus[st] ?? 0}</b>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card title={t('dash.recent')}>
            {!data.recent.length ? <p className="text-muted">{t('orders.none')}</p> : (
              <>
                {/* Phones: cards. Tablets/desktop: table. */}
                <div className="grid gap-2 md:hidden">
                  {data.recent.map((o) => (
                    <Link key={o.id} to={`/orders/${o.id}`} className={`rounded-xl border border-line p-3 flex items-center justify-between gap-2 ${o.status === 'cancelled' ? 'opacity-60 line-through' : ''}`}>
                      <span className="min-w-0"><b className="text-primary">#{o.billNo}</b><span className="block text-xs text-muted truncate">{o.time.slice(0, 5)} · {o.tableLabel} · {o.waiterName}</span></span>
                      <b className="tabular-nums">{inr(o.total)}</b>
                    </Link>
                  ))}
                </div>
                <div className="hidden md:block overflow-x-auto"><table className="w-full text-sm">
                  <thead><tr><th className="th">{t('bill.billNo')}</th><th className="th">{t('common.time')}</th><th className="th">{t('common.table')}</th><th className="th">{t('common.waiter')}</th><th className="th text-right">{t('common.total')}</th></tr></thead>
                  <tbody>{data.recent.map((o) => (
                    <tr key={o.id} className={o.status === 'cancelled' ? 'line-through text-muted' : ''}>
                      <td className="td"><Link className="text-primary font-semibold" to={`/orders/${o.id}`}>{o.billNo}</Link></td>
                      <td className="td">{o.date.slice(5)} {o.time.slice(0, 5)}</td><td className="td">{o.tableLabel}</td><td className="td">{o.waiterName}</td>
                      <td className="td text-right tabular-nums">{inr(o.total)}</td>
                    </tr>))}</tbody>
                </table></div>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
