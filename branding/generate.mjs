// Generates every logo variation (SVG) + PWA/launcher PNGs.
// Run from web/: `node ../branding/generate.mjs` (uses Playwright's Chromium to rasterize).
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'web/public/brand');
mkdirSync(out, { recursive: true });

export const C = {
  primary: '#B4441B', primaryDark: '#8A3214', secondary: '#1F5F4A', accent: '#E2A62B',
  bg: '#FBF6EE', card: '#FFFFFF', text: '#2B1D14', muted: '#6B5A4E',
};
const FONTS = `<style>@import url('https://fonts.googleapis.com/css2?family=Rozha+One&amp;family=Hind+Vadodara:wght@500;700&amp;display=swap');</style>`;

/** Top-down Gujarati thali: brass rim with dotted border, three katoris (dal, shaak, kadhi), rotli and rice. 512 box. */
const thali = (mono = false) => {
  const k = (cx, cy, fill) => `<circle cx="${cx}" cy="${cy}" r="38" fill="${mono ? '#fff' : C.accent}" ${mono ? 'stroke="#000" stroke-width="8"' : ''}/>
    <circle cx="${cx}" cy="${cy}" r="27" fill="${mono ? '#000' : fill}"/>`;
  return `
  <circle cx="256" cy="256" r="184" fill="${mono ? '#fff' : C.accent}" ${mono ? 'stroke="#000" stroke-width="14"' : ''}/>
  <circle cx="256" cy="256" r="166" fill="none" stroke="${mono ? '#000' : C.primaryDark}" stroke-width="7" stroke-linecap="round" stroke-dasharray="0.1 21.6"/>
  <circle cx="256" cy="256" r="150" fill="${mono ? '#fff' : C.bg}" ${mono ? 'stroke="#000" stroke-width="6"' : ''}/>
  ${k(172, 208, '#D97706')}${k(256, 160, C.secondary)}${k(340, 208, '#F3D27A')}
  <circle cx="200" cy="318" r="50" fill="${mono ? '#fff' : '#E9C994'}" ${mono ? 'stroke="#000" stroke-width="8"' : 'stroke="#D4AA6A" stroke-width="3"'}/>
  <circle cx="186" cy="305" r="6" fill="${mono ? '#000' : '#B98545'}"/><circle cx="214" cy="330" r="5" fill="${mono ? '#000' : '#B98545'}"/><circle cx="208" cy="300" r="4" fill="${mono ? '#000' : '#B98545'}"/>
  <path d="M262 352 q50 -82 100 0 z" fill="#fff" stroke="${mono ? '#000' : '#E6D8BE'}" stroke-width="${mono ? 8 : 4}" stroke-linejoin="round"/>
  <path d="M256 236 c-14 14 -14 30 0 38 c14 -8 14 -24 0 -38z" fill="${mono ? '#000' : C.primary}"/>`;
};

const svg = (w, h, body, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${extra}${body}</svg>`;
const icon = (x, y, size, mono) => `<g transform="translate(${x} ${y}) scale(${size / 512})">${thali(mono)}</g>`;

const files = {
  // Icon-only (transparent)
  'logo-icon.svg': svg(512, 512, thali()),
  // Android launcher / maskable: full-bleed saffron, thali inside the 80% safe zone
  'logo-launcher.svg': svg(512, 512, `<rect width="512" height="512" fill="${C.primary}"/>${icon(76, 76, 360)}`),
  // Rounded app icon (favicon, splash)
  'logo-app.svg': svg(512, 512, `<rect width="512" height="512" rx="112" fill="${C.primary}"/>${icon(56, 56, 400)}`),
  // Circular badge with text on a ring
  'logo-circular.svg': svg(600, 600, `
    <defs><path id="top" d="M76 300 A224 224 0 0 1 524 300"/><path id="bottom" d="M44 300 A256 256 0 0 0 556 300"/></defs>
    <circle cx="300" cy="300" r="296" fill="${C.primary}"/><circle cx="300" cy="300" r="282" fill="none" stroke="${C.accent}" stroke-width="4"/>
    <circle cx="300" cy="300" r="178" fill="none" stroke="${C.accent}" stroke-width="3"/>
    <text font-family="Rozha One, Georgia, serif" font-size="42" fill="#fff" letter-spacing="3"><textPath href="#top" startOffset="50%" text-anchor="middle">SHREE RAM BHAROSE</textPath></text>
    <text font-family="Rozha One, Georgia, serif" font-size="34" fill="${C.accent}" letter-spacing="6"><textPath href="#bottom" startOffset="50%" text-anchor="middle">★ HINDU HOTEL ★</textPath></text>
    ${icon(95, 95, 410)}`, FONTS),
  // Primary stacked logo
  'logo-primary.svg': svg(640, 720, `
    ${icon(160, 20, 320)}
    <text x="320" y="420" text-anchor="middle" font-family="Hind Vadodara, sans-serif" font-weight="700" font-size="40" fill="${C.primary}">શ્રી રામ ભરોસે</text>
    <text x="320" y="505" text-anchor="middle" font-family="Rozha One, Georgia, serif" font-size="60" fill="${C.text}">Shree Ram Bharose</text>
    <line x1="70" y1="560" x2="140" y2="560" stroke="${C.accent}" stroke-width="4"/><line x1="500" y1="560" x2="570" y2="560" stroke="${C.accent}" stroke-width="4"/>
    <text x="320" y="572" text-anchor="middle" font-family="Hind Vadodara, sans-serif" font-weight="700" font-size="34" letter-spacing="8" fill="${C.secondary}">HINDU HOTEL</text>
    <text x="320" y="640" text-anchor="middle" font-family="Hind Vadodara, sans-serif" font-weight="500" font-size="24" fill="${C.muted}">Pure Vegetarian · Gujarati Thali</text>`, FONTS),
  // Horizontal lockup
  'logo-horizontal.svg': svg(1100, 280, `
    ${icon(10, 10, 260)}
    <text x="300" y="118" font-family="Rozha One, Georgia, serif" font-size="84" fill="${C.text}">Shree Ram Bharose</text>
    <text x="304" y="186" font-family="Hind Vadodara, sans-serif" font-weight="700" font-size="40" letter-spacing="10" fill="${C.secondary}">HINDU HOTEL</text>
    <text x="304" y="240" font-family="Hind Vadodara, sans-serif" font-weight="700" font-size="34" fill="${C.primary}">શ્રી રામ ભરોસે હિન્દુ હોટલ</text>`, FONTS),
  // Compact (app header)
  'logo-compact.svg': svg(520, 128, `
    ${icon(0, 0, 128)}
    <text x="144" y="62" font-family="Rozha One, Georgia, serif" font-size="46" fill="${C.text}">Shree Ram Bharose</text>
    <text x="146" y="104" font-family="Hind Vadodara, sans-serif" font-weight="700" font-size="24" letter-spacing="6" fill="${C.secondary}">HINDU HOTEL</text>`, FONTS),
  // Splash
  'logo-splash.svg': svg(512, 640, `${icon(56, 0, 400)}
    <text x="256" y="480" text-anchor="middle" font-family="Rozha One, Georgia, serif" font-size="50" fill="${C.text}">Shree Ram Bharose</text>
    <text x="256" y="530" text-anchor="middle" font-family="Hind Vadodara, sans-serif" font-weight="700" font-size="26" letter-spacing="8" fill="${C.secondary}">HINDU HOTEL</text>`, FONTS),
  // Monochrome for thermal printer / PDF (pure black & white, no text — text is printed by the printer font)
  'logo-bill.svg': svg(512, 512, `<rect width="512" height="512" fill="#fff"/>${thali(true)}`),
};
for (const [name, content] of Object.entries(files)) writeFileSync(resolve(out, name), content);
console.log('SVGs written:', Object.keys(files).join(', '));

// ---- PNG rasterization ----
const { createRequire } = await import('node:module');
const { chromium } = createRequire(resolve(root, 'web/package.json'))('@playwright/test');
const browser = await chromium.launch();
const page = await browser.newPage();
const png = async (src, size, file, w = size, h = size) => {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;background:transparent">${files[src].replace(/width="\d+" height="\d+"/, `width="${w}" height="${h}"`)}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
};
const pub = resolve(root, 'web/public');
await png('logo-app.svg', 192, resolve(pub, 'pwa-192x192.png'));
await png('logo-app.svg', 512, resolve(pub, 'pwa-512x512.png'));
await png('logo-launcher.svg', 512, resolve(pub, 'maskable-512x512.png'));
await png('logo-launcher.svg', 180, resolve(pub, 'apple-touch-icon.png'));
await png('logo-app.svg', 64, resolve(pub, 'favicon-64.png'));
await png('logo-primary.svg', 0, resolve(out, 'logo-primary.png'), 640, 720);
await png('logo-horizontal.svg', 0, resolve(out, 'logo-horizontal.png'), 1100, 280);
await png('logo-circular.svg', 600, resolve(out, 'logo-circular.png'));
await png('logo-bill.svg', 256, resolve(out, 'logo-bill.png'));
await browser.close();
writeFileSync(resolve(pub, 'favicon.svg'), files['logo-app.svg']);
console.log('PNGs written');
