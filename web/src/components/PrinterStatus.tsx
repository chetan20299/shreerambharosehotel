import { useEffect } from 'react';
import { useI18n, type Key } from '../i18n';
import { useUi } from './ui';
import { connectPrinter, disconnectPrinter, PrinterError, restorePrinter, usePrinter } from '../printing/printer';
import { useStation } from '../printing/station';

export const printerErrorKey = (e: unknown): Key =>
  `printer.err.${e instanceof PrinterError ? e.code : 'unknown'}` as Key;

/** Live printer status pill + connect/disconnect. `variant="card"` shows full controls (bill page, settings). */
export function PrinterStatus({ variant = 'pill' }: { variant?: 'pill' | 'card' }) {
  const { t } = useI18n();
  const { toast } = useUi();
  const p = usePrinter();
  const station = useStation();
  useEffect(() => { void restorePrinter(); }, []);

  if (p.status === 'unsupported') {
    return variant === 'card' ? <div className="rounded-xl bg-accent-soft p-3 text-sm font-semibold">{t('bill.btUnsupported')}</div> : null;
  }
  const connect = async () => {
    try { await connectPrinter(); toast(t('printer.connected'), 'success'); }
    catch (e) { if (!(e instanceof PrinterError && e.code === 'cancelled')) toast(t(printerErrorKey(e)), 'error'); }
  };
  const busy = p.status === 'connecting' || p.status === 'printing';
  const dot = p.status === 'connected' ? 'bg-success' : busy ? 'bg-warning animate-pulse' : 'bg-error';
  const label = p.status === 'connected' ? t('printer.connected') : p.status === 'connecting' ? t('printer.connecting')
    : p.status === 'printing' ? t('printer.printing') : t('printer.notConnected');

  if (variant === 'pill') {
    const stationLabel = station.active ? ` · ${t('station.queue', { n: station.pending })}` : '';
    return (
      <button onClick={p.status === 'disconnected' ? connect : undefined} data-testid="printer-pill" aria-label={label + stationLabel}
        className="chip gap-2 bg-white border border-line text-ink min-h-11 max-w-[14rem]" title={(p.name ?? label) + stationLabel}>
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} aria-hidden />
        <span aria-hidden>🖨️</span>
        {station.active && <span className="rounded-full bg-secondary text-white text-[max(0.7rem,11px)] px-1.5 leading-5" aria-hidden>{station.pending}</span>}
        <span className="hidden lg:inline truncate">{label}</span>
      </button>
    );
  }
  return (
    <div className="rounded-xl border border-line bg-white p-3" data-testid="printer-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold">
          <span className={`inline-block h-3 w-3 rounded-full ${dot}`} aria-hidden />
          <span>{label}{p.status === 'connected' && p.name ? ` · ${p.name}` : ''}</span>
        </div>
        {p.status === 'connected'
          ? <div className="flex gap-2">
              <button className="btn-ghost !min-h-10" onClick={connect}>🔄 {t('printer.change')}</button>
              <button className="btn-ghost !min-h-10" onClick={disconnectPrinter}>{t('printer.disconnect')}</button>
            </div>
          : <button className="btn-secondary !min-h-10" onClick={connect} disabled={busy}>🔗 {t('printer.connect')}</button>}
      </div>
      {p.error && p.status !== 'connected' && <div className="mt-2 text-sm text-error font-semibold">{t(`printer.err.${p.error}` as Key)}</div>}
    </div>
  );
}
