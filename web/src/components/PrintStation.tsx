import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { api, ApiError } from '../services/api';
import { Spinner, useUi } from './ui';
import { setStationEnabled, useStation, type StationInfo } from '../printing/station';
import { usePrinter } from '../printing/printer';

type Job = { id: string; billNo: string; status: 'queued' | 'printing' | 'done' | 'failed'; error: string | null; attempts: number };

/** Settings card: make this device the print station, see who holds it, take over, live queue count. */
export function PrintStationCard() {
  const { t } = useI18n();
  const { toast, errorText } = useUi();
  const st = useStation();
  const printer = usePrinter();
  const remote = useApi<{ station: StationInfo | null; pending: number }>('/print-station', undefined, { poll: 30_000 });
  const s = remote.data?.station;
  const toggle = async (on: boolean, takeover = false) => {
    try { await setStationEnabled(on, takeover); void remote.reload(true); } catch (e) { toast(errorText(e), 'error'); }
  };
  return (
    <div className="space-y-3" data-testid="station-card">
      <p className="text-sm text-muted">{t('station.help')}</p>
      <label className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white p-3 min-h-14">
        <span className="font-semibold">{t('station.useThis')}</span>
        <button role="switch" aria-checked={st.enabled} onClick={() => toggle(!st.enabled)} data-testid="station-toggle"
          className={`relative h-8 w-14 shrink-0 rounded-full transition ${st.enabled ? 'bg-success' : 'bg-line'}`}>
          <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${st.enabled ? 'left-7' : 'left-1'}`} />
        </button>
      </label>
      {st.enabled && st.active && (
        <div className="rounded-xl bg-success/10 p-3 text-sm font-semibold text-success">
          ✓ {t('station.thisDevice')} · {t('station.queue', { n: st.pending })}
          {st.printingBill && <div className="text-ink mt-1"><Spinner className="mr-2" />{t('station.printingNow', { bill: st.printingBill })}</div>}
          {printer.status !== 'connected' && <div className="text-warning mt-1">⚠️ {t('station.needPrinter')}</div>}
          {st.lastError && <div className="text-error mt-1">{t('station.failed', { error: st.lastError })}</div>}
        </div>
      )}
      {st.enabled && !st.active && st.conflict && (
        <div className="rounded-xl bg-warning/10 p-3 text-sm">
          <div className="font-semibold">{t('station.other', { name: st.conflict.userName })}</div>
          <button className="btn-secondary mt-2 w-full sm:w-auto" onClick={() => toggle(true, true)}>{t('station.takeover')}</button>
        </div>
      )}
      {!st.enabled && (
        <div className="text-sm">
          {s ? <span>{t('station.other', { name: s.userName })} · <b className={s.online ? 'text-success' : 'text-error'}>{s.online ? t('station.online') : t('station.offline')}</b>{s.printerName ? ` · ${t('station.printer', { name: s.printerName })}` : ''}</span>
            : <span className="text-muted">{t('station.none')}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Bill page: send the bill to the shared print station and follow the job live until the printer confirms.
 * Polls every 2 s only while a job is in flight.
 */
export function SendToStation({ orderId, printCount, disabled, onPrinted }: { orderId: string; printCount: number; disabled?: boolean; onPrinted: () => void }) {
  const { t } = useI18n();
  const { toast, errorText } = useUi();
  const remote = useApi<{ station: StationInfo | null; pending: number }>('/print-station', undefined, { poll: 30_000 });
  const [job, setJob] = useState<Job | null>(null);
  const [sending, setSending] = useState(false);
  const done = useRef(false);
  const station = remote.data?.station;

  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed') return;
    const id = setInterval(async () => {
      try {
        const r = await api<{ job: Job }>(`/print-jobs/${job.id}`, { silent: true });
        setJob(r.job);
        if (r.job.status === 'done' && !done.current) { done.current = true; toast(t('station.done'), 'success'); onPrinted(); }
      } catch { /* transient: keep polling */ }
    }, 2000);
    return () => clearInterval(id);
  }, [job?.id, job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    setSending(true); done.current = false;
    try {
      const r = await api<{ job: Job; station: StationInfo | null }>('/print-jobs', { method: 'POST', body: { orderId, reprint: printCount > 0 } });
      setJob(r.job);
      if (!r.station?.online) toast(t('station.none'), 'info');
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? e.message : errorText(e), 'error');
    } finally { setSending(false); }
  };

  const busy = job && (job.status === 'queued' || job.status === 'printing');
  return (
    <div className="rounded-xl border border-line bg-white p-3 space-y-2" data-testid="send-station">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-semibold">🖨️ {t('station.title')}</span>
        {remote.data && (station
          ? <span className={`chip text-xs ${station.online ? 'bg-success/15 text-success' : 'bg-error/10 text-error'}`}>{station.userName} · {station.online ? t('station.online') : t('station.offline')}</span>
          : <span className="chip text-xs bg-line text-muted">{t('station.none')}</span>)}
      </div>
      {station && !station.online && !busy && <p className="text-xs text-muted">{t('station.noneHelp')}</p>}
      {!station && <p className="text-xs text-muted">{t('station.noneHelp')}</p>}
      <button className={printCount > 0 ? 'btn-ghost w-full' : 'btn-secondary w-full'} onClick={send} disabled={disabled || sending || !!busy} data-testid="send-to-station">
        {sending || busy ? <Spinner /> : '📨'} {printCount > 0 ? t('station.reprint') : t('station.send')}
      </button>
      {job && (
        <div role="status" className={`text-sm font-semibold ${job.status === 'failed' ? 'text-error' : job.status === 'done' ? 'text-success' : 'text-ink'}`}>
          {job.status === 'queued' && <>⏳ {t('station.queued')}</>}
          {job.status === 'printing' && <><Spinner className="mr-1" /> {t('station.printing')}</>}
          {job.status === 'done' && t('station.done')}
          {job.status === 'failed' && <>{t('station.failed', { error: job.error ?? '' })} <button className="underline ml-1" onClick={send}>{t('station.retry')}</button></>}
        </div>
      )}
      {printCount > 0 && !job && <p className="text-xs text-muted">{t('station.alreadyPrinted', { n: printCount })}</p>}
    </div>
  );
}
