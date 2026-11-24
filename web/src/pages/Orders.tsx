import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { useApi, usePending } from '../hooks';
import { api } from '../services/api';
import { removePending, type PendingOrder } from '../services/offlineQueue';
import { Filters, filterQuery, initialFilters } from '../components/Filters';
import { BillView } from '../components/BillView';
import { Empty, Modal, PageHeader, SkeletonList, useUi } from '../components/ui';
import { PROVISIONAL } from '../printing/receipt';
import { inr } from '../utils/format';
import type { Order, Summary } from '../types';

const STATUS_CHIP: Record<Order['status'], string> = {
  confirmed: 'bg-primary-soft text-primary', billed: 'bg-secondary-soft text-secondary', cancelled: 'bg-error/10 text-error',
};

/** Pending offline order shaped like an order so it can be shown/printed as a PROVISIONAL bill. */
export const pendingAsOrder = (p: PendingOrder): Order => {
  const d = new Date(p.createdAt);
  const ist = new Date(d.getTime() + 5.5 * 3600_000).toISOString();
  return {
    id: p.idempotencyKey, billNo: PROVISIONAL, date: ist.slice(0, 10), time: ist.slice(11, 19), waiterId: p.waiterId, waiterName: p.waiterName,
    tableId: p.tableId, tableLabel: p.tableLabel, total: p.total, status: 'confirmed', createdAt: p.createdAt,
    items: p.items.map((i) => ({ ...i, description: i.description ?? '', amount: Math.round(i.unitPrice * 100) * i.quantity / 100 })),
  };
};

export function OrdersPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const { toast, confirm, errorText } = useUi();
  const isAdmin = user?.role === 'admin';
  const [f, setF] = useState(initialFilters());
  const { data, loading, error, reload } = useApi<{ orders: Order[]; summary: Summary }>('/orders', filterQuery(f));
  const pending = usePending().filter((p) => p.waiterId === user?.id || isAdmin);
  const [provisional, setProvisional] = useState<Order | null>(null);
  const [params, setParams] = useSearchParams();
  const printKey = params.get('print');
  useEffect(() => { // just saved offline → show its bill so the waiter can print it straight away
    const p = printKey && pending.find((x) => x.idempotencyKey === printKey);
    if (p) setProvisional(pendingAsOrder(p));
    if (printKey) setParams({}, { replace: true });
  }, [printKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const shown = (data?.orders ?? []).filter((o) => !q.trim() ||
    norm(`${o.billNo} ${o.tableLabel} ${o.waiterName} ${o.items.map((i) => `${i.name} ${i.description}`).join(' ')}`).includes(norm(q)));

  const discard = async (p: PendingOrder) => {
    if (await confirm({ title: t('net.discard'), message: t('net.discardConfirm', { table: p.tableLabel }), danger: true, confirmText: t('net.discard') })) removePending(p.idempotencyKey);
  };
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allShown = shown.length > 0 && shown.every((o) => selected.has(o.id));
  const toggleAll = () => setSelected(allShown ? new Set() : new Set(shown.map((o) => o.id)));
  const deleteSelected = async () => {
    // The server takes up to 500 ids per request.
    const chunks: string[][] = [];
    for (const id of selected) { if (!chunks.length || chunks.at(-1)!.length === 500) chunks.push([]); chunks.at(-1)!.push(id); }
    const send = (ids: string[], dryRun: boolean) => api<{ count: number; total?: number; backupPath?: string }>('/orders/delete',
      { method: 'POST', body: { mode: 'ids', ids, dryRun, ...(dryRun ? {} : { confirm: 'DELETE' }) } });
    try {
      const dry = await Promise.all(chunks.map((c) => send(c, true)));
      const count = dry.reduce((s, d) => s + d.count, 0), total = dry.reduce((s, d) => s + (d.total ?? 0), 0);
      const ok = await confirm({ title: t('orders.deleteSelected', { n: count }), message: t('settings.affected', { n: count, amount: inr(total) }), danger: true, confirmText: t('common.delete'), requireText: 'DELETE' });
      if (!ok) return;
      let n = 0, path = '';
      for (const c of chunks) { const r = await send(c, false); n += r.count; path = r.backupPath ?? path; }
      toast(t('settings.deleted', { n, path }), 'success');
      setSelected(new Set()); void reload();
    } catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <div>
      <PageHeader title={t('orders.title')} actions={isAdmin && selected.size > 0 &&
        <button className="btn-danger" onClick={deleteSelected}>🗑️ {t('orders.deleteSelected', { n: selected.size })}</button>} />

      {pending.length > 0 && (
        <section className="mb-5">
          <h2 className="font-bold mb-2">⏳ {t('orders.pending')}</h2>
          <div className="grid gap-2">
            {pending.map((p) => (
              <div key={p.idempotencyKey} className="card p-3 border-warning bg-accent-soft/50 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-bold">{inr(p.total)} <span className="chip bg-warning text-white ml-1">{t('net.pendingBadge')}</span></div>
                  <div className="text-sm text-muted">{p.waiterName} · {new Date(p.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>
                  {p.error && <div className="text-sm text-error font-semibold">{p.error}</div>}
                </div>
                <button className="btn-ghost bg-white !min-h-10" onClick={() => setProvisional(pendingAsOrder(p))}>🖨️ {t('bill.printProvisional')}</button>
                {p.error && <button className="btn-ghost bg-white !min-h-10 text-error" onClick={() => discard(p)}>{t('net.discard')}</button>}
              </div>
            ))}
          </div>
        </section>
      )}

      <Filters value={f} onChange={setF} admin={isAdmin} />
      {!isAdmin && <p className="text-sm text-muted mb-2">{t('orders.mine')}</p>}
      <div className="relative mb-3">
        <span aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">🔍</span>
        <input type="search" className="input pl-10" placeholder={t('search.orders')} value={q} onChange={(e) => setQ(e.target.value)}
          aria-label={t('search.orders')} lang="en" autoCapitalize="none" autoCorrect="off" spellCheck={false} data-testid="orders-search" />
      </div>

      {loading && !data ? <SkeletonList rows={5} /> : error ? <Empty text={errorText(error)} /> : !data?.orders.length ? <Empty text={t('orders.none')} /> : !shown.length ? <Empty text={t('search.none', { q })} /> : (
        <>
          {isAdmin && (
            <label className="card px-3 py-2 mb-2 flex items-center gap-3 font-semibold cursor-pointer select-none" data-testid="orders-select-all">
              <input type="checkbox" className="h-5 w-5 accent-primary" checked={allShown} onChange={toggleAll}
                ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allShown; }} />
              <span>{t('orders.selectAll', { n: shown.length })}</span>
              {selected.size > 0 && <button type="button" className="ml-auto text-sm text-primary" onClick={(e) => { e.preventDefault(); setSelected(new Set()); }}>{t('orders.clearSel')}</button>}
            </label>
          )}
          <div className="mb-3 text-sm font-semibold text-muted">{t('common.orders')}: {data.summary.orderCount} · {t('common.total')}: <span className="text-ink">{inr(data.summary.totalAmount)}</span></div>
          <div className="grid gap-2">
            {shown.map((o) => (
              <div key={o.id} className="card p-3 flex items-center gap-3">
                {isAdmin && <input type="checkbox" className="h-5 w-5 accent-primary" checked={selected.has(o.id)} onChange={() => toggle(o.id)} aria-label={o.billNo} />}
                <Link to={`/orders/${o.id}`} className="flex-1 min-w-0 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-bold">#{o.billNo}</div>
                    <div className="text-sm text-muted">{o.date} {o.time.slice(0, 5)} · {o.waiterName} · {o.items.map((i) => `${i.name} ×${i.quantity}`).join(', ')}</div>
                    {o.conflict && <div className="text-xs font-semibold text-warning">⚠️ {t('orders.conflict')}</div>}
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-lg tabular-nums">{inr(o.total)}</div>
                    <span className={`chip text-xs ${STATUS_CHIP[o.status]}`}>{o.status === 'billed' ? t('tables.billed') : o.status === 'cancelled' ? t('bill.cancelled') : t('tables.occupied')}</span>
                  </div>
                </Link>
              </div>
            ))}
          </div>
        </>
      )}

      <Modal open={!!provisional} onClose={() => setProvisional(null)} title={t('bill.printProvisional')}>
        {provisional && <BillView order={provisional} />}
      </Modal>
    </div>
  );
}
