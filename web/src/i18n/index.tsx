import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { en, type Key } from './en';
import { gu } from './gu';
import { hi } from './hi';
import type { Lang } from '../types';

export type { Key };
const dicts: Record<Lang, Record<Key, string>> = { en, gu, hi };
export const LANGS: { code: Lang; native: string }[] = [
  { code: 'en', native: 'English' },
  { code: 'gu', native: 'ગુજરાતી' },
  { code: 'hi', native: 'हिन्दी' },
];
// Font that renders each script, and a sample string to force the right unicode-range subset to download.
const FONT_PROBE: Record<Lang, [string, string]> = {
  en: ['16px "Hind Vadodara"', 'Aa'],
  gu: ['16px "Hind Vadodara"', 'ગુજરાતી ₹'],
  hi: ['16px "Hind"', 'हिन्दी ₹'],
};
const STORE = 'srbh.lang';

export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>) {
  let s = dicts[lang][key] ?? en[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

const readStored = (): Lang => {
  try { const v = localStorage.getItem(STORE); return v === 'gu' || v === 'hi' ? v : 'en'; } catch { return 'en'; }
};

/** Waits until the script's font is really available (max 5s) so text never renders as boxes or reflows mid-switch. */
async function loadFont(lang: Lang) {
  const [font, sample] = FONT_PROBE[lang];
  await Promise.race([
    Promise.all([document.fonts.load(font, sample), document.fonts.load(font.replace('16px', '600 16px'), sample)]).then(() => document.fonts.ready),
    new Promise((r) => setTimeout(r, 5000)),
  ]).catch(() => undefined);
}

interface Ctx { lang: Lang; switching: boolean; setLang: (l: Lang) => Promise<void>; t: (key: Key, vars?: Record<string, string | number>) => string }
const I18nCtx = createContext<Ctx>(null!);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStored);
  const [switching, setSwitching] = useState(false);

  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  useEffect(() => { void loadFont(lang); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setLang = useCallback(async (l: Lang) => {
    if (l === lang) return;
    setSwitching(true);
    await loadFont(l);
    try { localStorage.setItem(STORE, l); } catch { /* private mode */ }
    setLangState(l);
    setSwitching(false);
  }, [lang]);

  const t = useCallback((key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
  return <I18nCtx.Provider value={{ lang, switching, setLang, t }}>{children}</I18nCtx.Provider>;
}

export const useI18n = () => useContext(I18nCtx);
