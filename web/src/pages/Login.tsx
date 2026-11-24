import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { api, ApiError } from '../services/api';
import { Loader, LogoMark } from '../components/Brand';
import { LanguagePicker } from '../components/LanguagePicker';
import { InstallApp } from '../components/InstallApp';
import { Modal, useUi } from '../components/ui';

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const { t } = useI18n();
  const { errorText } = useUi();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [forgot, setForgot] = useState(false);
  const [setup, setSetup] = useState(false); // no owner account yet → show first-time setup
  const [name, setName] = useState('');

  useEffect(() => { api<{ needed: boolean }>('/setup/status', { silent: true }).then((r) => setSetup(r.needed)).catch(() => setSetup(false)); }, []);

  if (loading) return <Loader full label={t('loader.startup')} />;
  if (user) return <Navigate to="/" replace />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof ApiError && e.status === 401 ? t('login.invalid') : errorText(e)); } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (setup) await api('/bootstrap', { method: 'POST', body: { username: username.trim().toLowerCase(), displayName: name.trim(), password } });
      await login(username.trim(), password);
    });
  };

  return (
    <div className="min-h-dvh grid place-items-center p-4 bg-[radial-gradient(circle_at_top,#F6E3D8,transparent_60%)]">
      {busy && <Loader full label={t('loader.login')} />}
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-6">
          <LogoMark size={104} animated />
          <div className="font-display text-3xl mt-3">Shree Ram Bharose</div>
          <div className="text-sm font-bold tracking-[.3em] text-secondary">HINDU HOTEL</div>
          <div className="font-bold text-primary mt-1" lang="gu">શ્રી રામ ભરોસે</div>
        </div>
        <form onSubmit={submit} className="card p-5 space-y-3" noValidate>
          <div>
            <h1 className="text-xl font-bold">{setup ? t('setup.title') : t('login.welcome')}</h1>
            <p className="text-muted text-sm">{setup ? t('setup.help') : t('login.subtitle')}</p>
          </div>
          {setup && <label className="block"><span className="label">{t('setup.name')}</span>
            <input className="input" name="display-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} required /></label>}
          <label className="block"><span className="label">{t('login.username')}</span>
            <input className="input" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
              value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
          <label className="block"><span className="label">{t('login.password')}</span>
            <div className="relative">
              <input className="input pr-14" name="password" type={show ? 'text' : 'password'} autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="absolute right-1 top-1/2 -translate-y-1/2 h-10 w-12 rounded-lg text-xl"
                aria-label={show ? t('login.hide') : t('login.show')} aria-pressed={show} onClick={() => setShow(!show)}>{show ? '🙈' : '👁️'}</button>
            </div></label>
          {error && <div role="alert" className="rounded-xl bg-error/10 text-error px-3 py-2 font-semibold">{error}</div>}
          <button className="btn-primary w-full" disabled={busy || !username || !password || (setup && (!name.trim() || password.length < 8))}>{setup ? t('setup.submit') : t('login.submit')}</button>
          <button type="button" className="w-full text-sm font-semibold text-primary py-2" onClick={() => setForgot(true)}>{t('login.forgot')}</button>
        </form>

        <div className="mt-4"><LanguagePicker /></div>
        <div className="mt-4 flex justify-center"><InstallApp /></div>
      </div>
      <Modal open={forgot} onClose={() => setForgot(false)} title={t('login.forgot')}>
        <p>{t('login.forgotHelp')}</p>
      </Modal>
    </div>
  );
}
