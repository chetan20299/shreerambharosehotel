import type { Line } from './receipt';

/** Minimal ESC/POS encoder (init, align, bold, double size, raster image, feed, cut). */
export class EscPos {
  private bytes: number[] = [];
  private push(...b: number[]) { this.bytes.push(...b); return this; }
  init() { return this.push(0x1b, 0x40); }
  align(a: 'left' | 'center' | 'right') { return this.push(0x1b, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2); }
  bold(on: boolean) { return this.push(0x1b, 0x45, on ? 1 : 0); }
  size(double: boolean) { return this.push(0x1d, 0x21, double ? 0x11 : 0x00); }
  text(s: string) { for (const ch of s) this.bytes.push(ch.charCodeAt(0) & 0x7f); return this; }
  line(s = '') { return this.text(s).push(0x0a); }
  feed(n: number) { return this.push(0x1b, 0x64, n); }
  cut() { return this.push(0x1d, 0x56, 0x42, 0x00); }
  /** GS v 0 raster bit image. `bits` is row-major, 1 = black, width multiple of 8. */
  raster(bits: Uint8Array, width: number, height: number) {
    const bw = width / 8;
    this.push(0x1d, 0x76, 0x30, 0x00, bw & 0xff, bw >> 8, height & 0xff, height >> 8);
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let k = 0; k < 8; k++) b = (b << 1) | (bits[i + k] ? 1 : 0);
      this.bytes.push(b);
    }
    return this;
  }
  encode() { return new Uint8Array(this.bytes); }
}

export function buildReceipt(lines: Line[], logo?: { bits: Uint8Array; width: number; height: number }) {
  const p = new EscPos().init();
  if (logo) p.align('center').raster(logo.bits, logo.width, logo.height).line();
  for (const l of lines) {
    p.align(l.align === 'center' ? 'center' : 'left').bold(!!l.bold).size(!!l.big).line(l.text);
  }
  return p.bold(false).size(false).align('left').feed(4).cut().encode();
}

/** Renders the monochrome bill logo to a 1-bit bitmap for the printer. */
export async function loadLogoBits(src = '/brand/logo-bill.png', width = 160) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const height = Math.round((img.height / img.width) * width);
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const px = ctx.getImageData(0, 0, width, height).data;
  const bits = new Uint8Array(width * height);
  for (let i = 0; i < bits.length; i++) bits[i] = px[i * 4]! * 0.3 + px[i * 4 + 1]! * 0.59 + px[i * 4 + 2]! * 0.11 < 128 ? 1 : 0;
  return { bits, width, height };
}

export const toBase64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
