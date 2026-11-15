import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n';
import { api } from '../services/api';
import { Wordmark } from '../components/Brand';
import { useUi } from '../components/ui';

/** /reset-password#<token> — token is in the URL fragment so it never reaches server logs. */
export function ResetPasswordPage() {
  const { t } = useI18n();
  const { errorText } = useUi();
  const token = location.hash.slice(1);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setMsg({ ok: false, text: t('settings.mismatch') });
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, newPassword: pw } });
      history.replaceState(null, '', '/reset-password');
      setMsg({ ok: true, text: t('reset.done') });
    } catch (err) { setMsg({ ok: false, text: errorText(err) }); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-dvh grid place-items-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <Wordmark />
        <form className="card p-5 space-y-3" onSubmit={submit}>
          <h1 className="text-xl font-bold">{t('reset.title')}</h1>
          {!token && !msg?.ok && <div className="text-error font-semibold">{t('reset.missing')}</div>}
          <label className="block"><span className="label">{t('settings.new')}</span>
            <input className="input" type="password" autoComplete="new-password" minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <label className="block"><span className="label">{t('settings.confirmNew')}</span>
            <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
          {msg && <div role="alert" className={`font-semibold ${msg.ok ? 'text-success' : 'text-error'}`}>{msg.text}</div>}
          <button className="btn-primary w-full" disabled={busy || !token || pw.length < 8 || msg?.ok}>{t('common.save')}</button>
          <Link to="/login" className="block text-center font-semibold text-primary">{t('login.submit')}</Link>
        </form>
      </div>
    </div>
  );
}
