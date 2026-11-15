// Netlify Function: the same Express API that runs on Firebase Cloud Functions.
// The site proxies /api/* here (netlify.toml), so the browser stays same-origin and the
// secure "__session" cookie works exactly as on Firebase Hosting.
import serverless from 'serverless-http';
import { createApp } from '../../functions/lib/app.js';

// DEMO_MODE=true (Netlify env var) = preview mode: demo logins with KNOWN passwords. Turn off before real use.
const app = createApp({ bootstrapToken: () => process.env.BOOTSTRAP_TOKEN, demoMode: process.env.DEMO_MODE === 'true' });

/** Requests may arrive as /.netlify/functions/api/<path> or /api/<path>; the app expects /api/<path>. */
export const normalizePath = (url) => {
  let u = url.replace(/^\/\.netlify\/functions\/api/, '') || '/';
  if (!u.startsWith('/api/') && u !== '/api') u = `/api${u.startsWith('/') ? '' : '/'}${u}`;
  return u;
};

export const handler = serverless(app, { request: (req) => { req.url = normalizePath(req.url); } });
