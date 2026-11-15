// India has a fixed +05:30 offset (no DST), so plain string math is safe.
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function istParts(d: Date) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

export const istToday = (now = new Date()) => istParts(now).date;

/** IST wall-clock → UTC instant. time is HH:mm or HH:mm:ss */
export const istToUtc = (date: string, time = '00:00') =>
  new Date(`${date}T${time.length === 5 ? time + ':00' : time}+05:30`);

export function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Half-open [start, end) UTC range for an IST date/time filter. toTime is inclusive to the minute. */
export function istRange(from: string, to: string, fromTime?: string, toTime?: string) {
  const start = istToUtc(from, fromTime ?? '00:00');
  const end = toTime ? new Date(istToUtc(to, toTime).getTime() + 60_000) : istToUtc(addDays(to, 1));
  return { start, end };
}
