import { onRequest } from 'firebase-functions/https';
import { onSchedule } from 'firebase-functions/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { createApp } from './app.js';
import { runMonthlyRollup } from './retention.js';

// Nightly: roll previous months into monthly summaries, delete their detail, keep 12 months.
export const monthlyRetention = onSchedule(
  { schedule: '30 2 * * *', timeZone: 'Asia/Kolkata', region: 'asia-south1', memory: '512MiB', timeoutSeconds: 540, maxInstances: 1 },
  async () => { await runMonthlyRollup(); },
);

const BOOTSTRAP_TOKEN = defineSecret('BOOTSTRAP_TOKEN');

// Demo login requires BOTH the env flag and a demo-* project id, so it can never be on in production.
const demoMode = process.env.DEMO_MODE === 'true' && (process.env.GCLOUD_PROJECT ?? '').startsWith('demo-');

export const api = onRequest(
  // maxInstances 1: plenty for 3 users, keeps costs inside the free tier, and keeps the in-memory cache coherent.
  { region: 'asia-south1', secrets: [BOOTSTRAP_TOKEN], memory: '512MiB', maxInstances: 1, concurrency: 80, minInstances: 0, invoker: 'public' },
  createApp({ bootstrapToken: () => BOOTSTRAP_TOKEN.value(), demoMode }),
);
