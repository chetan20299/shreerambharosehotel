/** Full-screen action feedback with custom SVG animations (CSS keyframes in index.css). */
export type ActionKind = 'saving' | 'printing' | 'done';

function Saving() {
  // Thali plate turning while three katoris drop onto it one after another.
  return (
    <svg viewBox="0 0 120 120" className="h-32 w-32" aria-hidden>
      <g className="anim-plate"><circle cx="60" cy="68" r="44" fill="#E2A62B" /><circle cx="60" cy="68" r="36" fill="#FBF6EE" />
        <circle cx="60" cy="68" r="40" fill="none" stroke="#8A3214" strokeWidth="2" strokeDasharray="0.1 6" strokeLinecap="round" /></g>
      {[[44, 58, '#D97706', '0s'], [60, 50, '#1F5F4A', '.25s'], [76, 58, '#F3D27A', '.5s']].map(([x, y, c, d]) => (
        <g key={String(c)} className="anim-drop" style={{ animationDelay: String(d) }}>
          <circle cx={Number(x)} cy={Number(y)} r="9" fill="#E2A62B" /><circle cx={Number(x)} cy={Number(y)} r="6" fill={String(c)} />
        </g>
      ))}
      <circle className="anim-drop" style={{ animationDelay: '.75s' }} cx="52" cy="82" r="10" fill="#E9C994" stroke="#D4AA6A" strokeWidth="1.5" />
    </svg>
  );
}

function Printing() {
  // Thermal printer feeding a receipt; text lines appear as the paper comes out.
  return (
    <svg viewBox="0 0 120 120" className="h-32 w-32" aria-hidden>
      <clipPath id="paper-clip"><rect x="30" y="52" width="60" height="64" /></clipPath>
      <g clipPath="url(#paper-clip)">
        <g className="anim-paper">
          <rect x="38" y="20" width="44" height="64" fill="#fff" stroke="#EADFCB" />
          {[30, 38, 46, 54, 62].map((y, i) => <rect key={y} x="44" y={y} width={i === 4 ? 18 : 32} height="3" rx="1.5" fill="#2B1D14" opacity=".75" />)}
          <path d="M38 84 l4 -4 4 4 4 -4 4 4 4 -4 4 4 4 -4 4 4 4 -4 4 4" fill="#fff" stroke="#EADFCB" />
        </g>
      </g>
      <rect x="22" y="26" width="76" height="30" rx="8" fill="#B4441B" />
      <rect x="30" y="50" width="60" height="5" rx="2.5" fill="#2B1D14" />
      <circle className="anim-blink" cx="88" cy="36" r="3" fill="#7CE0A3" />
      <rect x="34" y="33" width="30" height="5" rx="2.5" fill="#F6E3D8" opacity=".8" />
    </svg>
  );
}

function Done() {
  return (
    <svg viewBox="0 0 120 120" className="h-28 w-28" aria-hidden>
      <circle className="anim-pop" cx="60" cy="60" r="46" fill="#2E7D4F" />
      <path className="anim-check" d="M38 62 l15 15 30 -32" fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ActionOverlay({ kind, label }: { kind: ActionKind | null; label: string }) {
  if (!kind) return null;
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-bg/90 backdrop-blur-sm anim-fade" role="status" aria-live="assertive" data-testid={`overlay-${kind}`}>
      <div className="flex flex-col items-center gap-3 text-center px-6">
        {kind === 'saving' ? <Saving /> : kind === 'printing' ? <Printing /> : <Done />}
        <div className={`text-xl font-bold ${kind === 'done' ? 'text-success' : 'text-ink'}`}>{label}</div>
        {kind !== 'done' && <div className="flex gap-1.5" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className="anim-dot h-2 w-2 rounded-full bg-primary" style={{ animationDelay: `${i * 0.15}s` }} />)}</div>}
      </div>
    </div>
  );
}

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
