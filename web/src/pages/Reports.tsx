import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { api } from '../services/api';
import { Filters, filterQuery, initialFilters, type FilterState } from '../components/Filters';
import { Loader } from '../components/Brand';
import { Empty, PageHeader, SkeletonGrid, SkeletonList, Stat, useUi } from '../components/ui';
import { download, reportFileName, reportPdf, shareOrDownload, toCsv, toJson, HOTEL } from '../exports';
import { inr } from '../utils/format';
import type { Order, Summary } from '../types';

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

  const exportAs = async (format: 'csv' | 'pdf' | 'json', share: boolean) => {
    if (!data) return;
    setBusy(true);
    try {
      const { from, to, orders, summary } = data; // server-clamped range (waiters: own orders, last 30 days)
      const blob = format === 'csv' ? new Blob([toCsv(orders)], { type: 'text/csv;charset=utf-8' })
        : format === 'json' ? new Blob([toJson(orders, from, to)], { type: 'application/json' })
        : await reportPdf(orders, summary, rangeLabel({ ...f, from, to }));
      const name = reportFileName('Report', from, to, format);
      let action: 'download' | 'share' = 'download';
      if (share) {
        const r = await shareOrDownload(blob, name, `${HOTEL} report ${from}`);
        if (r === 'cancelled') return;
        action = r === 'shared' ? 'share' : 'download';
        toast(r === 'shared' ? t('bill.shared') : t('bill.downloaded'), 'success');
      } else { download(blob, name); toast(t('bill.downloaded'), 'success'); }
      void api('/exports/log', { method: 'POST', body: { format, from, to, count: orders.length, action } }).catch(() => undefined);
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
            <div className="grid grid-cols-3 gap-2">
              {(['csv', 'pdf', 'json'] as const).map((fmt) => (
                <div key={fmt} className="grid gap-2">
                  <button className="btn-primary" disabled={busy} onClick={() => exportAs(fmt, false)} data-testid={`export-${fmt}`}>⬇️ {fmt.toUpperCase()}</button>
                  <button className="btn-ghost" disabled={busy} onClick={() => exportAs(fmt, true)}>📤 {t('reports.share')}</button>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted mt-2">{t('reports.englishNote')} {t('reports.olderNote')}</p>
          </div>

          {!!s.byCategory?.length && <>
            <h2 className="font-bold mb-2">{t('reports.byHall')}</h2>
            <div className="grid grid-cols-2 gap-3 mb-4">
              {s.byCategory.map((c) => <Stat key={c.key} label={`${c.key === 'ac' ? '❄️' : '🌀'} ${t(`hall.${c.key as 'ac' | 'nonac'}`)} · ${c.orders}`} value={inr(c.amount)} />)}
            </div>
          </>}
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
                <thead><tr>{(['bill.billNo', 'common.date', 'common.time', 'common.waiter', 'common.hall', 'common.item', 'common.qty', 'common.rate', 'common.amount', 'common.total'] as const).map((k) =>
                  <th key={k} className={`th ${['common.qty', 'common.rate', 'common.amount', 'common.total'].includes(k) ? 'text-right' : ''}`}>{t(k)}</th>)}</tr></thead>
                <tbody>{data.orders.flatMap((o) => o.items.map((i, k) => (
                  <tr key={`${o.id}-${k}`} className={o.status === 'cancelled' ? 'line-through text-muted' : ''}>
                    <td className="td">{k ? '' : o.billNo}</td><td className="td">{k ? '' : o.date}</td><td className="td">{k ? '' : o.time.slice(0, 5)}</td>
                    <td className="td">{k ? '' : o.waiterName}</td><td className="td">{k ? '' : o.tableLabel}</td>
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
