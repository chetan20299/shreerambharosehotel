import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { api } from '../services/api';
import { LanguagePicker } from '../components/LanguagePicker';
import { PrinterStatus } from '../components/PrinterStatus';
import { PrintStationCard } from '../components/PrintStation';
import { DEFAULT_SETTINGS } from '../components/BillView';
import { Field, PageHeader, useUi } from '../components/ui';
import { download, toJson, reportFileName } from '../exports';
import { addDays, inr, istToday } from '../utils/format';
import type { Order, Settings } from '../types';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="card p-4"><h2 className="text-lg font-bold mb-3">{title}</h2>{children}</section>;
}

export function SettingsPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'admin';
  return (
    <div className="space-y-4 max-w-3xl">
      <PageHeader title={isAdmin ? t('nav.settings') : t('nav.account')} />
      <Section title={t('lang.label')}><LanguagePicker /></Section>
      <Section title={t('printer.title')}><PrinterStatus variant="card" /><p className="text-sm text-muted mt-2">{t('printer.tips')}</p></Section>
      <Section title={t('station.title')}><PrintStationCard /></Section>
      <ChangePassword />
      {isAdmin && <><HotelSettings /><Retention /><DataManagement /><Logs /></>}
    </div>
  );
}

function ChangePassword() {
  const { t } = useI18n();
  const { toast, errorText } = useUi();
  const { updateCsrf } = useAuth();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.next !== f.again) return toast(t('settings.mismatch'), 'error');
    try {
      const r = await api<{ csrfToken: string }>('/auth/change-password', { method: 'POST', body: { currentPassword: f.current, newPassword: f.next } });
      updateCsrf(r.csrfToken); setF({ current: '', next: '', again: '' }); toast(t('settings.passwordChanged'), 'success');
    } catch (err) { toast(errorText(err), 'error'); }
  };
  return (
    <Section title={t('settings.password')}>
      <form onSubmit={submit} className="grid gap-x-3 sm:grid-cols-3">
        <Field label={t('settings.current')}><input className="input" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label={t('settings.new')} hint="8+"><input className="input" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        <Field label={t('settings.confirmNew')}><input className="input" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
        <button className="btn-primary sm:col-span-3" disabled={!f.current || f.next.length < 8}>{t('common.save')}</button>
      </form>
    </Section>
  );
}

function HotelSettings() {
  const { t } = useI18n();
  const { toast, errorText } = useUi();
  const { data } = useApi<Settings>('/settings', undefined, { cache: true });
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  useEffect(() => { if (data) setS(data); }, [data]);
  const save = async () => {
    try { await api('/settings', { method: 'PUT', body: s }); toast(t('common.saved'), 'success'); } catch (e) { toast(errorText(e), 'error'); }
  };
  const text = (k: keyof Settings, label: string, max: number) => (
    <Field label={label}><input className="input" maxLength={max} value={String(s[k])} onChange={(e) => setS({ ...s, [k]: e.target.value })} /></Field>
  );
  return (
    <Section title={t('settings.hotel')}>
      <div className="grid gap-x-3 sm:grid-cols-2">
        {text('hotelName', t('settings.hotelName'), 60)}{text('phone', t('settings.phone'), 40)}
        {text('address', t('settings.address'), 160)}{text('gstin', t('settings.gstin'), 20)}
        {text('footer', t('settings.footer'), 120)}
        <Field label={t('settings.paper')}>
          <select className="input" value={s.paperWidth} onChange={(e) => setS({ ...s, paperWidth: Number(e.target.value) as 58 | 80 })}>
            <option value={58}>58 mm</option><option value={80}>80 mm</option>
          </select>
        </Field>
      </div>
      <button className="btn-primary w-full" disabled={!s.hotelName.trim()} onClick={save}>{t('common.save')}</button>
    </Section>
  );
}

function Retention() {
  const { t } = useI18n();
  const { toast, errorText } = useUi();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ rolled: Record<string, number> }>('/maintenance/rollup', { method: 'POST' });
      toast(t('settings.retentionDone', { n: Object.values(r.rolled).reduce((a, b) => a + b, 0) }), 'success');
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Section title={t('settings.retention')}>
      <p className="text-sm text-muted mb-3">{t('settings.retentionHelp')}</p>
      <button className="btn-secondary" onClick={run} disabled={busy} data-testid="run-rollup">{busy ? t('loader.loading') : `▶ ${t('settings.runNow')}`}</button>
    </Section>
  );
}

function DataManagement() {
  const { t } = useI18n();
  const { toast, confirm, errorText } = useUi();
  const [date, setDate] = useState(addDays(istToday(), -1));
  const [busy, setBusy] = useState(false);

  const run = async (body: { mode: 'range' | 'olderThan'; from?: string; days?: number }, backupRange: { from: string; to: string }) => {
    setBusy(true);
    try {
      const dry = await api<{ count: number; total: number; more: boolean }>('/orders/delete', { method: 'POST', body: { ...body, dryRun: true } });
      if (!dry.count) { toast(t('orders.none'), 'info'); return; }
      const backup = async () => {
        const r = await api<{ orders: Order[] }>('/orders', { query: { from: backupRange.from, to: backupRange.to } });
        download(new Blob([toJson(r.orders, backupRange.from, backupRange.to)], { type: 'application/json' }), reportFileName('Backup', backupRange.from, backupRange.to, 'json'));
      };
      const ok = await confirm({
        title: body.mode === 'range' ? t('settings.deleteDate') : t('settings.deleteOlder'), danger: true, confirmText: t('common.delete'), requireText: 'DELETE',
        message: <div className="space-y-3"><p className="font-semibold">{t('settings.affected', { n: dry.count, amount: inr(dry.total) })}</p>
          <button type="button" className="btn-ghost w-full" onClick={backup}>⬇️ {t('settings.backupFirst')}</button></div>,
      });
      if (!ok) return;
      const r = await api<{ count: number; backupPath: string }>('/orders/delete', { method: 'POST', body: { ...body, dryRun: false, confirm: 'DELETE' } });
      toast(t('settings.deleted', { n: r.count, path: r.backupPath }), 'success');
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <Section title={t('settings.data')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line p-3">
          <div className="font-semibold mb-2">{t('settings.deleteDate')}</div>
          <input type="date" className="input mb-2" max={istToday()} value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn-danger w-full" disabled={busy || !date} onClick={() => run({ mode: 'range', from: date }, { from: date, to: date })}>{t('settings.check')}</button>
        </div>
        <div className="rounded-xl border border-line p-3 flex flex-col">
          <div className="font-semibold mb-2">{t('settings.deleteOlder')}</div>
          <button className="btn-danger w-full mt-auto" disabled={busy} onClick={() => run({ mode: 'olderThan', days: 30 }, { from: addDays(istToday(), -400), to: addDays(istToday(), -31) })}>{t('settings.check')}</button>
        </div>
      </div>
    </Section>
  );
}

function Logs() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'backups' | 'audit' | 'exports'>('backups');
  const backups = useApi<{ name: string; size: number; created: string }[]>(tab === 'backups' ? '/backups' : null);
  const audit = useApi<{ id: string; actorName: string; action: string; at: string; details: unknown }[]>(tab === 'audit' ? '/audit' : null);
  const exportsH = useApi<{ id: string; userName: string; format: string; from: string; to: string; count: number; action: string; at: string }[]>(tab === 'exports' ? '/exports/history' : null);
  const fetchBackup = async (name: string) => {
    const blob = await api<Blob>(`/backups/${encodeURIComponent(name)}`);
    download(blob instanceof Blob ? blob : new Blob([JSON.stringify(blob, null, 2)], { type: 'application/json' }), name);
  };
  const when = (s?: string) => (s ? new Date(s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '');
  return (
    <Section title={`${t('settings.backups')} · ${t('settings.audit')}`}>
      <div className="flex flex-wrap gap-2 mb-3">
        {(['backups', 'audit', 'exports'] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)} className={`chip border !min-h-10 ${tab === k ? 'bg-ink text-white border-ink' : 'bg-white border-line'}`}>
            {k === 'backups' ? t('settings.backups') : k === 'audit' ? t('settings.audit') : t('settings.exportHistory')}</button>
        ))}
      </div>
      <div className="max-h-96 overflow-y-auto text-sm" lang="en">
        {tab === 'backups' && (backups.data?.length ? backups.data.map((b) => (
          <div key={b.name} className="flex items-center justify-between gap-2 border-t border-line py-2">
            <span className="min-w-0 break-all">{b.name}<span className="block text-muted">{when(b.created)} · {(b.size / 1024).toFixed(1)} KB</span></span>
            <button className="btn-ghost !min-h-10" onClick={() => fetchBackup(b.name)}>⬇️</button>
          </div>)) : <p className="text-muted">{t('common.noData')}</p>)}
        {tab === 'audit' && (audit.data ?? []).map((a) => (
          <div key={a.id} className="border-t border-line py-2"><b>{a.action}</b> · {a.actorName} · <span className="text-muted">{when(a.at)}</span>
            <div className="text-xs text-muted break-all">{JSON.stringify(a.details)}</div></div>))}
        {tab === 'exports' && (exportsH.data ?? []).map((x) => (
          <div key={x.id} className="border-t border-line py-2">{x.format.toUpperCase()} {x.action} · {x.userName} · {x.from}→{x.to} · {x.count} · <span className="text-muted">{when(x.at)}</span></div>))}
      </div>
    </Section>
  );
}
