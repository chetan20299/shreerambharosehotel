import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { ApiError } from '../services/api';

/** Modal dialog. Android back button closes it (we push a history entry while open). */
export function Modal({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    history.pushState({ modal: true }, '');
    const onPop = () => closeRef.current();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    addEventListener('popstate', onPop);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('popstate', onPop);
      removeEventListener('keydown', onKey);
      if (history.state?.modal) history.back();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-ink/40 p-0 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="card w-full sm:max-w-lg max-h-[92dvh] overflow-y-auto rounded-b-none sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-card border-b border-line px-4 py-3 flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold">{title}</h2>
          <button className="text-2xl leading-none text-muted px-2" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="p-4">{children}</div>
        {/* Phones: footer buttons share the width equally; larger screens: right-aligned natural width. */}
        {footer && <div className="sticky bottom-0 bg-card border-t border-line p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex flex-wrap justify-end gap-2 [&>button]:flex-1 sm:[&>button]:flex-none">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

type ToastKind = 'success' | 'error' | 'info';
interface ConfirmOpts { title: string; message?: ReactNode; confirmText?: string; danger?: boolean; requireText?: string }
interface UiCtx { toast: (msg: string, kind?: ToastKind) => void; confirm: (o: ConfirmOpts) => Promise<boolean>; errorText: (e: unknown) => string }
const Ctx = createContext<UiCtx>(null!);

export function UiProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
  const [dlg, setDlg] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');

  const toast = useCallback((msg: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x, { id, msg, kind }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => { setTyped(''); setDlg({ ...o, resolve }); }), []);
  /** Server messages for 400/404/409 are specific (English); common statuses are shown translated. */
  const errorText = useCallback((e: unknown) => {
    if (e instanceof ApiError) {
      if (e.status === 0) return t('err.offline');
      if (e.status === 408) return t('err.timeout');
      if (e.status === 401) return t('err.session');
      if (e.status === 403) return t('err.forbidden');
      if (e.status === 429) return t('err.tooMany');
      if (e.status >= 500) return `${t('err.server')}${e.requestId ? ` (ref ${e.requestId})` : ''}`;
      return e.message;
    }
    return e instanceof Error ? e.message : t('err.server');
  }, [t]);

  // Resolve only after the modal's history entry has been popped; otherwise a caller that navigates right after
  // `await confirm()` races with the async history.back() and gets sent back to the previous page.
  const close = (v: boolean) => {
    const d = dlg;
    if (!d) return;
    if (history.state?.modal) addEventListener('popstate', () => d.resolve(v), { once: true });
    else d.resolve(v);
    setDlg(null);
  };
  return (
    <Ctx.Provider value={{ toast, confirm, errorText }}>
      {children}
      <Modal open={!!dlg} onClose={() => close(false)} title={dlg?.title}
        footer={<>
          <button className="btn-ghost" onClick={() => close(false)}>{t('common.cancel')}</button>
          <button className={dlg?.danger ? 'btn-danger' : 'btn-primary'} disabled={!!dlg?.requireText && typed !== dlg.requireText} onClick={() => close(true)}>
            {dlg?.confirmText ?? t('common.confirm')}
          </button>
        </>}>
        {dlg?.message && <div className="text-ink">{dlg.message}</div>}
        {dlg?.requireText && (
          <label className="block mt-3"><span className="label">{t('settings.typeDelete')}</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" /></label>
        )}
      </Modal>
      <div className="fixed z-50 left-0 right-0 bottom-20 sm:bottom-4 flex flex-col items-center gap-2 px-4 pointer-events-none" aria-live="assertive">
        {toasts.map((x) => (
          <div key={x.id} role="alert" className={`pointer-events-auto max-w-md w-full rounded-xl px-4 py-3 font-semibold text-white shadow-lg ${x.kind === 'success' ? 'bg-success' : x.kind === 'error' ? 'bg-error' : 'bg-ink'}`}>{x.msg}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
export const useUi = () => useContext(Ctx);

export function PageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <h1 className="text-2xl font-bold">{title}</h1>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, tone = 'ink', icon, hint, testId }: {
  label: string; value: ReactNode; tone?: 'ink' | 'primary' | 'secondary' | 'accent' | 'success' | 'error'; icon?: string; hint?: string; testId?: string;
}) {
  const color = { ink: 'text-ink', primary: 'text-primary', secondary: 'text-secondary', accent: 'text-primary-dark', success: 'text-success', error: 'text-error' }[tone];
  return (
    <div className="card p-4 min-w-0" data-testid={testId}>
      <div className="flex items-center gap-2 text-sm font-semibold text-muted">
        {icon && <span aria-hidden className="text-lg leading-none">{icon}</span>}<span className="min-w-0">{label}</span>
      </div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${color}`}>{value}</div>
      {hint && <div className="text-xs text-muted mt-1 leading-snug">{hint}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block mb-3">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted mt-1">{hint}</span>}
    </label>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="card p-8 text-center text-muted">{text}</div>;
}

/** Inline spinner for buttons ("Saving…"). */
export function Spinner({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`inline-block h-4 w-4 rounded-full border-2 border-current border-r-transparent animate-[spin_.7s_linear_infinite] ${className}`} />;
}

/** Placeholder rows while a list loads (keeps layout stable instead of a blank screen). */
export function SkeletonList({ rows = 4, tall = false }: { rows?: number; tall?: boolean }) {
  return (
    <div className="grid gap-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`card p-3 flex items-center gap-3 ${tall ? 'min-h-24' : 'min-h-16'}`}>
          <div className="flex-1 space-y-2"><div className="h-4 w-1/2 rounded bg-line/80 animate-pulse" /><div className="h-3 w-3/4 rounded bg-line/60 animate-pulse" /></div>
          <div className="h-10 w-20 rounded-xl bg-line/70 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/** Placeholder tiles for stat rows / charts. */
export function SkeletonGrid({ count = 4, className = 'grid-cols-2 lg:grid-cols-4', h = 'h-24' }: { count?: number; className?: string; h?: string }) {
  return <div className={`grid gap-3 ${className}`} aria-busy="true">{Array.from({ length: count }, (_, i) => <div key={i} className={`card ${h} animate-pulse bg-line/40`} />)}</div>;
}
