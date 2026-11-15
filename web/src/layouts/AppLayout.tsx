import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useI18n, type Key } from '../i18n';
import { useFocusMode, useOnline, usePending } from '../hooks';
import { syncPending } from '../services/offlineQueue';
import { getInFlight, subscribeInFlight } from '../services/api';
import { runStation } from '../printing/station';
import { ThaliMark } from '../components/Brand';
import { LanguagePicker } from '../components/LanguagePicker';
import { useUi } from '../components/ui';
import { PrinterStatus } from '../components/PrinterStatus';
import { Icon, type IconName } from '../components/Icon';
import type { User } from '../types';

type Item = { to: string; key: Key; icon: IconName; admin?: boolean };
const NAV: Item[] = [
  { to: '/dashboard', key: 'nav.dashboard', icon: 'dashboard', admin: true },
  { to: '/new', key: 'tables.newOrder', icon: 'plus' },
  { to: '/orders', key: 'nav.orders', icon: 'orders' },
  { to: '/reports', key: 'nav.reports', icon: 'reports' },
  { to: '/menu', key: 'nav.menu', icon: 'menu', admin: true },
  { to: '/users', key: 'nav.users', icon: 'users', admin: true },
  { to: '/history', key: 'nav.history', icon: 'history', admin: true },
  { to: '/settings', key: 'nav.settings', icon: 'settings' },
];
const reported = new WeakSet<object>();
const SIDEBAR_KEY = 'srbh.sidebar';

const initials = (name = '') => name.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

/** Thin bar at the very top while any API request is running longer than 250 ms. */
function TopProgress() {
  const n = useSyncExternalStore(subscribeInFlight, getInFlight);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!n) { setShow(false); return; }
    const id = setTimeout(() => setShow(true), 250);
    return () => clearTimeout(id);
  }, [n > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`fixed top-0 inset-x-0 z-[60] h-1 overflow-hidden transition-opacity ${show ? 'opacity-100' : 'opacity-0'}`} role="progressbar" aria-hidden={!show}>
      <div className="h-full w-1/3 bg-primary animate-[progress-slide_1s_ease-in-out_infinite]" />
    </div>
  );
}

function Avatar({ user, size = 'h-10 w-10 text-sm' }: { user: User | null; size?: string }) {
  return <span aria-hidden className={`${size} shrink-0 rounded-full bg-secondary text-white font-bold grid place-items-center`}>{initials(user?.displayName)}</span>;
}

/** Avatar button → profile popover (name, role, language, account, logout). */
function ProfileMenu({ onLogout }: { onLogout: () => void }) {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname, lang]); // close after navigating or switching language
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener('mousedown', close); addEventListener('keydown', close);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', close); };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={t('profile.title')} data-testid="profile-button"
        className="flex items-center gap-2 rounded-full border border-line bg-white p-1 pr-1 sm:pr-3 min-h-11">
        <Avatar user={user} size="h-9 w-9 text-sm" />
        <span className="hidden sm:block text-sm font-semibold max-w-[9rem] truncate">{user?.displayName}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(20rem,calc(100vw-2rem))] max-h-[calc(100dvh-5rem)] overflow-y-auto card p-4 shadow-xl">
          <div className="flex items-center gap-3">
            <Avatar user={user} size="h-12 w-12 text-base" />
            <div className="min-w-0">
              <div className="text-xs text-muted">{t('profile.signedInAs')}</div>
              <div className="font-bold truncate">{user?.displayName}</div>
              <div className="text-sm text-muted truncate">@{user?.username} · <span className="chip !py-0 !px-2 text-xs bg-secondary-soft text-secondary">{user?.role === 'admin' ? t('users.admin') : t('users.waiter')}</span></div>
            </div>
          </div>
          <div className="mt-4" data-testid="profile-printer"><div className="label">{t('printer.title')}</div><PrinterStatus variant="card" /></div>
          <div className="mt-4"><div className="label">{t('lang.label')}</div><LanguagePicker /></div>
          <Link to="/settings" className="btn-ghost w-full mt-3" role="menuitem">⚙️ {t('profile.account')}</Link>
          <button className="btn-ghost w-full mt-2 text-error" onClick={onLogout} role="menuitem" data-testid="logout">🚪 {t('nav.logout')}</button>
        </div>
      )}
    </div>
  );
}

function BottomTab({ item, label, badge }: { item: Item; label: string; badge?: number }) {
  return (
    <NavLink to={item.to} className={({ isActive }) => `relative flex flex-col items-center gap-1 py-1 min-h-14 text-[max(0.68rem,11px)] leading-tight ${isActive ? 'text-primary font-bold' : 'text-muted font-semibold'}`}>
      {({ isActive }) => (
        <>
          <span className={`grid place-items-center h-8 w-12 rounded-full transition ${isActive ? 'bg-primary-soft' : ''}`}><Icon name={item.icon} strokeWidth={isActive ? 2.4 : 2} /></span>
          <span className="line-clamp-1 text-center px-0.5">{label}</span>
          {!!badge && <span className="absolute top-0 right-[18%] min-w-5 h-5 px-1 rounded-full bg-warning text-white text-[max(0.65rem,10px)] font-bold grid place-items-center">{badge}</span>}
        </>
      )}
    </NavLink>
  );
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const { toast } = useUi();
  const online = useOnline();
  const pending = usePending();
  const nav = useNavigate();
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    try { const v = localStorage.getItem(SIDEBAR_KEY); if (v) return v === 'open'; } catch { /* ignore */ }
    return window.innerWidth >= 1024; // tablets start collapsed (icons), desktops expanded
  });
  const isAdmin = user?.role === 'admin';
  const items = NAV.filter((n) => !n.admin || isAdmin).map((n) => (n.to === '/settings' && !isAdmin ? { ...n, key: 'nav.account' as Key } : n));
  // Bottom bar: 2 tabs · big centre "New order" · 1 tab · More (drawer). Admin: Dashboard/Tables · Orders; waiter: Tables/Orders · Reports.
  const find = (to: string) => items.find((i) => i.to === to)!;
  const bottomLeft = isAdmin ? [find('/dashboard'), find('/orders')] : [find('/orders'), find('/reports')];
  const bottomRight = isAdmin ? [find('/reports')] : [find('/settings')];
  const taskFocus = useFocusMode();
  const focusMode = loc.pathname.startsWith('/order/') || taskFocus; // order entry / layout editing use the full screen
  const mine = pending.filter((p) => p.waiterId === user?.id);
  const others = pending.length - mine.length;

  useEffect(() => runStation(!!user), [user]);
  useEffect(() => setDrawer(false), [loc.pathname]);
  const toggleSidebar = () => setExpanded((v) => { try { localStorage.setItem(SIDEBAR_KEY, v ? 'closed' : 'open'); } catch { /* ignore */ } return !v; });

  // Drawer: Android back button closes it (history entry while open).
  useEffect(() => {
    if (!drawer) return;
    history.pushState({ drawer: true }, '');
    const onPop = () => setDrawer(false);
    addEventListener('popstate', onPop);
    return () => { removeEventListener('popstate', onPop); if (history.state?.drawer) history.back(); };
  }, [drawer]);

  const sync = async () => {
    if (!user || !navigator.onLine) return;
    const r = await syncPending(user.id);
    if (reported.has(r)) return; // concurrent triggers share one run: announce it once
    reported.add(r);
    if (r.saved.length) toast(t('net.synced', { n: r.saved.length }), 'success');
    r.failed.forEach((f) => toast(t('net.syncFailed', { table: f.tableLabel, error: f.error ?? '' }), 'error'));
  };
  useEffect(() => {
    void sync();
    // The 'online' event can fire before the network is really usable: retry shortly after, too.
    const timers: number[] = [];
    const onOnline = () => { void sync(); timers.push(window.setTimeout(sync, 2500), window.setTimeout(sync, 7000)); };
    addEventListener('online', onOnline);
    const id = setInterval(() => { if (mine.length) void sync(); }, 20_000);
    return () => { removeEventListener('online', onOnline); clearInterval(id); timers.forEach(clearTimeout); };
  }, [mine.length, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const doLogout = async () => { await logout(); nav('/login', { replace: true }); };
  const navLink = (n: Item, compact: boolean) => (
    <NavLink key={n.to} to={n.to} title={compact ? t(n.key) : undefined}
      className={({ isActive }) => `group flex items-center gap-3 rounded-xl min-h-12 font-semibold transition ${compact ? 'justify-center px-0' : 'px-3'} ${isActive ? 'bg-primary text-white shadow-sm' : 'text-ink hover:bg-primary-soft'}`}>
      <Icon name={n.icon} className="h-6 w-6 shrink-0" />
      <span className={compact ? 'sr-only' : 'truncate'}>{t(n.key)}</span>
    </NavLink>
  );

  return (
    <div style={{ '--sidebar-w': expanded ? '16rem' : '5rem' } as CSSProperties}
      className={`min-h-dvh md:pb-0 transition-[padding] ${focusMode ? '' : 'pb-[calc(6.5rem+env(safe-area-inset-bottom))]'} ${expanded ? 'md:pl-64' : 'md:pl-20'}`}>
      <TopProgress />

      {/* ===== Sidebar (tablet & desktop) ===== */}
      <aside className={`hidden md:flex fixed inset-y-0 left-0 z-30 flex-col border-r border-line bg-card transition-[width] ${expanded ? 'w-64 p-3' : 'w-20 p-2'}`}>
        <div className={`flex items-center gap-2 mb-4 min-h-14 ${expanded ? 'px-1' : 'justify-center'}`}>
          <ThaliMark size={expanded ? 44 : 40} />
          {expanded && <div className="min-w-0"><div className="font-display text-lg leading-tight truncate">{t('app.name')}</div><div className="text-xs font-bold text-secondary uppercase">{t('app.tagline')}</div></div>}
        </div>
        <nav className="flex flex-col gap-1 overflow-y-auto">{items.map((n) => navLink(n, !expanded))}</nav>
        <div className="mt-auto pt-3 border-t border-line flex flex-col gap-2">
          <button onClick={toggleSidebar} className="btn-ghost w-full" aria-label={expanded ? t('nav.collapse') : t('nav.expand')} title={expanded ? t('nav.collapse') : t('nav.expand')} data-testid="sidebar-toggle">
            <Icon name={expanded ? 'collapse' : 'expand'} className="h-5 w-5" />{expanded && <span className="text-sm">{t('nav.collapse')}</span>}
          </button>
        </div>
      </aside>

      {/* ===== Top bar (all sizes) ===== */}
      <header className="sticky top-0 z-20 bg-bg/95 backdrop-blur border-b border-line">
        <div className="mx-auto max-w-7xl flex items-center gap-2 px-3 sm:px-4 md:px-6 min-h-16">
          <button className="md:hidden btn-ghost !min-w-11 !min-h-11 !px-0" onClick={() => setDrawer(true)} aria-label={t('nav.openMenu')} data-testid="menu-button">
            <Icon name="more" />
          </button>
          <Link to="/" className="md:hidden flex items-center gap-2 min-w-0">
            <ThaliMark size={34} />
            <span className="font-display text-base leading-tight truncate max-[360px]:hidden">{t('app.name')}</span>
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <PrinterStatus />
            <div className="hidden sm:block"><LanguagePicker compact /></div>
            <ProfileMenu onLogout={doLogout} />
          </div>
        </div>
        {!online && <div className="bg-warning text-white px-4 py-2 text-sm font-semibold">{t('net.offline')}</div>}
        {mine.length > 0 && (
          <div className="bg-accent-soft border-t border-accent px-4 py-2 text-sm font-semibold flex flex-wrap items-center justify-between gap-2">
            <span>⏳ {t('net.pending', { n: mine.length })}</span>
            <button className="btn-ghost !min-h-9 !py-1 bg-white" onClick={sync} disabled={!online}>{t('net.syncNow')}</button>
          </div>
        )}
        {others > 0 && <div className="bg-bg border-t border-line px-4 py-2 text-sm text-muted">{t('net.otherWaiter', { n: others })}</div>}
      </header>

      <main className="mx-auto max-w-7xl px-3 py-4 sm:px-4 md:px-6 md:py-6"><Outlet /></main>

      {/* ===== Bottom bar (phones): floating, thumb-friendly, raised "New order" in the centre ===== */}
      {!focusMode && (
        <nav aria-label="Main" className="md:hidden fixed bottom-0 inset-x-0 z-30 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pointer-events-none" data-testid="bottom-nav">
          <div className="pointer-events-auto mx-auto max-w-md relative grid grid-cols-5 items-end rounded-[1.4rem] border border-line bg-card/95 backdrop-blur shadow-[0_8px_30px_rgba(43,29,20,.18)] px-1 pt-1.5 pb-1.5">
            {bottomLeft.map((n) => <BottomTab key={n.to} item={n} label={t(n.to === '/reports' ? 'nav.reportsShort' : n.key)} badge={n.to === '/orders' ? mine.length : 0} />)}
            <NavLink to="/new" aria-label={t('tables.newOrder')} data-testid="bottom-new-order"
              className="flex flex-col items-center justify-end gap-1 -mt-7 text-[max(0.68rem,11px)] font-bold text-primary">
              <span className="grid place-items-center h-14 w-14 rounded-full bg-primary text-white shadow-lg shadow-primary/40 ring-4 ring-bg active:scale-95 transition">
                <Icon name="plus" className="h-7 w-7" strokeWidth={2.5} />
              </span>
              <span className="leading-tight text-center line-clamp-1">{t('tables.newOrder')}</span>
            </NavLink>
            {bottomRight.map((n) => <BottomTab key={n.to} item={n} label={t(n.to === '/reports' ? 'nav.reportsShort' : n.key)} badge={n.to === '/orders' ? mine.length : 0} />)}
            <button onClick={() => setDrawer(true)} className="flex flex-col items-center gap-1 py-1 text-[max(0.68rem,11px)] font-semibold text-muted min-h-14" data-testid="bottom-more">
              <span className="grid place-items-center h-8 w-12 rounded-full"><Icon name="more" /></span>
              <span className="leading-tight line-clamp-1">{t('nav.more')}</span>
            </button>
          </div>
        </nav>
      )}

      {/* ===== Drawer (phones) ===== */}
      {drawer && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={t('nav.openMenu')}>
          <div className="absolute inset-0 bg-ink/40" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-[min(20rem,85vw)] bg-card shadow-2xl flex flex-col p-3 pt-[max(0.75rem,env(safe-area-inset-top))] animate-[slide-in_.18s_ease-out]">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2 min-w-0"><ThaliMark size={40} /><div className="min-w-0"><div className="font-display leading-tight truncate">{t('app.name')}</div><div className="text-xs font-bold text-secondary uppercase">{t('app.tagline')}</div></div></div>
              <button className="btn-ghost !min-w-11 !min-h-11 !px-0" onClick={() => setDrawer(false)} aria-label={t('common.close')}><Icon name="close" /></button>
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-bg p-3 mb-3">
              <Avatar user={user} />
              <div className="min-w-0"><div className="font-bold truncate">{user?.displayName}</div><div className="text-xs text-muted">@{user?.username} · {isAdmin ? t('users.admin') : t('users.waiter')}</div></div>
            </div>
            <nav className="flex flex-col gap-1 overflow-y-auto">{items.map((n) => navLink(n, false))}</nav>
            <div className="mt-auto pt-3 border-t border-line space-y-2">
              <div data-testid="drawer-printer"><PrinterStatus variant="card" /></div>
              <LanguagePicker />
              <button className="btn-ghost w-full text-error" onClick={doLogout}><Icon name="logout" className="h-5 w-5" /> {t('nav.logout')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
