import { useState } from 'react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { api } from '../services/api';
import { Spinner, useUi } from './ui';
import { ActionOverlay, pause } from './ActionOverlay';
import { printerErrorKey } from './PrinterStatus';
import { connectPrinter, printBluetooth, PrinterError, restorePrinter, usePrinter } from '../printing/printer';
import { PROVISIONAL, receiptLines } from '../printing/receipt';
import { billPdf, shareOrDownload } from '../exports';
import type { Order, Settings } from '../types';

export const DEFAULT_SETTINGS: Settings = { hotelName: 'Shree Ram Bharose Hindu Hotel', address: '', phone: '', gstin: '', footer: 'Thank you! Please visit again.', paperWidth: 58 };

/** Receipt preview (exactly what the printer gets) + Print and Share. */
export function BillView({ order, onPrinted }: { order: Order; onPrinted?: () => void }) {
  const { t } = useI18n();
  const { toast, confirm, errorText } = useUi();
  const printer = usePrinter();
  const { data } = useApi<Settings>('/settings', undefined, { cache: true });
  const s = data ?? DEFAULT_SETTINGS;
  const [busy, setBusy] = useState<string | null>(null);
  const [printedMsg, setPrintedMsg] = useState('');
  const provisional = order.billNo === PROVISIONAL;
  const lines = receiptLines(order, s);
  const fileName = `Shree_Ram_Bharose_Hotel_Bill_${order.billNo}.pdf`;

  const markPrinted = async () => {
    if (provisional) return;
    try { await api(`/orders/${order.id}/printed`, { method: 'POST' }); onPrinted?.(); } catch { /* offline: print still happened */ }
  };
  /** One Print button: this phone's Bluetooth printer (connects on first tap) → else the shared print station → else system print. */
  const print = async () => {
    setBusy('print');
    try {
      // 1) this phone's own printer: reconnect silently to the remembered one (picker only the very first time)
      const own = printer.status === 'connected' || await restorePrinter();
      // 2) no own printer → shared print station, if one is online
      if (!own && !provisional) {
        const st = await api<{ station: { online: boolean } | null }>('/print-station', { silent: true }).catch(() => null);
        if (st?.station?.online) {
          await api('/print-jobs', { method: 'POST', body: { orderId: order.id, reprint: (order.printCount ?? 0) > 0 } });
          setBusy(null); setPrintedMsg(t('anim.sentToStation')); await pause(1100); setPrintedMsg('');
          return;
        }
      }
      // 3) no Web Bluetooth (iPhone, Firefox…) → system print dialog
      if (printer.status === 'unsupported') {
        window.print();
        if (!provisional && (await confirm({ title: t('bill.printed', { n: (order.printCount ?? 0) + 1 }) + ' ?', confirmText: '✓' }))) await markPrinted();
        return;
      }
      if (!own) await connectPrinter(); // first time only: pick the printer
      await printBluetooth(order, s);
      await markPrinted();
      setBusy(null); setPrintedMsg(t('anim.printDone')); await pause(1100); setPrintedMsg('');
    } catch (e) {
      if (!(e instanceof PrinterError && e.code === 'cancelled')) toast(e instanceof PrinterError ? t(printerErrorKey(e)) : errorText(e), 'error');
    } finally { setBusy(null); }
  };
  const share = async () => {
    setBusy('share');
    try {
      const r = await shareOrDownload(await billPdf(order, s), fileName, `${s.hotelName} - Bill ${order.billNo}`);
      if (r !== 'cancelled') toast(r === 'shared' ? t('bill.shared') : t('bill.downloaded'), 'success');
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(null); }
  };

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] items-start">
      <div className="space-y-3 order-2 md:order-1">
        {provisional && <div className="rounded-xl bg-warning/15 border border-warning px-3 py-2 font-bold">⚠️ {t('bill.provisional')}</div>}
        {order.status === 'cancelled' && <div className="rounded-xl bg-error/10 text-error px-3 py-2 font-bold">{t('bill.cancelled')}: {order.cancelReason}</div>}
        <div className="grid grid-cols-2 gap-2">
          <button className="btn-primary !min-h-14 text-lg" onClick={print} disabled={!!busy || order.status === 'cancelled'} data-testid="print-bt">
            {busy === 'print' ? <Spinner /> : '🖨️'} {t('bill.print')}</button>
          <button className="btn-secondary !min-h-14 text-lg" onClick={share} disabled={!!busy} data-testid="share-bill">
            {busy === 'share' ? <Spinner /> : '📤'} {t('bill.share')}</button>
        </div>
      </div>

      <ActionOverlay kind={printedMsg ? 'done' : busy === 'print' ? 'printing' : null} label={printedMsg || t('anim.printing')} />
      {/* Receipt preview — this element is also what Android print outputs. */}
      <div id="print-area" className="order-1 md:order-2 mx-auto bg-white shadow-md border border-line px-3 py-4" style={{ width: s.paperWidth === 80 ? '80mm' : '58mm', maxWidth: '100%' }} lang="en">
        <img src="/brand/logo-bill.png" alt="" className="mx-auto mb-2 w-16 h-16" />
        <pre className="font-mono whitespace-pre text-[10px] leading-[1.35] overflow-hidden text-black">
          {lines.map((l, i) => <div key={i} className={l.bold ? 'font-bold' : ''} style={{ textAlign: l.align === 'center' ? 'center' : 'left' }}>{l.text || ' '}</div>)}
        </pre>
      </div>
    </div>
  );
}
