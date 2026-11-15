// Netlify Function: the same Express API that runs on Firebase Cloud Functions.
// The site proxies /api/* here (netlify.toml), so the browser stays same-origin and the
// secure "__session" cookie works exactly as on Firebase Hosting.
import serverless from 'serverless-http';
import { createApp } from '../../functions/lib/app.js';

// The live API never has server-side demo users; the Demo buttons use an in-browser sample backend instead.
const app = createApp({ bootstrapToken: () => process.env.BOOTSTRAP_TOKEN, demoMode: false });

/** Requests may arrive as /.netlify/functions/api/<path> or /api/<path>; the app expects /api/<path>. */
export const normalizePath = (url) => {
  let u = url.replace(/^\/\.netlify\/functions\/api/, '') || '/';
  if (!u.startsWith('/api/') && u !== '/api') u = `/api${u.startsWith('/') ? '' : '/'}${u}`;
  return u;
};

export const handler = serverless(app, { request: (req) => { req.url = normalizePath(req.url); } });
