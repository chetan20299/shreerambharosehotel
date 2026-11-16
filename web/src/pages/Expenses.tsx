import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { api } from '../services/api';
import { Filters, initialFilters } from '../components/Filters';
import { Empty, Field, Modal, PageHeader, SkeletonList, Spinner, useUi } from '../components/ui';
import { inr, istToday } from '../utils/format';
import type { Expense } from '../types';

/** Current time in India as HH:mm (default for a new expense; the user can change it). */
const istNow = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
export const validAmount = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) > 0 && Number(v) <= 1_000_000;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Searchable multi-select over the expense list. Typing filters; tap to tick/untick; a name that is not in the
 * list can be added just for this entry. Selected items show as chips.
 */
function ItemPicker({ options, selected, onChange }: { options: string[]; selected: string[]; onChange: (v: string[]) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener('mousedown', close);
    return () => removeEventListener('mousedown', close);
  }, [open]);
  const shown = options.filter((o) => !q.trim() || norm(o).includes(norm(q)));
  const toggle = (o: string) => onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
  const custom = q.trim() && !options.some((o) => norm(o) === norm(q)) && !selected.some((o) => norm(o) === norm(q)) ? q.trim().slice(0, 40) : '';

  return (
    <div ref={box} className="relative">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2" data-testid="picked">
          {selected.map((s) => (
            <span key={s} className="chip bg-primary-soft text-primary-dark border border-primary/30 gap-1 !pr-1">
              {s}
              <button type="button" onClick={() => toggle(s)} className="grid place-items-center h-7 w-7 rounded-full hover:bg-white/70" aria-label={`${t('order.remove')} ${s}`}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <span aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">🔍</span>
        <input className="input pl-10" value={q} placeholder={t('exp.searchPh')} aria-label={t('exp.searchPh')} role="combobox" aria-expanded={open}
          onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Enter') { // type a new expense name + Enter → added straight away
              e.preventDefault();
              const hit = shown.length === 1 && !custom ? shown[0]! : custom;
              if (hit && !selected.includes(hit)) onChange([...selected, hit]);
              setQ('');
            }
          }}
          data-testid="expense-search" />
      </div>
      {open && (
        <ul role="listbox" aria-multiselectable="true" className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto card shadow-xl p-1" data-testid="expense-options">
          {custom && (
            <li><button type="button" className="w-full text-left rounded-lg px-3 min-h-11 font-semibold text-primary hover:bg-primary-soft"
              onClick={() => { toggle(custom); setQ(''); }} data-testid="expense-custom">＋ {t('exp.useCustom', { name: custom })}</button></li>
          )}
          {shown.map((o) => {
            const on = selected.includes(o);
            return (
              <li key={o} role="option" aria-selected={on}>
                <button type="button" onClick={() => toggle(o)} data-testid={`opt-${o}`}
                  className={`w-full flex items-center gap-3 rounded-lg px-3 min-h-11 text-left ${on ? 'bg-primary-soft font-semibold' : 'hover:bg-bg'}`}>
                  <span aria-hidden className={`grid place-items-center h-5 w-5 shrink-0 rounded border-2 text-xs text-white ${on ? 'bg-primary border-primary' : 'border-line bg-white'}`}>{on ? '✓' : ''}</span>
                  <span className="min-w-0 truncate">{o}</span>
                </button>
              </li>
            );
          })}
          {!shown.length && !custom && <li className="px-3 py-3 text-sm text-muted">{t('search.none', { q })}</li>}
          <li className="sticky bottom-0 bg-card pt-1"><button type="button" className="btn-ghost w-full !min-h-10" onClick={() => setOpen(false)}>{t('tables.done')}</button></li>
        </ul>
      )}
    </div>
  );
}

/** Admin: add / remove / reset the items that appear in the expense list. */
function ManageItems({ open, onClose, items, defaults, onSaved }: { open: boolean; onClose: () => void; items: string[]; defaults: string[]; onSaved: () => void }) {
  const { t } = useI18n();
  const { toast, errorText } = useUi();
  const [list, setList] = useState(items);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setList(items); }, [open, items]);
  const add = () => {
    const v = name.trim().slice(0, 40);
    if (v && !list.some((x) => norm(x) === norm(v))) setList([...list, v]);
    setName('');
  };
  const save = async () => {
    setSaving(true);
    try { await api('/expense-items', { method: 'PUT', body: { items: list } }); toast(t('common.saved'), 'success'); onSaved(); onClose(); }
    catch (e) { toast(errorText(e), 'error'); } finally { setSaving(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={t('exp.manage')}
      footer={<><button className="btn-ghost" onClick={() => setList(defaults)}>↺ {t('exp.resetDefaults')}</button>
        <button className="btn-primary" disabled={saving} onClick={save} data-testid="items-save">{saving ? <Spinner /> : '💾'} {t('common.save')}</button></>}>
      <p className="text-sm text-muted mb-3">{t('exp.manageHelp')}</p>
      <div className="flex gap-2 mb-3">
        <input className="input" maxLength={40} value={name} placeholder={t('exp.newItemPh')} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} data-testid="item-name" />
        <button type="button" className="btn-secondary shrink-0" disabled={!name.trim()} onClick={add} data-testid="item-add">＋ {t('common.add')}</button>
      </div>
      <ul className="divide-y divide-line border border-line rounded-xl bg-white">
        {list.map((x) => (
          <li key={x} className="flex items-center justify-between gap-2 px-3 min-h-12">
            <span className="min-w-0 truncate">{x}</span>
            <button type="button" className="btn-ghost !min-h-9 !px-3 text-error shrink-0" onClick={() => setList(list.filter((y) => y !== x))} aria-label={`${t('common.delete')} ${x}`}>🗑️</button>
          </li>
        ))}
        {!list.length && <li className="px-3 py-3 text-sm text-muted">{t('common.noData')}</li>}
      </ul>
    </Modal>
  );
}

/** Daily hotel expenses. Admin and waiters both add; admin sees everyone's and manages the item list. */
export default function ExpensesPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const { toast, confirm, errorText } = useUi();
  const isAdmin = user?.role === 'admin';
  const [f, setF] = useState(initialFilters('today'));
  const { data, loading, error, reload } = useApi<{ expenses: Expense[]; total: number }>('/expenses', { from: f.from, to: f.to });
  const itemsApi = useApi<{ items: string[]; defaults: string[] }>('/expense-items', undefined, { cache: true });
  const options = useMemo(() => itemsApi.data?.items ?? [], [itemsApi.data]);
  const [picked, setPicked] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [when, setWhen] = useState({ date: istToday(), time: istNow() });
  const [saving, setSaving] = useState(false);
  const [manage, setManage] = useState(false);

  const total = picked.reduce((s, p) => s + (validAmount(amounts[p] ?? '') ? Math.round(Number(amounts[p]) * 100) : 0), 0) / 100;
  const valid = picked.length > 0 && picked.every((p) => validAmount(amounts[p] ?? '')) && when.date && when.time;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      for (const p of picked) await api('/expenses', { method: 'POST', body: { description: p, amount: Number(amounts[p]), ...when } });
      toast(t('exp.addedN', { n: picked.length, amount: inr(total) }), 'success');
      setPicked([]); setAmounts({}); setWhen({ date: when.date, time: istNow() });
      void reload(true);
    } catch (err) { toast(errorText(err), 'error'); void reload(true); } finally { setSaving(false); }
  };
  const remove = async (x: Expense) => {
    if (!(await confirm({ title: t('exp.deleteConfirm', { name: x.description, amount: inr(x.amount) }), danger: true, confirmText: t('common.delete') }))) return;
    try { await api(`/expenses/${x.id}`, { method: 'DELETE' }); void reload(true); } catch (err) { toast(errorText(err), 'error'); }
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t('exp.title')} actions={isAdmin && <button className="btn-ghost bg-white" onClick={() => setManage(true)} data-testid="manage-items">⚙️ {t('exp.manage')}</button>} />

      <form onSubmit={add} className="card p-4 space-y-3" data-testid="expense-form">
        <h2 className="font-bold">➕ {t('exp.add')}</h2>
        <div>
          <span className="label">{t('exp.items')}</span>
          <ItemPicker options={options} selected={picked} onChange={(v) => { setPicked(v); setAmounts((a) => Object.fromEntries(v.map((k) => [k, a[k] ?? '']))); }} />
        </div>

        {picked.length > 0 && (
          <div className="rounded-xl border border-line bg-bg p-2 space-y-2" data-testid="expense-amounts">
            {picked.map((p) => (
              <label key={p} className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate font-semibold text-sm sm:text-base">{p}</span>
                <span className="relative w-32 sm:w-40 shrink-0">
                  <span aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">₹</span>
                  <input className={`input pl-7 text-right tabular-nums ${amounts[p] && !validAmount(amounts[p]!) ? '!border-error' : ''}`} inputMode="decimal" placeholder="0"
                    value={amounts[p] ?? ''} aria-label={`${p} ${t('exp.amount')}`} data-testid={`amount-${p}`}
                    onChange={(e) => setAmounts({ ...amounts, [p]: e.target.value.replace(/[^\d.]/g, '') })} />
                </span>
              </label>
            ))}
            <div className="flex items-center justify-between border-t border-line pt-2 px-1 font-bold">
              <span>{t('common.total')}</span><span className="tabular-nums text-error">{inr(total)}</span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('common.date')}>
            <input type="date" className="input" max={istToday()} value={when.date} onChange={(e) => setWhen({ ...when, date: e.target.value })} data-testid="expense-date" />
          </Field>
          <Field label={t('common.time')}>
            <input type="time" className="input" value={when.time} onChange={(e) => setWhen({ ...when, time: e.target.value })} data-testid="expense-time" />
          </Field>
        </div>
        <button className="btn-primary w-full sm:w-auto" disabled={!valid || saving} data-testid="expense-save">
          {saving ? <Spinner /> : '✓'} {picked.length > 1 ? t('exp.addN', { n: picked.length }) : t('exp.add')}</button>
      </form>

      <Filters value={f} onChange={setF} times={false} />

      {loading && !data ? <SkeletonList rows={4} /> : error ? <Empty text={errorText(error)} /> : !data?.expenses.length ? <Empty text={t('exp.none')} /> : (
        <section className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="font-bold">{t('exp.title')} · {data.expenses.length}</h2>
            <div className="text-lg font-bold text-error tabular-nums" data-testid="expense-total">{inr(data.total)}</div>
          </div>
          <ul className="divide-y divide-line">
            {data.expenses.map((x) => (
              <li key={x.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{x.description}</div>
                  <div className="text-xs text-muted">{x.date} · {x.time}{isAdmin ? ` · ${x.addedByName}` : ''}</div>
                </div>
                <b className="tabular-nums shrink-0">{inr(x.amount)}</b>
                {(isAdmin || x.addedBy === user?.id) && (
                  <button className="btn-ghost !min-h-10 !px-3 text-error shrink-0" onClick={() => remove(x)} aria-label={t('common.delete')}>🗑️</button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {isAdmin && <ManageItems open={manage} onClose={() => setManage(false)} items={options} defaults={itemsApi.data?.defaults ?? []} onSaved={() => void itemsApi.reload(true)} />}
    </div>
  );
}
