import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { Loader } from '../components/Brand';
import { SimpleChart } from '../components/Chart';
import { Empty, PageHeader, useUi } from '../components/ui';
import { inr, monthLabel } from '../utils/format';
import type { MonthlySummary } from '../types';

/** Last 12 months of rolled-up totals (one entry per month, created by the nightly retention job). */
export default function HistoryPage() {
  const { t } = useI18n();
  const { errorText } = useUi();
  const { data, loading, error } = useApi<MonthlySummary[]>('/monthly');
  const months = [...(data ?? [])].reverse();

  return (
    <div>
      <PageHeader title={t('history.title')} />
      <p className="text-muted mb-4">{t('history.help')}</p>
      {loading && !data ? <Loader label={t('loader.loading')} /> : error ? <Empty text={errorText(error)} /> : !data?.length ? <Empty text={t('history.none')} /> : (
        <div className="space-y-4">
          <section className="card p-4">
            <h2 className="font-bold mb-3">{t('dash.sales')}</h2>
            <SimpleChart type="bar" label={t('dash.sales')} labels={months.map((m) => m.month)} values={months.map((m) => m.totalAmount)} color="#B4441B" format={inr} />
          </section>
          <div className="grid gap-3 md:grid-cols-2">
            {data.map((m) => (
              <details key={m.month} className="card p-4">
                <summary className="cursor-pointer flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-bold text-lg">{monthLabel(m.month)}</span>
                  <span className="font-bold text-primary text-lg tabular-nums">{inr(m.totalAmount)}</span>
                </summary>
                <div className="grid grid-cols-3 gap-2 mt-3 text-sm">
                  <div><div className="text-muted">{t('dash.orders')}</div><b>{m.orderCount}</b></div>
                  <div><div className="text-muted">{t('dash.thalis')}</div><b>{m.thaliCount}</b></div>
                  <div><div className="text-muted">{t('reports.extra')}</div><b>{inr(m.extraAmount)}</b></div>
                </div>
                <table className="w-full text-sm mt-3">
                  <thead><tr><th className="th">{t('common.item')}</th><th className="th text-right">{t('common.qty')}</th><th className="th text-right">{t('common.amount')}</th></tr></thead>
                  <tbody>{m.byItem.map((i) => <tr key={i.menuItemId}><td className="td">{i.name}</td><td className="td text-right">{i.quantity}</td><td className="td text-right">{inr(i.amount)}</td></tr>)}</tbody>
                </table>
                <table className="w-full text-sm mt-3">
                  <thead><tr><th className="th">{t('common.waiter')}</th><th className="th text-right">{t('dash.orders')}</th><th className="th text-right">{t('common.amount')}</th></tr></thead>
                  <tbody>{m.byWaiter.map((w) => <tr key={w.key}><td className="td">{w.label}</td><td className="td text-right">{w.orders}</td><td className="td text-right">{inr(w.amount)}</td></tr>)}</tbody>
                </table>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
