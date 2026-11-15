import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { I18nProvider, useI18n } from './i18n';
import { UiProvider } from './components/ui';
import { Loader } from './components/Brand';
import { AppLayout } from './layouts/AppLayout';
import { LoginPage } from './pages/Login';
import { ResetPasswordPage } from './pages/ResetPassword';
import { NewOrderPage } from './pages/NewOrder';
import { OrderEntryPage } from './pages/OrderEntry';
import { BillPage } from './pages/Bill';
import { OrdersPage } from './pages/Orders';
import { SettingsPage } from './pages/Settings';

// Admin-only / heavy pages are code-split so waiter phones load less.
const DashboardPage = lazy(() => import('./pages/Dashboard'));
const ReportsPage = lazy(() => import('./pages/Reports'));
const MenuPage = lazy(() => import('./pages/Menu'));
const UsersPage = lazy(() => import('./pages/Users'));
const HistoryPage = lazy(() => import('./pages/History'));

function Guard({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth();
  const { t } = useI18n();
  if (loading) return <Loader full label={t('loader.startup')} />;
  if (!user) return <Navigate to="/login" replace />;
  if (admin && user.role !== 'admin') return <Navigate to="/new" replace />;
  return <>{children}</>;
}

function Home() {
  const { user } = useAuth();
  return <Navigate to={user?.role === 'admin' ? '/dashboard' : '/new'} replace />;
}

function SwitchingOverlay() {
  const { switching, t } = useI18n();
  return switching ? <Loader full label={t('lang.switching')} /> : null;
}

export default function App() {
  const { t } = useI18n();
  return (
    <BrowserRouter>
      <SwitchingOverlay />
      <Suspense fallback={<Loader label={t('loader.loading')} />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route element={<Guard><AppLayout /></Guard>}>
            <Route index element={<Home />} />
            <Route path="new" element={<NewOrderPage />} />
            <Route path="order/:hall" element={<OrderEntryPage />} />
            <Route path="tables" element={<Navigate to="/new" replace />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="orders/:id" element={<BillPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="dashboard" element={<Guard admin><DashboardPage /></Guard>} />
            <Route path="menu" element={<Guard admin><MenuPage /></Guard>} />
            <Route path="users" element={<Guard admin><UsersPage /></Guard>} />
            <Route path="history" element={<Guard admin><HistoryPage /></Guard>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export function Root() {
  return (
    <I18nProvider>
      <UiProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </UiProvider>
    </I18nProvider>
  );
}
