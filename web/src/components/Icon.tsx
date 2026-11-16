/** Small stroke icon set (24×24, currentColor) — consistent on every Android device, unlike emoji. */
const PATHS = {
  dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  tables: 'M4 9h16M6 9v10M18 9v10M8 5h8a2 2 0 0 1 2 2v2H6V7a2 2 0 0 1 2-2zM9 14h6',
  orders: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  reports: 'M12 3v12M7 10l5 5 5-5M4 19h16',
  expense: 'M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4zM4 7l11-3v3M15 13.5h3M8 11h4M8 15h3',
  menu: 'M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 18a2 2 0 0 1 2-2h12M9 8h6M9 11h4',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  history: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14h3M8 17h6',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 6h14M5 12h14M5 18h14',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4',
  close: 'M6 6l12 12M18 6L6 18',
  collapse: 'M15 6l-6 6 6 6',
  expand: 'M9 6l6 6-6 6',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'h-6 w-6', strokeWidth = 2 }: { name: IconName; className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
