// Refresh intervals (ms). Defaults suit Firebase; netlify.toml sets slower values for Netlify's function quota.
const n = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);
export const POLL = {
  tables: n(import.meta.env.VITE_POLL_TABLES_MS, 15_000),
  station: n(import.meta.env.VITE_POLL_STATION_MS, 5_000),
  heartbeat: n(import.meta.env.VITE_HEARTBEAT_MS, 30_000),
};
