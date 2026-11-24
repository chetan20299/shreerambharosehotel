import { useI18n } from '../i18n';

/**
 * Hotel mark (same artwork as /brand/logo-icon.svg, from branding/generate.mjs): Shree Ram's bow over a
 * steaming handi with folded hands. Animated: ring turns, bow draws itself, steam rises, hands nod.
 */
export function LogoMark({ size = 64, animated = false }: { size?: number; animated?: boolean }) {
  const gold = '#E2A62B', cream = '#FBF6EE', saffron = '#B4441B';
  return (
    <svg viewBox="0 0 512 512" width={size} height={size} aria-hidden="true" className={animated ? 'logo-anim' : undefined}>
      <circle cx="256" cy="256" r="240" fill={saffron} />
      <circle cx="256" cy="256" r="222" fill="none" stroke={gold} strokeWidth="6" />
      <circle className="logo-ring" cx="256" cy="256" r="206" fill="none" stroke={gold} strokeWidth="5" strokeLinecap="round" strokeDasharray="0.1 18" opacity="0.75" />
      <g transform="translate(0 -22)">
        <path className="logo-bow" pathLength={100} d="M108 286 Q256 40 404 286" fill="none" stroke={gold} strokeWidth="18" strokeLinecap="round" />
        <path d="M108 286 q-8 14 -30 18 M404 286 q8 14 30 18" fill="none" stroke={gold} strokeWidth="14" strokeLinecap="round" />
        <g className="logo-steam" fill="none" stroke={cream} strokeWidth="10" strokeLinecap="round">
          <path d="M206 262 c-16 -18 16 -34 0 -56" /><path d="M256 252 c-16 -20 16 -38 0 -64" /><path d="M306 262 c-16 -18 16 -34 0 -56" />
        </g>
        <path d="M138 286 H374 A118 118 0 0 1 138 286 Z" fill={cream} />
        <rect x="126" y="276" width="260" height="22" rx="11" fill={gold} />
        <g className="logo-hands">
          <path fill={saffron} d="M253 300 C244 300 237 314 235 330 C233 346 230 356 222 366 C218 372 223 379 231 376 C241 372 250 366 253 360 Z" />
          <path fill={saffron} d="M259 300 C268 300 275 314 277 330 C279 346 282 356 290 366 C294 372 289 379 281 376 C271 372 262 366 259 360 Z" />
          <path d="M241 344 q-7 6 -5 16 M271 344 q7 6 5 16" fill="none" stroke={cream} strokeWidth="3" strokeLinecap="round" />
        </g>
        <rect x="222" y="382" width="68" height="8" rx="4" fill={gold} />
        <rect x="212" y="398" width="88" height="16" rx="8" fill={gold} />
      </g>
    </svg>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 min-w-0">
      <LogoMark size={compact ? 36 : 48} />
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
      <LogoMark size={full ? 96 : 64} animated />
      {label && <div className="font-semibold text-center">{label}</div>}
    </div>
  );
  return full ? <div className="fixed inset-0 z-50 grid place-items-center bg-bg/95">{body}</div> : body;
}
