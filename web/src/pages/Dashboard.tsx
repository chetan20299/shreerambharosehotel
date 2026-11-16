import { useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { Filters, filterQuery, initialFilters } from '../components/Filters';
import { SimpleChart } from '../components/Chart';
import { Empty, PageHeader, SkeletonGrid, Stat, useUi } from '../components/ui';
import { inr } from '../utils/format';
import type { Order, Summary } from '../types';

interface Dash { from: string; to: string; summary: Summary; recent: Order[]; expensesTotal?: number }

/** Simple dashboard: 4 numbers, AC vs Non-AC, one daily sales chart, top items, last 5 orders. */
export default function DashboardPage() {
  const { t } = useI18n();
  const { errorText } = useUi();
  const [f, setF] = useState(initialFilters('today'));
  const { data, loading, error } = useApi<Dash>('/dashboard', filterQuery(f), { poll: 120_000 });
  const s = data?.summary;
  const avg = s && s.orderCount ? Math.round(s.totalAmount / s.orderCount) : 0;
  const net = Math.round(((s?.totalAmount ?? 0) - (data?.expensesTotal ?? 0)) * 100) / 100;

  return (
    <div className="space-y-4">
      <PageHeader title={t('dash.title')} />
      <Filters value={f} onChange={setF} times={false} />
      {loading && !data ? <SkeletonGrid count={4} /> : error && !data ? <Empty text={errorText(error)} /> : s && data && (
        <>
          <p className="text-sm text-muted -mt-1" data-testid="dash-period">📅 {t('dash.showing', { range: data.from === data.to ? data.from : `${data.from} → ${data.to}` })}</p>

          {/* Money: income − expenses = net profit */}
          <div>
            <h2 className="font-bold mb-2">{t('dash.money')}</h2>
            <div className="grid grid-cols-1 min-[420px]:grid-cols-3 gap-3" data-testid="dash-profit">
              <Stat icon="💰" label={t('dash.income')} value={inr(s.totalAmount)} tone="secondary" hint={t('dash.incomeHint', { n: s.orderCount })} testId="stat-income" />
              <Stat icon="🧾" label={t('dash.expenses')} value={`− ${inr(data.expensesTotal ?? 0)}`} tone="error" hint={t('dash.expensesHint')} testId="stat-expenses" />
              <Stat icon={net >= 0 ? '📈' : '📉'} label={net >= 0 ? t('dash.netProfit') : t('dash.netLoss')} value={inr(Math.abs(net))} tone={net >= 0 ? 'success' : 'error'}
                hint={t('dash.netHint')} testId="stat-net" />
            </div>
          </div>

          {/* Sales details */}
          <div>
            <h2 className="font-bold mb-2">{t('dash.salesDetails')}</h2>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Stat icon="🧾" label={t('dash.bills')} value={s.orderCount} hint={s.cancelledCount ? t('reports.cancelledNote', { n: s.cancelledCount }) : undefined} />
              <Stat icon="🍽️" label={t('dash.thalis')} value={s.thaliCount} tone="secondary" />
              <Stat icon="➗" label={t('dash.avgBill')} value={inr(avg)} hint={t('dash.avgHint')} />
              <Stat icon="➕" label={t('reports.extra')} value={inr(s.extraAmount)} tone="accent" hint={t('dash.extraHint')} />
            </div>
          </div>

          {s.orderCount === 0 ? <Empty text={t('orders.none')} /> : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                {s.byDay.length > 1 && (
                  <section className="card p-4 min-w-0">
                    <h2 className="font-bold mb-3">{t('dash.dailySales')}</h2>
                    <SimpleChart type="bar" label={t('dash.dailySales')} labels={s.byDay.map((d) => d.label.slice(5))} values={s.byDay.map((d) => d.amount)}
                      color="#B4441B" format={inr} extra={(i) => `${s.byDay[i]!.orders} ${t('dash.orders')}`} />
                  </section>
                )}
                <section className="card p-4 min-w-0">
                  <h2 className="font-bold mb-3">{t('reports.itemSummary')}</h2>
                  <ul className="divide-y divide-line">
                    {s.byItem.slice(0, 6).map((i) => (
                      <li key={i.menuItemId} className="flex items-center justify-between gap-2 py-2 text-sm">
                        <span className="min-w-0 truncate">{i.name}</span>
                        <span className="shrink-0 tabular-nums"><b>×{i.quantity}</b> <span className="text-muted">· {inr(i.amount)}</span></span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>

              <section className="card p-4">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="font-bold">{t('dash.recent')}</h2>
                  <Link to="/orders" className="text-sm font-semibold text-primary">{t('nav.orders')} →</Link>
                </div>
                <ul className="divide-y divide-line">
                  {data.recent.slice(0, 5).map((o) => (
                    <li key={o.id}>
                      <Link to={`/orders/${o.id}`} className={`flex items-center justify-between gap-2 py-2 ${o.status === 'cancelled' ? 'opacity-60 line-through' : ''}`}>
                        <span className="min-w-0"><b className="text-primary">#{o.billNo}</b> <span className="text-sm text-muted">{o.time.slice(0, 5)} · {o.waiterName}</span></span>
                        <b className="tabular-nums shrink-0">{inr(o.total)}</b>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
