import type { TableStatus } from '../types';

export type FixtureType = 'entry' | 'exit' | 'door' | 'kitchen';

const TABLE_COLORS: Record<TableStatus, { top: string; edge: string; chair: string; text: string }> = {
  available: { top: '#DCEBE4', edge: '#1F5F4A', chair: '#8FB8A6', text: '#1F5F4A' },
  in_progress: { top: '#FBEFD3', edge: '#C98B12', chair: '#E9C77A', text: '#7A4E00' },
  occupied: { top: '#B4441B', edge: '#8A3214', chair: '#D9946F', text: '#FFFFFF' },
  billed: { top: '#E8E1F5', edge: '#5B4B8A', chair: '#B5A8D8', text: '#3F3366' },
};

/** Top-down table with chairs (4 or 6 seats drawn), coloured by status. Label is rendered on the table top. */
export function TableIcon({ status, label, seats }: { status: TableStatus; label: string; seats: number }) {
  const c = TABLE_COLORS[status];
  const six = seats > 4;
  const chairsX = six ? [14, 38] : [26];
  // Big table top + big number so the label stays readable even on small phones.
  return (
    <svg viewBox="0 0 64 64" className="h-full w-full" aria-hidden="true">
      {chairsX.map((x) => <rect key={`t${x}`} x={x} y="1" width="12" height="6" rx="3" fill={c.chair} />)}
      {chairsX.map((x) => <rect key={`b${x}`} x={x} y="57" width="12" height="6" rx="3" fill={c.chair} />)}
      <rect x="1" y="26" width="6" height="12" rx="3" fill={c.chair} />
      <rect x="57" y="26" width="6" height="12" rx="3" fill={c.chair} />
      <rect x="8" y="8" width="48" height="48" rx="10" fill={c.top} stroke={c.edge} strokeWidth="3" />
      <text x="32" y={label.length > 3 ? 37 : 39} textAnchor="middle" fontSize={label.length > 4 ? 13 : label.length > 3 ? 16 : 21} fontWeight="800" fill={c.text} fontFamily="Hind Vadodara, system-ui, sans-serif">{label}</text>
    </svg>
  );
}

const FIX: Record<FixtureType, { bg: string; fg: string; path: string }> = {
  entry: { bg: '#DCEBE4', fg: '#1F5F4A', path: 'M14 8h18v48H14zM40 32H58M46 24l-8 8 8 8' },
  exit: { bg: '#F9DEDC', fg: '#C62828', path: 'M14 8h18v48H14zM38 32h20M50 24l8 8-8 8' },
  door: { bg: '#F1E7D8', fg: '#6B4A2B', path: 'M18 8h28v48H18zM38 32h2M18 56h28' },
  kitchen: { bg: '#FBEFD3', fg: '#8A3214', path: 'M14 30h36v18a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6zM10 30h44M24 22c0-4 4-4 4-8M34 22c0-4 4-4 4-8' },
};

/** Entry / Exit / Door / Kitchen door marker for the floor plan. */
export function FixtureIcon({ type }: { type: FixtureType }) {
  const f = FIX[type];
  return (
    <svg viewBox="0 0 64 64" className="h-full w-full" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="12" fill={f.bg} />
      <path d={f.path} fill="none" stroke={f.fg} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
