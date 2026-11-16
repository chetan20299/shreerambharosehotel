import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { Filters, filterQuery, initialFilters, type FilterState } from '../components/Filters';
import { Loader } from '../components/Brand';
import { Empty, PageHeader, SkeletonGrid, SkeletonList, Stat, useUi } from '../components/ui';
import { download, reportFileName, reportPdf, shareOrDownload, HOTEL } from '../exports';
import { api } from '../services/api';
import { inr } from '../utils/format';
import type { Expense, Order, Summary } from '../types';

export const rangeLabel = (f: FilterState) =>
  `${f.from}${f.fromTime ? ` ${f.fromTime}` : ''}${f.to !== f.from || f.toTime ? ` to ${f.to}${f.toTime ? ` ${f.toTime}` : ''}` : ''}`;

export default function ReportsPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const { toast, errorText } = useUi();
  const isAdmin = user?.role === 'admin';
  const [f, setF] = useState(initialFilters('today'));
  const { data, loading, error } = useApi<{ from: string; to: string; orders: Order[]; summary: Summary }>('/orders', filterQuery(f));
  const [busy, setBusy] = useState(false);
  const [withExpense, setWithExpense] = useState(true);

  /** PDF only. "With expenses" adds the Expenses table and the Net profit summary. */
  const exportPdf = async (share: boolean) => {
    if (!data) return;
    setBusy(true);
    try {
      const { from, to, orders, summary } = data; // server-clamped range (waiters: own orders, last 30 days)
      const expenses = withExpense ? (await api<{ expenses: Expense[] }>('/expenses', { query: { from, to } })).expenses : undefined;
      const blob = await reportPdf(orders, summary, rangeLabel({ ...f, from, to }), expenses);
      const name = reportFileName(withExpense ? 'Report_with_expenses' : 'Report', from, to, 'pdf');
      if (share) {
        const r = await shareOrDownload(blob, name, `${HOTEL} report ${from}`);
        if (r === 'cancelled') return;
        toast(r === 'shared' ? t('bill.shared') : t('bill.downloaded'), 'success');
      } else { download(blob, name); toast(t('bill.downloaded'), 'success'); }
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };

  const s = data?.summary;
  return (
    <div>
      <PageHeader title={t('reports.title')} />
      <Filters value={f} onChange={setF} admin={isAdmin} />
      {busy && <Loader full label={t('loader.export')} />}
      {loading && !data ? <div className="space-y-3"><SkeletonGrid count={4} /><SkeletonList rows={4} /></div> : error ? <Empty text={errorText(error)} /> : s && data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            <Stat label={t('reports.totalOrders')} value={s.orderCount} />
            <Stat label={t('reports.totalThalis')} value={s.thaliCount} tone="secondary" />
            <Stat label={t('reports.extra')} value={inr(s.extraAmount)} tone="accent" />
            <Stat label={t('reports.collection')} value={inr(s.totalAmount)} tone="primary" />
          </div>
          {s.cancelledCount > 0 && <p className="text-sm text-muted mb-2">{t('reports.cancelledNote', { n: s.cancelledCount })}</p>}

          <div className="card p-4 mb-4">
            <div className="font-bold mb-3">📤 {t('reports.download')} / {t('reports.share')}</div>
            <div className="label">{t('reports.pdfType')}</div>
            <div className="grid grid-cols-2 gap-2 mb-3" role="radiogroup" aria-label={t('reports.pdfType')}>
              {([true, false] as const).map((w) => (
                <button key={String(w)} type="button" role="radio" aria-checked={withExpense === w} onClick={() => setWithExpense(w)}
                  data-testid={w ? 'pdf-with-expense' : 'pdf-without-expense'}
                  className={`btn border ${withExpense === w ? 'bg-ink text-white border-ink' : 'bg-white border-line text-ink'}`}>
                  {w ? '🧾 ' + t('reports.withExpense') : '📄 ' + t('reports.withoutExpense')}</button>
              ))}
            </div>
            <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2">
              <button className="btn-primary" disabled={busy} onClick={() => exportPdf(false)} data-testid="export-pdf">⬇️ {t('reports.downloadPdf')}</button>
              <button className="btn-ghost" disabled={busy} onClick={() => exportPdf(true)} data-testid="share-pdf">📤 {t('reports.sharePdf')}</button>
            </div>
            <p className="text-xs text-muted mt-2">{t('reports.englishNote')} {t('reports.olderNote')}</p>
          </div>

          <h2 className="font-bold mb-2">{t('reports.itemSummary')}</h2>
          <div className="card overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead><tr><th className="th">{t('common.item')}</th><th className="th text-right">{t('common.qty')}</th><th className="th text-right">{t('common.amount')}</th></tr></thead>
              <tbody>{s.byItem.map((i) => <tr key={i.menuItemId}><td className="td">{i.name}{i.isThali ? ' 🍽️' : ''}</td><td className="td text-right tabular-nums">{i.quantity}</td><td className="td text-right tabular-nums">{inr(i.amount)}</td></tr>)}</tbody>
            </table>
          </div>

          <h2 className="font-bold mb-2">{t('reports.detailed')}</h2>
          {!data.orders.length ? <Empty text={t('orders.none')} /> : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead><tr>{(['bill.billNo', 'common.date', 'common.time', 'common.waiter', 'common.item', 'common.qty', 'common.rate', 'common.amount', 'common.total'] as const).map((k) =>
                  <th key={k} className={`th ${['common.qty', 'common.rate', 'common.amount', 'common.total'].includes(k) ? 'text-right' : ''}`}>{t(k)}</th>)}</tr></thead>
                <tbody>{data.orders.flatMap((o) => o.items.map((i, k) => (
                  <tr key={`${o.id}-${k}`} className={o.status === 'cancelled' ? 'line-through text-muted' : ''}>
                    <td className="td">{k ? '' : o.billNo}</td><td className="td">{k ? '' : o.date}</td><td className="td">{k ? '' : o.time.slice(0, 5)}</td>
                    <td className="td">{k ? '' : o.waiterName}</td>
                    <td className="td">{i.name}{i.description ? ` (${i.description})` : ''}</td>
                    <td className="td text-right tabular-nums">{i.quantity}</td><td className="td text-right tabular-nums">{inr(i.unitPrice)}</td>
                    <td className="td text-right tabular-nums">{inr(i.amount)}</td><td className="td text-right tabular-nums font-semibold">{k ? '' : inr(o.total)}</td>
                  </tr>)))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
