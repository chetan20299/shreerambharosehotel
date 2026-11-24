import { useSyncExternalStore } from 'react';
import { buildReceipt, loadLogoBits, toBase64 } from './escpos';
import { receiptLines } from './receipt';
import type { Order, Settings } from '../types';

/**
 * Bluetooth printer service with observable connection state.
 * - Web Bluetooth (BLE) ESC/POS printers: Chrome on Android/desktop, HTTPS only.
 * - Classic-Bluetooth (SPP) printers can't be reached by browsers → RawBT app / Android print / PDF.
 * - "Printed" is reported only after the printer acknowledged every chunk (GATT write-with-response).
 */
const SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
];
const LAST_DEVICE = 'srbh.printerId';

export type PrinterState = 'unsupported' | 'disconnected' | 'connecting' | 'connected' | 'printing';
export type PrinterErrorCode = 'cancelled' | 'btOff' | 'denied' | 'noChannel' | 'lost' | 'timeout' | 'busy' | 'notConnected' | 'inUse' | 'unknown';
export class PrinterError extends Error {
  code: PrinterErrorCode;
  constructor(code: PrinterErrorCode, detail = '') { super(detail || code); this.code = code; }
}

export const bluetoothSupported = () => typeof navigator !== 'undefined' && 'bluetooth' in navigator && window.isSecureContext;

let state: { status: PrinterState; name: string | null; error: PrinterErrorCode | null } = {
  status: bluetoothSupported() ? 'disconnected' : 'unsupported', name: null, error: null,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
export const getPrinterState = () => state;
export const subscribePrinter = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const usePrinter = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state);

let device: BluetoothDevice | undefined;
let characteristic: BluetoothRemoteGATTCharacteristic | undefined;

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new PrinterError('timeout')), ms))]);

function mapError(e: unknown): PrinterError {
  if (e instanceof PrinterError) return e;
  const name = (e as DOMException)?.name, msg = String((e as Error)?.message ?? '');
  if (name === 'NotFoundError' && /cancel/i.test(msg)) return new PrinterError('cancelled');
  if (name === 'NotFoundError' && /adapter|bluetooth/i.test(msg)) return new PrinterError('btOff', msg);
  if (name === 'NotFoundError') return new PrinterError('cancelled');
  if (name === 'NotAllowedError' || name === 'SecurityError') return new PrinterError('denied', msg);
  if (name === 'NetworkError' || /disconnect|GATT/i.test(msg)) return new PrinterError('lost', msg);
  return new PrinterError('unknown', msg);
}

function onDisconnected() {
  characteristic = undefined;
  set({ status: 'disconnected', error: state.status === 'printing' ? 'lost' : state.error });
  scheduleRetry(0); // printer turned off / out of range → keep retrying in the background until it is back
}

// ---- Stable connection: endless background retry with backoff + idle keep-alive ----
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 2000;
function scheduleRetry(delay = retryDelay) {
  clearTimeout(retryTimer);
  if (!device || device.gatt?.connected) return;
  retryTimer = setTimeout(async () => {
    await reconnect(1);
    if (device && !device.gatt?.connected) { retryDelay = Math.min(retryDelay * 2, 30_000); scheduleRetry(); }
  }, delay);
}

// Many BLE printers drop an idle link after ~1 min. A harmless ESC/POS real-time status request
// (DLE EOT 1, prints nothing) every 20 s keeps it open; a failed ping forces a clean reconnect.
const PING = new Uint8Array([0x10, 0x04, 0x01]);
setInterval(async () => {
  if (state.status !== 'connected' || !characteristic || !device?.gatt?.connected) return;
  try {
    if (characteristic.properties.writeWithoutResponse) await characteristic.writeValueWithoutResponse(PING);
    else await withTimeout(characteristic.writeValueWithResponse(PING), 5000);
  } catch { device?.gatt?.disconnect(); } // fires gattserverdisconnected → onDisconnected → retry
}, 20_000);

async function openChannel(d: BluetoothDevice) {
  let server: BluetoothRemoteGATTServer;
  try { server = await withTimeout(d.gatt!.connect(), 12_000); }
  catch (e) {
    const code = e instanceof PrinterError ? e.code : (e as DOMException)?.name;
    // Timeout / NetworkError on connect usually means another phone holds the printer's single connection.
    if (code === 'timeout' || code === 'NetworkError') throw new PrinterError('inUse');
    throw e;
  }
  for (const svc of await server.getPrimaryServices()) {
    for (const ch of await svc.getCharacteristics()) {
      if (ch.properties.write || ch.properties.writeWithoutResponse) return ch;
    }
  }
  d.gatt!.disconnect();
  throw new PrinterError('noChannel');
}

async function attach(d: BluetoothDevice) {
  if (device && device !== d) { device.removeEventListener('gattserverdisconnected', onDisconnected); device.gatt?.disconnect(); }
  device = d;
  d.removeEventListener('gattserverdisconnected', onDisconnected);
  d.addEventListener('gattserverdisconnected', onDisconnected);
  characteristic = await openChannel(d);
  try { localStorage.setItem(LAST_DEVICE, d.id); } catch { /* ignore */ }
  retryDelay = 2000; clearTimeout(retryTimer);
  set({ status: 'connected', name: d.name ?? 'Printer', error: null });
}

/** Opens Chrome's device chooser (must be called from a tap). */
export async function connectPrinter() {
  if (!bluetoothSupported()) throw new PrinterError('unknown', 'unsupported');
  if (state.status === 'connecting' || state.status === 'printing') throw new PrinterError('busy');
  set({ status: 'connecting', error: null });
  try {
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) throw new PrinterError('btOff');
    const d = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    await attach(d);
  } catch (e) {
    const err = mapError(e);
    set({ status: device?.gatt?.connected ? 'connected' : 'disconnected', error: err.code === 'cancelled' ? null : err.code });
    throw err;
  }
}

let reconnecting: Promise<void> | null = null;
/** One reconnect at a time: retry timer, app resume and print all share the same attempt. */
function reconnect(attempts = 3) {
  reconnecting ??= (async () => {
    for (let i = 0; i < attempts && device && !device.gatt?.connected; i++) {
      if (state.status !== 'printing') set({ status: 'connecting' });
      try { await attach(device); return; } catch { if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
    }
    if (device && !device.gatt?.connected) set({ status: 'disconnected' });
  })().finally(() => { reconnecting = null; });
  return reconnecting;
}

/**
 * Auto-reconnect to the last printer without the device picker:
 *  - same app session: reuses the remembered device;
 *  - after an app restart: Chrome's getDevices() returns printers this site was allowed before.
 * Returns true when the printer is connected.
 */
export async function restorePrinter() {
  if (!bluetoothSupported()) return false;
  if (device?.gatt?.connected && characteristic) return true;
  if (device) { await reconnect(2); return !!device.gatt?.connected; }
  if (!navigator.bluetooth.getDevices) return false;
  try {
    const id = localStorage.getItem(LAST_DEVICE);
    const d = (await navigator.bluetooth.getDevices()).find((x) => x.id === id);
    if (d) {
      device = d; d.addEventListener('gattserverdisconnected', onDisconnected);
      // A remembered device must be "seen" (advertising) before Chrome can connect to it again.
      if (d.watchAdvertisements) await withTimeout(d.watchAdvertisements(), 4000).catch(() => undefined);
      await reconnect(2);
      scheduleRetry(); // printer off right now → keep trying in the background
    }
  } catch { /* permission not persisted: user taps Print once to pick the printer */ }
  return !!device?.gatt?.connected;
}

// Reconnect automatically when the app comes back to the foreground.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && localStorage.getItem(LAST_DEVICE) && state.status === 'disconnected') { retryDelay = 2000; void restorePrinter(); }
  });
}

export function disconnectPrinter() {
  clearTimeout(retryTimer);
  device?.removeEventListener('gattserverdisconnected', onDisconnected);
  device?.gatt?.disconnect();
  device = undefined;
  characteristic = undefined;
  try { localStorage.removeItem(LAST_DEVICE); } catch { /* ignore */ }
  set({ status: 'disconnected', name: null, error: null });
}

export async function printBluetooth(order: Order, settings: Settings) {
  if (state.status === 'printing') throw new PrinterError('busy');
  if (!device?.gatt?.connected || !characteristic) {
    if (device) await reconnect(1);
    if (!device?.gatt?.connected || !characteristic) throw new PrinterError('notConnected');
  }
  const ch = characteristic;
  set({ status: 'printing', error: null });
  try {
    const logo = await loadLogoBits('/brand/logo-bill.png', settings.paperWidth === 80 ? 192 : 144).catch(() => undefined);
    const data = buildReceipt(receiptLines(order, settings), logo);
    const chunk = 180;
    for (let i = 0; i < data.length; i += chunk) {
      if (!device?.gatt?.connected) throw new PrinterError('lost');
      const part = data.slice(i, i + chunk);
      if (ch.properties.write) await withTimeout(ch.writeValueWithResponse(part), 8000);
      else { await withTimeout(ch.writeValueWithoutResponse(part), 8000); await new Promise((r) => setTimeout(r, 30)); }
    }
    set({ status: 'connected' });
    return { acknowledged: !!ch.properties.write };
  } catch (e) {
    const err = mapError(e);
    set({ status: device?.gatt?.connected ? 'connected' : 'disconnected', error: err.code });
    throw err;
  }
}

/** RawBT (Android app) accepts raw ESC/POS via intent and supports classic-Bluetooth/USB/Wi-Fi printers. */
export async function printViaRawBT(order: Order, settings: Settings) {
  const logo = await loadLogoBits('/brand/logo-bill.png', settings.paperWidth === 80 ? 192 : 144).catch(() => undefined);
  const data = buildReceipt(receiptLines(order, settings), logo);
  location.href = `intent:base64,${toBase64(data)}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`;
}
