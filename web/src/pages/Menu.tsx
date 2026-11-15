import { useState } from 'react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { api } from '../services/api';
import { Empty, Field, Modal, PageHeader, SkeletonList, useUi } from '../components/ui';
import { inr } from '../utils/format';
import type { MenuCategory, MenuData, MenuItem } from '../types';

type ItemForm = Omit<MenuItem, 'id' | 'price' | 'acPrice'> & { id?: string; priceText: string; acText: string; samePrice: boolean };
const money = (s: string) => /^\d+(\.\d{1,2})?$/.test(s) && Number(s) > 0 && Number(s) <= 100000;

export default function MenuPage() {
  const { t } = useI18n();
  const { toast, confirm, errorText } = useUi();
  const { data, loading, error, reload } = useApi<MenuData>('/menu');
  const [form, setForm] = useState<ItemForm | null>(null);
  const [catForm, setCatForm] = useState<Partial<MenuCategory> | null>(null);
  const [filter, setFilter] = useState('');
  const cats = data?.categories ?? [];

  const valid = !!form?.name.trim() && !!form.categoryId && (form.type === 'custom' || (money(form.priceText) && (form.samePrice || money(form.acText))));
  const save = async () => {
    if (!form) return;
    const { id, priceText, acText, samePrice, ...rest } = form;
    const custom = rest.type === 'custom';
    // acPrice null = "same as Non-AC price" (server and order entry fall back to price).
    const payload = { ...rest, price: custom ? 0 : Number(priceText), acPrice: custom || samePrice ? null : Number(acText), sort: Number(rest.sort) || 0 };
    try {
      await api(id ? `/menu/${id}` : '/menu', { method: id ? 'PATCH' : 'POST', body: payload });
      toast(t('common.saved'), 'success'); setForm(null); void reload(true);
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const patchItem = async (m: MenuItem, body: Partial<MenuItem>) => {
    try { await api(`/menu/${m.id}`, { method: 'PATCH', body }); void reload(true); } catch (e) { toast(errorText(e), 'error'); }
  };
  const removeItem = async (m: MenuItem) => {
    if (!(await confirm({ title: t('menu.deleteConfirm', { name: m.name }), danger: true, confirmText: t('common.delete') }))) return;
    try { await api(`/menu/${m.id}`, { method: 'DELETE' }); void reload(true); } catch (e) { toast(errorText(e), 'error'); }
  };
  const saveCat = async () => {
    const c = catForm!;
    try {
      await api(c.id ? `/menu/categories/${c.id}` : '/menu/categories', { method: c.id ? 'PATCH' : 'POST', body: { name: c.name, sort: Number(c.sort ?? 100), active: c.active ?? true } });
      setCatForm(null); void reload(true);
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const toggleCat = async (c: MenuCategory) => {
    try { await api(`/menu/categories/${c.id}`, { method: 'PATCH', body: { active: !c.active } }); void reload(true); } catch (e) { toast(errorText(e), 'error'); }
  };
  const deleteCat = async () => {
    const c = catForm!;
    if (!(await confirm({ title: t('menu.deleteCategoryConfirm', { name: c.name ?? '' }), danger: true, confirmText: t('common.delete') }))) return;
    try { await api(`/menu/categories/${c.id}`, { method: 'DELETE' }); setCatForm(null); void reload(true); } catch (e) { toast(errorText(e), 'error'); }
  };

  const items = (data?.items ?? []).filter((m) => !filter || m.categoryId === filter);
  const newItem = (): ItemForm => ({ name: '', priceText: '', acText: '', samePrice: true, type: 'fixed', isThali: false, active: true, description: '', sort: 100, categoryId: filter || cats[0]?.id || '' });

  return (
    <div>
      <PageHeader title={t('menu.title')} actions={<button className="btn-primary" disabled={!cats.length} onClick={() => setForm(newItem())}>+ {t('menu.add')}</button>} />
      <p className="text-sm text-muted mb-3">ℹ️ {t('menu.priceNote')}</p>
      {loading && !data ? <SkeletonList rows={6} /> : error ? <Empty text={errorText(error)} /> : (
        <>
          <section className="card p-3 mb-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="font-bold">{t('menu.categories')}</h2>
              <button className="btn-ghost !min-h-10" onClick={() => setCatForm({ name: '', sort: (cats.at(-1)?.sort ?? 0) + 10, active: true })} data-testid="add-category">+ {t('menu.addCategory')}</button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {cats.map((c) => (
                <div key={c.id} className={`rounded-xl border p-2 flex items-center gap-2 ${c.active ? 'border-line' : 'border-dashed border-muted/40 bg-bg'}`}>
                  <button className="flex-1 min-w-0 text-left" onClick={() => setFilter(filter === c.id ? '' : c.id)}>
                    <div className={`font-semibold ${filter === c.id ? 'text-primary' : ''}`}>{c.name} <span className="text-muted text-sm">({(data?.items ?? []).filter((m) => m.categoryId === c.id).length})</span></div>
                    <div className={`text-xs ${c.active ? 'text-success' : 'text-muted'}`}>{c.active ? `👁️ ${t('menu.categoryVisible')}` : `🚫 ${t('menu.categoryHidden')}`}</div>
                  </button>
                  <button role="switch" aria-checked={c.active} aria-label={c.name} onClick={() => toggleCat(c)} data-testid={`toggle-cat-${c.id}`}
                    className={`relative h-8 w-14 rounded-full transition ${c.active ? 'bg-success' : 'bg-line'}`}>
                    <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${c.active ? 'left-7' : 'left-1'}`} />
                  </button>
                  <button className="btn-ghost !min-h-10 !px-3" onClick={() => setCatForm(c)} aria-label={t('menu.editCategory')}>✏️</button>
                </div>
              ))}
            </div>
          </section>

          {!items.length ? <Empty text={t('menu.noItems')} /> : (
            <div className="grid gap-2">
              {items.map((m) => {
                const cat = cats.find((c) => c.id === m.categoryId);
                return (
                  <div key={m.id} className={`card p-3 flex flex-wrap items-center gap-3 ${m.active && cat?.active ? '' : 'opacity-60'}`}>
                    <div className="flex-1 min-w-[12rem]">
                      <div className="font-bold">{m.name} {m.isThali && <span aria-hidden>🍽️</span>}</div>
                      <div className="text-sm text-muted">
                        {cat?.name ?? '—'} · {m.type === 'custom' ? t('menu.custom') : <>🌀 {inr(m.price)} · ❄️ {inr(m.acPrice ?? m.price)}</>}
                      </div>
                    </div>
                    <button className={`chip !min-h-10 ${m.active ? 'bg-success/15 text-success' : 'bg-line text-muted'}`} onClick={() => patchItem(m, { active: !m.active })}>{m.active ? t('common.active') : t('common.inactive')}</button>
                    <button className="btn-ghost !min-h-10" data-testid={`edit-${m.id}`}
                      onClick={() => setForm({ ...m, priceText: m.type === 'custom' ? '' : String(m.price), acText: m.acPrice == null ? '' : String(m.acPrice), samePrice: m.acPrice == null || m.acPrice === m.price })}>{t('common.edit')}</button>
                    <button className="btn-ghost !min-h-10 text-error" onClick={() => removeItem(m)}>{t('common.delete')}</button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? t('menu.edit') : t('menu.add')}
        footer={<><button className="btn-ghost" onClick={() => setForm(null)}>{t('common.cancel')}</button><button className="btn-primary" disabled={!valid} onClick={save} data-testid="menu-save">{t('common.save')}</button></>}>
        {form && <>
          <Field label={t('common.name')} hint={t('menu.nameEnglish')}><input className="input" maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-x-3">
            <Field label={t('menu.category')}>
              <select className="input" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label={t('menu.type')}>
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as MenuItem['type'] })}>
                <option value="fixed">{t('menu.fixed')}</option><option value="custom">{t('menu.custom')}</option>
              </select>
            </Field>
          </div>
          {form.type === 'fixed' && <>
            <label className="flex items-center gap-3 min-h-12 mb-2 rounded-xl border border-line bg-bg px-3">
              <input type="checkbox" className="h-5 w-5 accent-primary" checked={form.samePrice} data-testid="same-price"
                onChange={(e) => setForm({ ...form, samePrice: e.target.checked, acText: e.target.checked ? '' : form.acText || form.priceText })} />
              <span className="font-semibold">{t('menu.samePrice')}</span>
            </label>
            <div className={`grid gap-x-3 ${form.samePrice ? 'grid-cols-1' : 'grid-cols-1 min-[420px]:grid-cols-2'}`}>
              <Field label={form.samePrice ? `${t('common.price')} (₹) · 🌀 + ❄️` : `🌀 ${t('menu.nonacPrice')}`}><input className="input" inputMode="decimal" value={form.priceText} data-testid="menu-price"
                onChange={(e) => setForm({ ...form, priceText: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
              {!form.samePrice && <Field label={`❄️ ${t('menu.acPrice')}`}><input className="input" inputMode="decimal" value={form.acText} data-testid="menu-ac-price"
                onChange={(e) => setForm({ ...form, acText: e.target.value.replace(/[^\d.]/g, '') })} /></Field>}
            </div>
          </>}
          <Field label={`${t('common.description')} (${t('common.optional')})`}><input className="input" maxLength={200} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label={t('menu.sort')}><input className="input" type="number" inputMode="numeric" value={form.sort} onChange={(e) => setForm({ ...form, sort: Number(e.target.value) })} /></Field>
          <label className="flex items-center gap-3 min-h-12"><input type="checkbox" className="h-5 w-5 accent-primary" checked={form.isThali} onChange={(e) => setForm({ ...form, isThali: e.target.checked })} />{t('menu.isThali')}</label>
          <label className="flex items-center gap-3 min-h-12"><input type="checkbox" className="h-5 w-5 accent-primary" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />{t('common.active')}</label>
        </>}
      </Modal>

      <Modal open={!!catForm} onClose={() => setCatForm(null)} title={catForm?.id ? t('menu.editCategory') : t('menu.addCategory')}
        footer={<>{catForm?.id && <button className="btn-danger mr-auto" onClick={deleteCat}>{t('common.delete')}</button>}
          <button className="btn-ghost" onClick={() => setCatForm(null)}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={!catForm?.name?.trim()} onClick={saveCat} data-testid="category-save">{t('common.save')}</button></>}>
        {catForm && <>
          <Field label={t('common.name')} hint={t('menu.nameEnglish')}><input className="input" maxLength={40} value={catForm.name ?? ''} placeholder="Punjabi" onChange={(e) => setCatForm({ ...catForm, name: e.target.value })} /></Field>
          <Field label={t('menu.sort')}><input className="input" type="number" inputMode="numeric" value={catForm.sort ?? 100} onChange={(e) => setCatForm({ ...catForm, sort: Number(e.target.value) })} /></Field>
          <label className="flex items-center gap-3 min-h-12"><input type="checkbox" className="h-5 w-5 accent-primary" checked={catForm.active ?? true} onChange={(e) => setCatForm({ ...catForm, active: e.target.checked })} />{t('menu.categoryVisible')}</label>
        </>}
      </Modal>
    </div>
  );
}
