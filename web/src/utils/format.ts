// Amounts always use Latin digits + Indian grouping so bills/reports are identical in every UI language.
const inrFmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const inr = (n: number) => `₹${inrFmt.format(n)}`;
export const money2 = (n: number) => n.toFixed(2);

const istFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
export const istToday = () => istFmt.format(new Date());
export function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export type Preset = 'today' | 'yesterday' | 'last7' | 'last15' | 'last30' | 'custom';
export function presetRange(p: Preset, today = istToday()): { from: string; to: string } {
  switch (p) {
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y }; }
    case 'last7': return { from: addDays(today, -6), to: today };
    case 'last15': return { from: addDays(today, -14), to: today };
    case 'last30': return { from: addDays(today, -29), to: today };
    default: return { from: today, to: today };
  }
}

/** "2026-11" → "November 2026" (English, used in data/reports). */
export const monthLabel = (m: string, locale = 'en-IN') =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });

export const uuid = () => crypto.randomUUID();
