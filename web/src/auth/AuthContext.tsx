import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setCsrf, setUnauthorizedHandler } from '../services/api';
import { useI18n } from '../i18n';
import type { Lang, User } from '../types';
import { clearApiCache } from '../hooks';

// Last known session (user + CSRF token) so the app keeps working offline. The session itself is an HttpOnly cookie.
const CACHE = 'srbh.session';
const readCache = (): { user: User; csrf: string } | null => {
  try { return JSON.parse(localStorage.getItem(CACHE) ?? 'null'); } catch { return null; }
};
const writeCache = (v: { user: User; csrf: string } | null) => {
  try { v ? localStorage.setItem(CACHE, JSON.stringify(v)) : localStorage.removeItem(CACHE); } catch { /* ignore */ }
};

interface AuthCtx {
  user: User | null; loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  /** backend=true: local emulator demo (real API); otherwise the in-browser sample backend. */
  demo: (as: 'admin' | 'waiter', backend: boolean) => Promise<void>;
  logout: () => Promise<void>;
  setLanguage: (l: Lang) => Promise<void>;
  updateCsrf: (t: string) => void;
}
const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { lang, setLang } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const accept = useCallback(async (r: { user: User; csrfToken: string }) => {
    setCsrf(r.csrfToken);
    writeCache({ user: r.user, csrf: r.csrfToken });
    // The user's saved UI language follows them to any device.
    if (r.user.language && r.user.language !== lang) await setLang(r.user.language);
    setUser(r.user);
  }, [lang, setLang]);

  // Pending offline orders are NOT cleared: they belong to their waiter and sync when that waiter logs in again.
  const clear = useCallback(() => { setCsrf(''); writeCache(null); clearApiCache(); setUser(null); }, []);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    api<{ user: User; csrfToken: string }>('/auth/me')
      .then(accept)
      .catch((e) => {
        const cached = readCache();
        if (e instanceof ApiError && e.status === 0 && cached) { setCsrf(cached.csrf); setUser(cached.user); } // offline start
        else clear();
      })
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = async (username: string, password: string) => {
    try { localStorage.removeItem('srbh.demo'); localStorage.removeItem('srbh.demoDb'); } catch { /* ignore */ } // real login never goes to the demo
    await accept(await api('/auth/login', { method: 'POST', body: { username, password } }));
  };
  const demo = async (as: 'admin' | 'waiter', backend: boolean) => {
    if (backend) return accept(await api('/demo/login', { method: 'POST', body: { as } }));
    const { startDemo } = await import('../demo/mockServer');
    startDemo(as);
    await accept(await api('/auth/me'));
  };
  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => undefined); clear(); };
  const setLanguage = async (l: Lang) => {
    await setLang(l);
    if (user) {
      const u = { ...user, language: l };
      setUser(u);
      writeCache({ user: u, csrf: readCache()?.csrf ?? '' });
      await api('/auth/preferences', { method: 'PUT', body: { language: l } }).catch(() => undefined);
    }
  };
  const updateCsrf = (t: string) => { setCsrf(t); if (user) writeCache({ user, csrf: t }); };

  return <Ctx.Provider value={{ user, loading, login, demo, logout, setLanguage, updateCsrf }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
