import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { api, ApiError } from '../services/api';
import { addPending, toOrderBody } from '../services/offlineQueue';
import { Loader } from '../components/Brand';
import { Field, Modal, Spinner, useUi } from '../components/ui';
import { ActionOverlay, pause } from '../components/ActionOverlay';
import { inr, uuid } from '../utils/format';
import type { MenuData, MenuItem, Order } from '../types';

export interface Line { key: string; menuItemId: string; name: string; type: 'fixed' | 'custom'; isThali: boolean; quantity: number; unitPrice: number; description?: string }

/** Display total in paise (server recomputes authoritatively). */
export const cartTotal = (lines: Line[]) => lines.reduce((s, l) => s + Math.round(l.unitPrice * 100) * l.quantity, 0) / 100;

export function validExtra(v: string) {
  const n = Number(v);
  return /^\d+(\.\d{1,2})?$/.test(v.trim()) && n >= 1 && n <= 100000 ? n : null;
}

export function OrderEntryPage() {
  // ?add=<orderId>&bill=<billNo>: add items to that existing order instead of creating a new one.
  const [sp] = useSearchParams();
  const addTo = sp.get('add');
  const { user } = useAuth();
  const { t } = useI18n();
  const { toast, confirm, errorText } = useUi();
  const nav = useNavigate();
  const menu = useApi<MenuData>('/menu', undefined, { cache: true });
  const [catId, setCatId] = useState('');
  const [q, setQ] = useState('');
  const draftKey = addTo ? `srbh.draft.add.${addTo}` : 'srbh.draft';
  const [lines, setLines] = useState<Line[]>(() => { try { return JSON.parse(sessionStorage.getItem(draftKey) ?? '[]'); } catch { return []; } });
  const [extra, setExtra] = useState<{ itemId: string; amount: string; note: string } | null>(null);
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');
  const idem = useRef(sessionStorage.getItem(`${draftKey}.key`) ?? uuid());


  useEffect(() => { sessionStorage.setItem(draftKey, JSON.stringify(lines)); sessionStorage.setItem(`${draftKey}.key`, idem.current); }, [lines, draftKey]);


  // Only enabled categories and active items (server already filters this for waiters).
  const cats = useMemo(() => (menu.data?.categories ?? []).filter((c) => c.active), [menu.data]);
  const allActive = useMemo(() => {
    const enabled = new Set(cats.map((c) => c.id));
    return (menu.data?.items ?? []).filter((m) => m.active && enabled.has(m.categoryId));
  }, [menu.data, cats]);
  // Search matches item name, description or category name (all stored in English), ignoring case/spaces/dashes.
  const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  const catName = (id: string) => cats.find((c) => c.id === id)?.name ?? '';
  const active = allActive.filter((m) => (!catId || m.categoryId === catId) &&
    (!q.trim() || norm(`${m.name} ${m.description} ${catName(m.categoryId)}`).includes(norm(q))));
  const total = cartTotal(lines);
  const qtyOf = (id: string) => lines.find((l) => l.menuItemId === id && l.type === 'fixed')?.quantity ?? 0;

  const change = (m: MenuItem, delta: number) => setLines((ls) => {
    const i = ls.findIndex((l) => l.menuItemId === m.id && l.type === 'fixed');
    if (i < 0) return delta > 0 ? [...ls, { key: m.id, menuItemId: m.id, name: m.name, type: 'fixed', isThali: m.isThali, quantity: 1, unitPrice: m.price }] : ls;
    const q = Math.min(500, ls[i]!.quantity + delta);
    return q <= 0 ? ls.filter((_, k) => k !== i) : ls.map((l, k) => (k === i ? { ...l, quantity: q } : l));
  });
  const addExtra = () => {
    const amt = validExtra(extra!.amount);
    const m = allActive.find((x) => x.id === extra!.itemId);
    if (amt == null || !m) return;
    setLines((ls) => [...ls, { key: uuid(), menuItemId: m.id, name: m.name, type: 'custom', isThali: m.isThali, quantity: 1, unitPrice: amt, description: extra!.note.trim().slice(0, 120) }]);
    setExtra(null);
  };

  const finish = (path: string) => {
    sessionStorage.removeItem(draftKey); sessionStorage.removeItem(`${draftKey}.key`);
    nav(path, { replace: true });
  };
  const submit = async () => {
    setSaving(true);
    try {
      if (addTo) {
        await api<Order>(`/orders/${addTo}/items`, { method: 'POST', body: { items: toOrderBody({ idempotencyKey: idem.current, items: lines }).items } });
        setDoneMsg(t('anim.itemsAdded')); await pause(900);
        finish(`/orders/${addTo}`);
        return;
      }
      const r = await api<{ order: Order }>('/orders', { method: 'POST', body: toOrderBody({ idempotencyKey: idem.current, items: lines }) });
      setDoneMsg(t('anim.orderDone', { bill: r.order.billNo })); await pause(900);
      finish(`/orders/${r.order.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0 && !addTo) {
        addPending({ idempotencyKey: idem.current, waiterId: user!.id, waiterName: user!.displayName, tableId: '', tableLabel: '', createdAt: new Date().toISOString(), items: lines, total });
        toast(t('order.savedOffline'), 'info');
        finish('/orders');
      } else { toast(errorText(e), 'error'); setReview(false); }
    } finally { setSaving(false); }
  };
  const leave = async () => {
    if (lines.length && !(await confirm({ title: t('order.leaveConfirm'), danger: true, confirmText: t('common.back') }))) return;
    sessionStorage.removeItem(draftKey); sessionStorage.removeItem(`${draftKey}.key`);
    nav(addTo ? `/orders/${addTo}` : '/orders');
  };

  if (menu.loading && !menu.data) return <Loader label={t('loader.menu')} />;
  if (menu.error && !menu.data) return <div className="card p-6 text-center"><p className="mb-3">{errorText(menu.error)}</p><button className="btn-primary" onClick={() => menu.reload()}>{t('common.retry')}</button></div>;

  return (
    <div className="pb-28 md:pb-36">
      <div className="flex items-center gap-2 mb-4">
        <button className="btn-ghost !px-3" onClick={leave} aria-label={t('common.back')}>←</button>
        <h1 className="text-2xl font-bold">{addTo ? `${t('bill.addItem')} · #${sp.get('bill') ?? ''}` : t('tables.newOrder')}</h1>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2 mb-3 -mx-1 px-1" role="tablist">
        {[{ id: '', name: t('common.all') }, ...cats].map((c) => (
          <button key={c.id} role="tab" aria-selected={catId === c.id} onClick={() => setCatId(c.id)} data-testid={`cat-${c.id || 'all'}`}
            className={`chip whitespace-nowrap !min-h-11 border ${catId === c.id ? 'bg-ink text-white border-ink' : 'bg-white border-line'}`}>{c.name}</button>
        ))}
      </div>
      <div className="relative mb-3">
        <span aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">🔍</span>
        <input type="search" className="input pl-10" placeholder={t('search.menu')} value={q} onChange={(e) => setQ(e.target.value)}
          aria-label={t('search.menu')} lang="en" autoCapitalize="none" autoCorrect="off" spellCheck={false} data-testid="menu-search" />
      </div>
      {!active.length && <div className="card p-6 text-center text-muted">{q.trim() ? t('search.none', { q }) : t('menu.noItems')}</div>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {active.map((m) => m.type === 'fixed' ? (
          <div key={m.id} className="card p-4 flex items-center gap-3" data-testid={`menu-${m.id}`}>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-lg">{m.name}</div>
              <div className="text-primary font-bold text-lg tabular-nums">{inr(m.price)}</div>
              {m.description && <div className="text-sm text-muted">{m.description}</div>}
            </div>
            <div className="flex items-center gap-2">
              <button className="h-12 w-12 rounded-xl border border-line text-2xl font-bold disabled:opacity-30" disabled={!qtyOf(m.id)} onClick={() => change(m, -1)} aria-label="−">−</button>
              <span className="w-8 text-center text-xl font-bold tabular-nums" data-testid={`qty-${m.id}`}>{qtyOf(m.id)}</span>
              <button className="h-12 w-12 rounded-xl bg-primary text-white text-2xl font-bold" onClick={() => change(m, 1)} aria-label="+">+</button>
            </div>
          </div>
        ) : (
          <button key={m.id} className="card p-4 text-left border-dashed border-primary" onClick={() => setExtra({ itemId: m.id, amount: '', note: '' })} data-testid={`menu-${m.id}`}>
            <div className="font-bold text-lg">➕ {t('order.addExtra')} · {m.name}</div>
            {m.description && <div className="text-sm text-muted">{m.description}</div>}
          </button>
        ))}
      </div>

      {lines.some((l) => l.type === 'custom') && (
        <div className="card p-3 mt-3 space-y-2">
          {lines.filter((l) => l.type === 'custom').map((l) => (
            <div key={l.key} className="flex items-center justify-between gap-2">
              <span className="min-w-0">{l.name}{l.description ? ` · ${l.description}` : ''}</span>
              <span className="flex items-center gap-2"><b className="tabular-nums">{inr(l.unitPrice)}</b>
                <button className="text-error font-semibold px-2 min-h-10" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>{t('order.remove')}</button></span>
            </div>
          ))}
        </div>
      )}

      <div className="fixed inset-x-3 md:inset-x-0 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] md:bottom-0 md:left-[var(--sidebar-w)] z-20 rounded-2xl md:rounded-none border border-line md:border-x-0 md:border-b-0 bg-card/95 backdrop-blur p-3 md:pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-6px_20px_rgba(43,29,20,.08)]">
        <div className="mx-auto max-w-6xl flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-muted">{lines.length ? t('order.itemsCount', { n: lines.reduce((s, l) => s + l.quantity, 0) }) : t('order.empty')}</div>
            <div className="text-2xl font-bold tabular-nums" data-testid="cart-total">{inr(total)}</div>
          </div>
          <button className="btn-primary px-6" disabled={!lines.length} onClick={() => setReview(true)}>{t('order.review')} →</button>
        </div>
      </div>

      <Modal open={!!extra} onClose={() => setExtra(null)} title={t('order.addExtra')}
        footer={<><button className="btn-ghost" onClick={() => setExtra(null)}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={!extra || validExtra(extra.amount) == null} onClick={addExtra}>{t('common.add')}</button></>}>
        {extra && <>
          <Field label={t('order.extraAmount')} hint={extra.amount && validExtra(extra.amount) == null ? t('order.invalidAmount') : undefined}>
            <input className="input text-2xl font-bold" inputMode="decimal" autoFocus value={extra.amount} data-testid="extra-amount"
              onChange={(e) => setExtra({ ...extra, amount: e.target.value.replace(/[^\d.]/g, '') })} />
          </Field>
          <Field label={`${t('order.extraNote')} (${t('common.optional')})`}>
            <input className="input" maxLength={120} placeholder={t('order.extraNotePh')} value={extra.note} onChange={(e) => setExtra({ ...extra, note: e.target.value })} />
          </Field>
        </>}
      </Modal>

      <Modal open={review} onClose={() => !saving && setReview(false)} title={t('order.review')}
        footer={<><button className="btn-ghost" disabled={saving} onClick={() => setReview(false)}>{t('common.back')}</button>
          <button className="btn-primary" disabled={saving} onClick={submit} data-testid="confirm-order">{saving ? <><Spinner /> {t('order.saving')}</> : `✓ ${t('order.confirm')}`}</button></>}>
        <table className="w-full text-sm">
          <thead><tr><th className="th">{t('common.item')}</th><th className="th text-right">{t('common.qty')}</th><th className="th text-right">{t('common.rate')}</th><th className="th text-right">{t('common.amount')}</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.key}><td className="td">{l.name}{l.description ? <div className="text-xs text-muted">{l.description}</div> : null}</td>
              <td className="td text-right tabular-nums">{l.quantity}</td><td className="td text-right tabular-nums">{inr(l.unitPrice)}</td>
              <td className="td text-right tabular-nums">{inr(Math.round(l.unitPrice * 100) * l.quantity / 100)}</td></tr>
          ))}</tbody>
          <tfoot><tr><td className="td font-bold" colSpan={3}>{t('bill.grandTotal')}</td><td className="td text-right font-bold text-lg tabular-nums">{inr(total)}</td></tr></tfoot>
        </table>
      </Modal>
      <ActionOverlay kind={doneMsg ? 'done' : saving ? 'saving' : null} label={doneMsg || (addTo ? t('anim.addingItems') : t('anim.placing'))} />
    </div>
  );
}
