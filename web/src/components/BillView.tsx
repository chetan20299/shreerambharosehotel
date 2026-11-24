import { useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { api } from '../services/api';
import { Modal, Spinner, useUi } from './ui';
import { ActionOverlay, pause } from './ActionOverlay';
import { printerErrorKey } from './PrinterStatus';
import { connectPrinter, printBluetooth, PrinterError, restorePrinter, usePrinter } from '../printing/printer';
import { columns, PROVISIONAL, receiptLines } from '../printing/receipt';
import { markPendingPrinted } from '../services/offlineQueue';
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
  // Result of the last print attempt, shown above the buttons and as a stamp on the bill preview.
  const [result, setResult] = useState<{ kind: 'printed' | 'station' | 'failed'; at: string; text: string } | null>(null);
  const [needConnect, setNeedConnect] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const provisional = order.billNo === PROVISIONAL;
  const lines = receiptLines(order, s);
  const cols = columns(s.paperWidth);
  // Thermal printers print exactly `cols` characters across the printable width (58mm: 48mm, 80mm: 72mm).
  // Size the monospace font so one full line fills the preview's text area exactly → nothing is ever cut.
  const preRef = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (!pre) return;
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `100px ${getComputedStyle(pre).fontFamily}`;
    const charPerPx = ctx.measureText('0'.repeat(cols)).width / 100;
    const fit = () => { if (pre.clientWidth) pre.style.fontSize = `${(pre.clientWidth / charPerPx) * 0.995}px`; };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(pre);
    return () => ro.disconnect();
  }, [cols]);
  const fileName = `Shree_Ram_Bharose_Hotel_Bill_${order.billNo}.pdf`;

  const markPrinted = async () => {
    if (provisional) { markPendingPrinted(order.id); return; } // marked on the server once the order syncs
    try { await api(`/orders/${order.id}/printed`, { method: 'POST' }); onPrinted?.(); } catch { /* offline: print still happened */ }
  };
  /** Prints on this phone's connected printer, with the printing -> done animation and a clear result. */
  const doPrint = async () => {
    setBusy('print');
    try {
      await printBluetooth(order, s);
      await markPrinted();
      setBusy(null); setPrintedMsg(t('anim.printDone')); await pause(1100); setPrintedMsg('');
      setResult({ kind: 'printed', at: nowHHMM(), text: t('bill.resultPrinted', { printer: printer.name ?? t('printer.title') }) });
    } catch (e) {
      if (e instanceof PrinterError && e.code === 'cancelled') return;
      const msg = e instanceof PrinterError ? t(printerErrorKey(e)) : errorText(e);
      setResult({ kind: 'failed', at: nowHHMM(), text: msg });
      toast(msg, 'error');
    } finally { setBusy(null); }
  };
  /**
   * Print button: (1) this phone's printer, reconnecting silently to the remembered one; (2) otherwise the
   * shared print station if one is online; (3) no Bluetooth in this browser -> system print; (4) otherwise
   * show the "Connect your printer" screen first, then print.
   */
  const print = async () => {
    setBusy('check');
    try {
      const own = printer.status === 'connected' || await restorePrinter();
      if (own) { setBusy(null); return void doPrint(); }
      if (!provisional) {
        const st = await api<{ station: { online: boolean } | null }>('/print-station', { silent: true }).catch(() => null);
        if (st?.station?.online) {
          setBusy('print');
          await api('/print-jobs', { method: 'POST', body: { orderId: order.id, reprint: (order.printCount ?? 0) > 0 } });
          setBusy(null); setPrintedMsg(t('anim.sentToStation')); await pause(1100); setPrintedMsg('');
          setResult({ kind: 'station', at: nowHHMM(), text: t('bill.resultStation') });
          return;
        }
      }
      if (printer.status === 'unsupported') {
        setBusy(null);
        window.print();
        if (!provisional && (await confirm({ title: t('bill.printed', { n: (order.printCount ?? 0) + 1 }) + ' ?', confirmText: '✓' }))) {
          await markPrinted();
          setResult({ kind: 'printed', at: nowHHMM(), text: t('bill.resultSystem') });
        }
        return;
      }
      setConnectError(''); setNeedConnect(true); // not connected -> explain first, connect, then print
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy((x) => (x === 'check' ? null : x)); }
  };
  /** Tap on "Connect & print" in the dialog (a real tap is required by the browser to open the printer list). */
  const connectThenPrint = async () => {
    setConnecting(true); setConnectError('');
    try {
      await connectPrinter();
      setNeedConnect(false);
      toast(t('printer.connected'), 'success');
      await doPrint();
    } catch (e) {
      if (!(e instanceof PrinterError && e.code === 'cancelled')) setConnectError(e instanceof PrinterError ? t(printerErrorKey(e)) : errorText(e));
    } finally { setConnecting(false); }
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
        {result && (
          <div role="status" data-testid="print-result" className={`rounded-xl border px-3 py-2 flex items-start gap-2 anim-fade ${
            result.kind === 'failed' ? 'bg-error/10 border-error/40 text-error' : 'bg-success/10 border-success/40 text-success'}`}>
            <span aria-hidden className="text-xl leading-none">{result.kind === 'failed' ? '⚠️' : result.kind === 'station' ? '📨' : '✅'}</span>
            <div className="min-w-0 font-semibold">{result.text}<div className="text-xs font-normal opacity-80">{result.at}</div></div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button className="btn-primary !min-h-14 text-lg" onClick={print} disabled={!!busy || order.status === 'cancelled'} data-testid="print-bt">
            {busy === 'print' || busy === 'check' ? <Spinner /> : '🖨️'} {result?.kind === 'printed' ? t('bill.printAgain') : t('bill.print')}</button>
          <button className="btn-secondary !min-h-14 text-lg" onClick={share} disabled={!!busy} data-testid="share-bill">
            {busy === 'share' ? <Spinner /> : '📤'} {t('bill.share')}</button>
        </div>
      </div>

      <Modal open={needConnect} onClose={() => !connecting && setNeedConnect(false)} title={t('printer.connectTitle')}
        footer={<><button className="btn-ghost" disabled={connecting} onClick={() => setNeedConnect(false)}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={connecting} onClick={connectThenPrint} data-testid="connect-then-print">
            {connecting ? <Spinner /> : '🔗'} {connecting ? t('printer.connecting') : t('printer.connectAndPrint')}</button></>}>
        <div className="flex flex-col items-center text-center gap-3" data-testid="connect-printer-dialog">
          <svg viewBox="0 0 160 110" className="h-28 w-40" aria-hidden>
            <rect x="22" y="40" width="76" height="40" rx="10" fill="#B4441B" />
            <rect x="34" y="22" width="52" height="22" rx="4" fill="#fff" stroke="#EADFCB" />
            <rect x="34" y="72" width="52" height="26" rx="3" fill="#fff" stroke="#EADFCB" className="anim-paper-peek" />
            <circle cx="86" cy="52" r="4" fill="#F6E3D8" className="anim-blink" />
            <path className="bt-pulse" d="M120 42 l14 12 -14 12 v-30 l14 12 -14 12" stroke="#1D4E89" strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <g fill="none" stroke="#1D4E89" strokeWidth="3" strokeLinecap="round">
              <path className="bt-wave" d="M108 52 q6 8 0 16" /><path className="bt-wave bt-w2" d="M102 46 q12 14 0 28" />
            </g>
          </svg>
          <p className="font-semibold">{t('printer.connectFirst')}</p>
          <ol className="text-left text-sm text-muted space-y-1 list-decimal pl-5 self-stretch">
            <li>{t('printer.step1')}</li><li>{t('printer.step2')}</li><li>{t('printer.step3')}</li>
          </ol>
          {connectError && <p role="alert" className="w-full rounded-xl bg-error/10 text-error font-semibold px-3 py-2 text-sm">{connectError}</p>}
        </div>
      </Modal>
      <ActionOverlay kind={printedMsg ? 'done' : busy === 'print' ? 'printing' : null} label={printedMsg || t('anim.printing')} />
      {/* Receipt preview — this element is also what Android print outputs. */}
      <div id="print-area" className={`relative order-1 md:order-2 mx-auto bg-white shadow-md border py-4 ${result?.kind === 'printed' ? 'border-success ring-2 ring-success/40' : 'border-line'}`} style={{ width: s.paperWidth === 80 ? '80mm' : '58mm', maxWidth: '100%', paddingInline: s.paperWidth === 80 ? '4mm' : '5mm' }} lang="en">
        {(result?.kind === 'printed' || (order.printCount ?? 0) > 0) && (
          <span className="print-stamp absolute top-3 right-2 rounded-md border-2 border-success text-success font-black text-xs tracking-widest px-2 py-0.5 bg-white/90" data-testid="printed-stamp">
            {t('bill.stampPrinted')}</span>
        )}
        {/* Same share of the printable width as the printed logo (144 of 384 dots / 192 of 576 dots). */}
        <img src="/brand/logo-bill.png" alt="" className="mx-auto mb-2 aspect-square" style={{ width: s.paperWidth === 80 ? '33.3%' : '37.5%' }} />
        <pre ref={preRef} className="font-mono whitespace-pre text-[10px] leading-[1.45] overflow-hidden text-black">
          {lines.map((l, i) => <div key={i} className={l.bold ? 'font-bold' : ''} style={{ textAlign: l.align === 'center' ? 'center' : 'left' }}>{l.text || ' '}</div>)}
        </pre>
      </div>
    </div>
  );
}
