import { LANGS, useI18n } from '../i18n';
import { useAuth } from '../auth/AuthContext';
import type { Lang } from '../types';

/** Language names are always shown in their own script so anyone can find theirs. */
export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const { lang, t, switching } = useI18n();
  const { setLanguage } = useAuth();
  if (compact) {
    return (
      <select aria-label={t('lang.label')} className="input !min-h-10 !w-auto !py-1 text-sm font-semibold" value={lang} disabled={switching}
        onChange={(e) => void setLanguage(e.target.value as Lang)}>
        {LANGS.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
      </select>
    );
  }
  return (
    <div role="radiogroup" aria-label={t('lang.label')} className="grid grid-cols-3 gap-2">
      {LANGS.map((l) => (
        <button key={l.code} role="radio" aria-checked={lang === l.code} disabled={switching}
          onClick={() => void setLanguage(l.code)}
          className={`btn !px-2 border ${lang === l.code ? 'bg-primary text-white border-primary' : 'bg-white border-line text-ink'}`}>
          {l.native}
        </button>
      ))}
    </div>
  );
}
