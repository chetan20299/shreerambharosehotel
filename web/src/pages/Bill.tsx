import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { api } from '../services/api';
import { Loader } from '../components/Brand';
import { BillView } from '../components/BillView';
import { Field, Modal, useUi } from '../components/ui';
import { inr } from '../utils/format';
import type { Order } from '../types';

export function BillPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { t } = useI18n();
  const { toast, confirm, errorText } = useUi();
  const nav = useNavigate();
  const { data: order, loading, error, reload } = useApi<Order>(`/orders/${id}`);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');

  if (loading && !order) return <Loader label={t('loader.loading')} />;
  if (error || !order) return <div className="card p-6 text-center"><p className="mb-3">{error ? errorText(error) : t('bill.notFound')}</p><button className="btn-ghost" onClick={() => nav(-1)}>{t('common.back')}</button></div>;

  const free = async () => {
    if (!(await confirm({ title: t('tables.free'), message: t('tables.freeConfirm', { table: order.tableLabel }) }))) return;
    try { await api(`/tables/${order.tableId}/free`, { method: 'POST' }); nav('/tables'); } catch (e) { toast(errorText(e), 'error'); }
  };
  const cancel = async () => {
    try { await api(`/orders/${order.id}/cancel`, { method: 'POST', body: { reason } }); setCancelOpen(false); void reload(); }
    catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <button className="btn-ghost !px-3" onClick={() => nav(-1)} aria-label={t('common.back')}>←</button>
          <div>
            <h1 className="text-2xl font-bold">{t('bill.title')} #{order.billNo}</h1>
            <div className="text-sm text-muted">{t('common.table')} {order.tableLabel} · {order.waiterName} · {inr(order.total)}
              {order.printCount ? ` · ${t('bill.printed', { n: order.printCount })}` : ''}</div>
            {order.conflict && <div className="text-sm font-semibold text-warning">⚠️ {t('orders.conflict')}</div>}
          </div>
        </div>
        <div className="flex gap-2">
          {order.status !== 'cancelled' && <button className="btn-secondary" onClick={free}>✅ {t('tables.free')}</button>}
          {user?.role === 'admin' && order.status !== 'cancelled' && <button className="btn-ghost text-error" onClick={() => setCancelOpen(true)}>{t('bill.cancelOrder')}</button>}
        </div>
      </div>
      <BillView order={order} onPrinted={() => void reload(true)} />
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={t('bill.cancelOrder')}
        footer={<><button className="btn-ghost" onClick={() => setCancelOpen(false)}>{t('common.back')}</button>
          <button className="btn-danger" disabled={reason.trim().length < 3} onClick={cancel}>{t('bill.cancelOrder')}</button></>}>
        <Field label={t('bill.cancelReason')}><input className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}
