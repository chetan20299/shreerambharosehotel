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
let manualDisconnect = false;

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
  if (manualDisconnect) { manualDisconnect = false; set({ status: 'disconnected' }); return; }
  set({ status: 'disconnected', error: state.status === 'printing' ? 'lost' : state.error });
  void reconnect(); // printer turned off / out of range → try a few times
}

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

async function reconnect(attempts = 3) {
  if (!device) return;
  for (let i = 0; i < attempts && !device.gatt?.connected; i++) {
    set({ status: 'connecting' });
    try { await attach(device); return; } catch { await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  if (!device.gatt?.connected) set({ status: 'disconnected' });
}

/** On app start: silently reconnect to the last printer if Chrome remembers the permission (getDevices). */
export async function restorePrinter() {
  if (!bluetoothSupported() || !navigator.bluetooth.getDevices || device) return;
  try {
    const id = localStorage.getItem(LAST_DEVICE);
    const d = (await navigator.bluetooth.getDevices()).find((x) => x.id === id);
    if (d) { device = d; d.addEventListener('gattserverdisconnected', onDisconnected); await reconnect(2); }
  } catch { /* permission not persisted: user taps Connect */ }
}

export function disconnectPrinter() {
  manualDisconnect = true;
  device?.gatt?.disconnect();
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
