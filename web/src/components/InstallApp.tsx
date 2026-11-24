import { useState, useSyncExternalStore } from 'react';
import { useI18n } from '../i18n';
import { Modal } from './ui';

/**
 * "Install app" (Add to Home screen). Chrome/Android: one-tap native prompt when it offers one.
 * Otherwise (iPhone Safari, Samsung Internet, Chrome not offering yet) the button shows the manual steps.
 * Hidden when already running as the installed app. The prompt is captured early (imported from main.tsx).
 */
type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: PromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as PromptEvent; emit(); });
  window.addEventListener('appinstalled', () => { deferred = null; installed = true; emit(); });
}
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = () => isIos() || /android|mobile/i.test(navigator.userAgent);

export function InstallApp({ className = 'chip gap-2 bg-primary text-white min-h-11' }: { className?: string }) {
  const { t } = useI18n();
  const [help, setHelp] = useState(false);
  const prompt = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => deferred);
  if (installed || standalone() || (!prompt && !isMobile())) return null;
  const install = async () => {
    if (!prompt) { setHelp(true); return; }
    await prompt.prompt(); await prompt.userChoice; deferred = null; emit();
  };
  return (
    <>
      <button className={className} onClick={install} data-testid="install-app">📲 <span>{t('app.install')}</span></button>
      <Modal open={help} onClose={() => setHelp(false)} title={t('app.install')}>
        <ol className="list-decimal pl-5 space-y-2 font-semibold" data-testid="install-steps">
          {isIos()
            ? <><li>{t('install.ios1')}</li><li>{t('install.ios2')}</li><li>{t('install.done')}</li></>
            : <><li>{t('install.and1')}</li><li>{t('install.and2')}</li><li>{t('install.done')}</li></>}
        </ol>
      </Modal>
    </>
  );
}
