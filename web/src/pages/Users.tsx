import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { api } from '../services/api';
import { Empty, Field, Modal, PageHeader, SkeletonList, useUi } from '../components/ui';
import type { Role, User } from '../types';

type Form = { id?: string; username: string; displayName: string; password: string; role: Role };

export default function UsersPage() {
  const { user: me } = useAuth();
  const { t } = useI18n();
  const { toast, confirm, errorText } = useUi();
  const { data, loading, error, reload } = useApi<User[]>('/users');
  const [form, setForm] = useState<Form | null>(null);

  const valid = form && form.displayName.trim() && (form.id || /^[a-z0-9._-]{3,32}$/.test(form.username)) && (form.id ? !form.password || form.password.length >= 8 : form.password.length >= 8);
  const save = async () => {
    if (!form) return;
    try {
      if (form.id) await api(`/users/${form.id}`, { method: 'PATCH', body: { displayName: form.displayName, role: form.role, ...(form.password ? { password: form.password } : {}) } });
      else { await api('/users', { method: 'POST', body: form }); toast(t('users.created'), 'success'); }
      setForm(null); void reload(true);
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const setActive = async (u: User) => {
    if (u.active && !(await confirm({ title: t('users.disable'), message: t('users.disableConfirm', { name: u.displayName }), danger: true, confirmText: t('users.disable') }))) return;
    try { await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }); void reload(true); } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <div>
      <PageHeader title={t('users.title')} actions={<button className="btn-primary" onClick={() => setForm({ username: '', displayName: '', password: '', role: 'waiter' })} data-testid="add-user">+ {t('users.add')}</button>} />
      {loading && !data ? <SkeletonList rows={3} /> : error ? <Empty text={errorText(error)} /> : (
        <div className="grid gap-2">
          {data?.map((u) => (
            <div key={u.id} className={`card p-3 flex flex-wrap items-center gap-2 ${u.active ? '' : 'opacity-60'}`}>
              <div className="flex-1 min-w-[12rem]">
                <div className="font-bold">{u.displayName} {u.id === me?.id && <span className="chip bg-accent-soft text-xs">{t('users.you')}</span>}</div>
                <div className="text-sm text-muted">@{u.username} · {u.role === 'admin' ? t('users.admin') : t('users.waiter')} · {t('users.lastLogin')}: {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('en-IN') : t('users.never')}</div>
              </div>
              <button className="btn-ghost !min-h-10" onClick={() => setForm({ id: u.id, username: u.username, displayName: u.displayName, password: '', role: u.role })}>{t('common.edit')}</button>
              {u.id !== me?.id && <button className={`btn-ghost !min-h-10 ${u.active ? 'text-error' : 'text-success'}`} onClick={() => setActive(u)}>{u.active ? t('users.disable') : t('users.enable')}</button>}
            </div>
          ))}
        </div>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? t('users.edit') : t('users.add')}
        footer={<><button className="btn-ghost" onClick={() => setForm(null)}>{t('common.cancel')}</button><button className="btn-primary" disabled={!valid} onClick={save} data-testid="user-save">{t('common.save')}</button></>}>
        {form && <>
          <Field label={t('login.username')}><input className="input" name="new-username" disabled={!!form.id} autoCapitalize="none" value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase().replace(/\s/g, '') })} placeholder="ramesh" /></Field>
          <Field label={t('common.name')}><input className="input" name="display-name" maxLength={60} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
          <Field label={form.id ? t('users.newPassword') : t('login.password')} hint="8+">
            <input className="input" name="new-password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label={t('users.role')}>
            <select className="input" value={form.role} disabled={form.id === me?.id} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="waiter">{t('users.waiter')}</option><option value="admin">{t('users.admin')}</option>
            </select>
          </Field>
        </>}
      </Modal>

    </div>
  );
}
