import { useNavigate, useParams } from 'react-router';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { Loader } from '../components/Brand';
import { BillView } from '../components/BillView';
import { useUi } from '../components/ui';
import { inr } from '../utils/format';
import type { Order } from '../types';

export function BillPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const { errorText } = useUi();
  const nav = useNavigate();
  const { data: order, loading, error, reload } = useApi<Order>(`/orders/${id}`);

  if (loading && !order) return <Loader label={t('loader.loading')} />;
  if (error || !order) return <div className="card p-6 text-center"><p className="mb-3">{error ? errorText(error) : t('bill.notFound')}</p><button className="btn-ghost" onClick={() => nav(-1)}>{t('common.back')}</button></div>;

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-bold">{t('bill.title')} #{order.billNo}</h1>
        <div className="text-sm text-muted">{order.waiterName} · {inr(order.total)}{order.printCount ? ` · ${t('bill.printed', { n: order.printCount })}` : ''}</div>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-4">
        <button className="btn-ghost bg-white" disabled={order.status === 'cancelled'} data-testid="bill-add-item"
          onClick={() => nav(`/new?add=${order.id}&bill=${encodeURIComponent(order.billNo)}`)}>＋ {t('bill.addItem')}</button>
        <button className="btn-ghost bg-white" onClick={() => nav('/new')} data-testid="bill-cancel-print">✕ {t('bill.cancelPrint')}</button>
      </div>
      <BillView order={order} onPrinted={() => void reload(true)} />
    </div>
  );
}
