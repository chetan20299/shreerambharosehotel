import { useSyncExternalStore } from 'react';
import { api, ApiError } from '../services/api';
import { printBluetooth, getPrinterState, subscribePrinter } from './printer';
import type { Order, Settings } from '../types';
import { POLL } from '../utils/polling';

/**
 * Shared-printer "print station".
 * A Bluetooth printer accepts one connection, so ONE device (kept near the printer) is the station. Other devices
 * queue jobs on the server; the station claims them one by one, prints, and reports the real result.
 *
 * Free-tier pacing: heartbeat every 30 s; queue poll every 5 s ONLY while this device is the station AND the printer
 * is connected. The server answers polls from memory when the queue is empty (no Firestore reads).
 */
const DEVICE_KEY = 'srbh.deviceId';
const STATION_KEY = 'srbh.isStation';
export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch { return 'nostorage-' + Math.random().toString(36).slice(2, 12); }
}

export interface StationInfo { deviceId: string; userName: string; printerName: string | null; lastSeen: string | null; online: boolean }
type State = {
  enabled: boolean;                // user turned "this device is the print station" on
  active: boolean;                 // server accepted us as station
  conflict: StationInfo | null;    // another device holds the station
  pending: number;
  printingBill: string | null;
  lastError: string | null;
  printedCount: number;
};
let state: State = {
  enabled: (() => { try { return localStorage.getItem(STATION_KEY) === '1'; } catch { return false; } })(),
  active: false, conflict: null, pending: 0, printingBill: null, lastError: null, printedCount: 0,
};
const listeners = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
export const useStation = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state);

let hbTimer: number | undefined, pollTimer: number | undefined, busy = false, backoffUntil = 0;

async function heartbeat(takeover = false) {
  try {
    const r = await api<{ station: StationInfo; pending: number }>('/print-station/heartbeat', {
      method: 'POST', silent: true, body: { deviceId: deviceId(), printerName: getPrinterState().name, takeover },
    });
    set({ active: true, conflict: null, pending: r.pending });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const s = await api<{ station: StationInfo }>('/print-station', { silent: true }).catch(() => null);
      set({ active: false, conflict: s?.station ?? null });
    }
    // offline / server errors: keep trying on the next beat
  }
}

async function poll() {
  const p = getPrinterState();
  if (busy || !state.active || p.status !== 'connected' || Date.now() < backoffUntil || !navigator.onLine) return;
  busy = true;
  try {
    const r = await api<{ job: { id: string; billNo: string } | null; order?: Order; settings?: Settings }>('/print-jobs/claim', {
      method: 'POST', silent: true, body: { deviceId: deviceId() },
    });
    if (!r.job || !r.order || !r.settings) return;
    set({ printingBill: r.job.billNo, lastError: null });
    try {
      await printBluetooth(r.order, r.settings);
      await api(`/print-jobs/${r.job.id}/result`, { method: 'POST', silent: true, body: { deviceId: deviceId(), ok: true } });
      set({ printedCount: state.printedCount + 1 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ lastError: msg });
      await api(`/print-jobs/${r.job.id}/result`, { method: 'POST', silent: true, body: { deviceId: deviceId(), ok: false, error: msg.slice(0, 200) } }).catch(() => undefined);
      backoffUntil = Date.now() + 10_000; // give the printer a moment (paper, power) before the automatic retry
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) void heartbeat(); // lost the station role → re-check
  } finally {
    busy = false;
    set({ printingBill: null });
  }
}

function start() {
  stop();
  void heartbeat();
  hbTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void heartbeat(); }, POLL.heartbeat);
  pollTimer = window.setInterval(() => void poll(), POLL.station);
}
function stop() { clearInterval(hbTimer); clearInterval(pollTimer); hbTimer = pollTimer = undefined; }

/** Called by the app shell when a user is logged in. */
export function runStation(loggedIn: boolean) {
  if (loggedIn && state.enabled) { if (!hbTimer) start(); } else stop();
  return stop;
}

export async function setStationEnabled(on: boolean, takeover = false) {
  try { localStorage.setItem(STATION_KEY, on ? '1' : '0'); } catch { /* ignore */ }
  set({ enabled: on, lastError: null });
  if (on) { start(); if (takeover) await heartbeat(true); }
  else {
    stop();
    set({ active: false, conflict: null });
    await api('/print-station/leave', { method: 'POST', silent: true, body: { deviceId: deviceId() } }).catch(() => undefined);
  }
}

// Printer (re)connected → tell the server immediately so other devices see the printer name.
let lastPrinter = '';
subscribePrinter(() => {
  const p = getPrinterState();
  const key = `${p.status === 'connected'}:${p.name}`;
  if (key !== lastPrinter) { lastPrinter = key; if (state.enabled && state.active) void heartbeat(); }
});
