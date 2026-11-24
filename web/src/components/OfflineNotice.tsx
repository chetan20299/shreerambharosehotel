import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useOnline } from '../hooks';

/** Animated illustration: wifi waves fade in and out, a red slash draws across, a small cloud drifts. */
function NoWifiArt() {
  return (
    <svg viewBox="0 0 160 140" className="h-40 w-44" aria-hidden>
      <g className="off-cloud" fill="#EADFCB"><circle cx="30" cy="34" r="10" /><circle cx="42" cy="28" r="13" /><circle cx="55" cy="34" r="10" /><rect x="22" y="34" width="42" height="10" rx="5" /></g>
      <circle cx="80" cy="76" r="54" fill="#FBEFD3" />
      <g fill="none" strokeLinecap="round" strokeWidth="9">
        <path className="off-wave off-w3" d="M40 70 a58 58 0 0 1 80 0" stroke="#B4441B" />
        <path className="off-wave off-w2" d="M52 84 a40 40 0 0 1 56 0" stroke="#B4441B" />
        <path className="off-wave off-w1" d="M64 98 a22 22 0 0 1 32 0" stroke="#B4441B" />
      </g>
      <circle cx="80" cy="110" r="7" fill="#B4441B" />
      <path className="off-slash" d="M44 44 L118 118" stroke="#C62828" strokeWidth="9" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Full-screen "Turn on the internet" notice, shown when the phone goes offline.
 * "Continue offline" hides it (orders still work offline and sync later); it shows again on the next drop.
 * When the internet returns, a short "Back online ✓" message appears and the notice closes by itself.
 */
export function OfflineNotice() {
  const { t } = useI18n();
  const online = useOnline();
  const [dismissed, setDismissed] = useState(false);
  const [back, setBack] = useState(false);
  const wasOffline = useRef(!online);
  useEffect(() => {
    if (!online) { wasOffline.current = true; setDismissed(false); return; }
    if (wasOffline.current) {
      wasOffline.current = false;
      setBack(true);
      const id = setTimeout(() => setBack(false), 2200);
      return () => clearTimeout(id);
    }
  }, [online]);

  if (back) {
    return (
      <div role="status" className="fixed top-[calc(0.75rem+env(safe-area-inset-top))] inset-x-0 z-[80] flex justify-center px-4 pointer-events-none">
        <div className="rounded-full bg-success text-white font-bold px-5 py-2 shadow-lg anim-fade">{t('offline.back')}</div>
      </div>
    );
  }
  if (online || dismissed) return null;
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-bg/95 backdrop-blur-sm p-6 anim-fade" role="alertdialog" aria-modal="true" aria-labelledby="offline-title" data-testid="offline-notice">
      <div className="card max-w-sm w-full p-6 text-center flex flex-col items-center gap-3">
        <NoWifiArt />
        <h2 id="offline-title" className="text-2xl font-bold">{t('offline.title')}</h2>
        <p className="text-muted">{t('offline.body')}</p>
        <div className="flex items-center gap-2 text-sm font-semibold text-muted" aria-hidden>
          {[0, 1, 2].map((i) => <span key={i} className="anim-dot h-2 w-2 rounded-full bg-primary" style={{ animationDelay: `${i * 0.15}s` }} />)}
        </div>
        <button className="btn-primary w-full" onClick={() => setDismissed(true)} data-testid="offline-continue">{t('offline.continue')}</button>
      </div>
    </div>
  );
}
