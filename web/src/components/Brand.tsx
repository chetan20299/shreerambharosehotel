import { useI18n } from '../i18n';

/** Animated thali (same artwork as /brand/logo-icon.svg): rim rotates, diya flame flickers. */
export function ThaliMark({ size = 64, animated = false }: { size?: number; animated?: boolean }) {
  return (
    <svg viewBox="72 72 368 368" width={size} height={size} aria-hidden="true">
      <circle cx="256" cy="256" r="184" fill="#E2A62B" />
      <circle className={animated ? 'loader-rim' : ''} cx="256" cy="256" r="166" fill="none" stroke="#8A3214" strokeWidth="7" strokeLinecap="round" strokeDasharray="0.1 21.6" />
      <circle cx="256" cy="256" r="150" fill="#FBF6EE" />
      {[[172, 208, '#D97706'], [256, 160, '#1F5F4A'], [340, 208, '#F3D27A']].map(([x, y, c]) => (
        <g key={String(c)}><circle cx={x} cy={y} r="38" fill="#E2A62B" /><circle cx={x} cy={y} r="27" fill={String(c)} /></g>
      ))}
      <circle cx="200" cy="318" r="50" fill="#E9C994" stroke="#D4AA6A" strokeWidth="3" />
      <path d="M262 352 q50 -82 100 0 z" fill="#fff" stroke="#E6D8BE" strokeWidth="4" strokeLinejoin="round" />
      <path className={animated ? 'loader-flame' : ''} d="M256 236 c-14 14 -14 30 0 38 c14 -8 14 -24 0 -38z" fill="#B4441B" />
    </svg>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 min-w-0">
      <ThaliMark size={compact ? 36 : 48} />
      <div className="min-w-0">
        <div className="font-display text-lg leading-tight text-ink">{t('app.name')}</div>
        <div className="text-xs font-bold tracking-wider text-secondary uppercase">{t('app.tagline')}</div>
      </div>
    </div>
  );
}

/** Branded loader used for startup, login, dashboard, menu, export and printing states. */
export function Loader({ label, full = false }: { label?: string; full?: boolean }) {
  const body = (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 p-6 text-muted">
      <ThaliMark size={full ? 96 : 64} animated />
      {label && <div className="font-semibold text-center">{label}</div>}
    </div>
  );
  return full ? <div className="fixed inset-0 z-50 grid place-items-center bg-bg/95">{body}</div> : body;
}
