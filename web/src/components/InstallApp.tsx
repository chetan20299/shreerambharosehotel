import { useSyncExternalStore } from 'react';
import { useI18n } from '../i18n';

/** Chrome/Android "Add to Home screen" prompt, captured early (imported from main.tsx). Hidden once installed / on iOS. */
type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: PromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as PromptEvent; emit(); });
  window.addEventListener('appinstalled', () => { deferred = null; emit(); });
}

export function InstallApp({ className = 'chip gap-2 bg-primary text-white min-h-11' }: { className?: string }) {
  const { t } = useI18n();
  const prompt = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => deferred);
  if (!prompt) return null;
  const install = async () => { await prompt.prompt(); await prompt.userChoice; deferred = null; emit(); };
  return <button className={className} onClick={install} data-testid="install-app">📲 <span>{t('app.install')}</span></button>;
}
