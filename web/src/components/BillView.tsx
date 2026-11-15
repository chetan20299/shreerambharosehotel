import { useState } from 'react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { api } from '../services/api';
import { Loader } from './Brand';
import { Spinner, useUi } from './ui';
import { SendToStation } from './PrintStation';
import { PrinterStatus, printerErrorKey } from './PrinterStatus';
import { printBluetooth, printViaRawBT, usePrinter } from '../printing/printer';
import { PROVISIONAL, receiptLines } from '../printing/receipt';
import { billPdf, shareOrDownload, download } from '../exports';
import type { Order, Settings } from '../types';

export const DEFAULT_SETTINGS: Settings = { hotelName: 'Shree Ram Bharose Hindu Hotel', address: '', phone: '', gstin: '', footer: 'Thank you! Please visit again.', paperWidth: 58 };

/** Receipt preview (exactly what the printer gets) + all print/share options with honest status reporting. */
export function BillView({ order, onPrinted }: { order: Order; onPrinted?: () => void }) {
  const { t } = useI18n();
  const { toast, confirm, errorText } = useUi();
  const printer = usePrinter();
  const { data } = useApi<Settings>('/settings', undefined, { cache: true });
  const [settings, setLocal] = useState<Settings | null>(null);
  const s = settings ?? data ?? DEFAULT_SETTINGS;
  const [busy, setBusy] = useState<string | null>(null);
  const provisional = order.billNo === PROVISIONAL;
  const lines = receiptLines(order, s);
  const fileName = `Shree_Ram_Bharose_Hotel_Bill_${order.billNo}.pdf`;

  const markPrinted = async () => {
    if (provisional) return;
    try { await api(`/orders/${order.id}/printed`, { method: 'POST' }); onPrinted?.(); } catch { /* offline: print still happened */ }
  };
  const bt = async () => {
    setBusy('bt');
    try {
      await printBluetooth(order, s);
      toast(t('bill.sent'), 'success');
      await markPrinted();
    } catch (e) { toast(t(printerErrorKey(e)), 'error'); } finally { setBusy(null); }
  };
  /** For print paths the app can't observe, ask the waiter instead of assuming success. */
  const askPrinted = async () => {
    if (!provisional && (await confirm({ title: t('bill.printed', { n: (order.printCount ?? 0) + 1 }) + ' ?', confirmText: '✓' }))) await markPrinted();
  };
  const android = async () => { window.print(); await askPrinted(); };
  const rawbt = async () => { await printViaRawBT(order, s); setTimeout(() => void askPrinted(), 1500); };
  const pdf = async (share: boolean) => {
    setBusy(share ? 'share' : 'pdf');
    try {
      const blob = await billPdf(order, s);
      if (share) {
        const r = await shareOrDownload(blob, fileName, `${s.hotelName} - Bill ${order.billNo}`);
        if (r !== 'cancelled') toast(r === 'shared' ? t('bill.shared') : t('bill.downloaded'), 'success');
      } else { download(blob, fileName); toast(t('bill.downloaded'), 'success'); }
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(null); }
  };

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] items-start">
      <div className="space-y-3 order-2 md:order-1">
        {provisional && <div className="rounded-xl bg-warning/15 border border-warning px-3 py-2 font-bold">⚠️ {t('bill.provisional')}</div>}
        {order.status === 'cancelled' && <div className="rounded-xl bg-error/10 text-error px-3 py-2 font-bold">{t('bill.cancelled')}: {order.cancelReason}</div>}
        {/* Printer connected to THIS phone → print directly. Otherwise → shared print station queue. */}
        {printer.status === 'connected' || printer.status === 'printing' ? (
          <>
            <PrinterStatus variant="card" />
            <button className="btn-primary w-full" onClick={bt} disabled={!!busy || printer.status === 'printing' || order.status === 'cancelled'} data-testid="print-bt">
              {busy === 'bt' ? <Spinner /> : '🖨️'} {busy === 'bt' ? t('bill.sending') : t('bill.printBt')}</button>
          </>
        ) : (
          <>
            {!provisional && <SendToStation orderId={order.id} printCount={order.printCount ?? 0} disabled={order.status === 'cancelled'} onPrinted={() => onPrinted?.()} />}
            <details className="rounded-xl border border-line bg-white p-3" open={provisional}>
              <summary className="cursor-pointer font-semibold text-sm">🔗 {t('printer.connect')} ({t('printer.notConnected')})</summary>
              <div className="mt-2 space-y-2"><PrinterStatus variant="card" />{printer.status !== 'unsupported' && <p className="text-xs text-muted">{t('printer.connectFirst')}</p>}</div>
            </details>
          </>
        )}
        <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-2">
          <button className="btn-ghost" onClick={android} disabled={!!busy}>📄 {t('bill.printAndroid')}</button>
          <button className="btn-ghost" onClick={rawbt} disabled={!!busy || order.status === 'cancelled'}>📲 {t('bill.printRawbt')}</button>
          <button className="btn-ghost" onClick={() => pdf(false)} disabled={!!busy}>⬇️ {t('bill.pdf')}</button>
          <button className="btn-ghost" onClick={() => pdf(true)} disabled={!!busy}>📤 {t('bill.share')}</button>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-muted">{t('bill.paper')}:</span>
          {([58, 80] as const).map((w) => (
            <button key={w} onClick={() => setLocal({ ...s, paperWidth: w })} className={`chip border ${s.paperWidth === w ? 'bg-ink text-white border-ink' : 'bg-white border-line'}`}>{w}mm</button>
          ))}
        </div>
        <details className="card p-3 text-sm"><summary className="font-semibold cursor-pointer">💡 {t('bill.printerHelp')}</summary><p className="mt-2 text-muted">{t('printer.tips')}</p></details>
        {busy && busy !== 'bt' && <Loader label={t('loader.export')} />}
        {busy === 'bt' && <Loader label={t('loader.printing')} />}
      </div>

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
