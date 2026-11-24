import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      filename: 'sw.js',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'brand/*.svg', 'brand/*.png'],
      manifest: {
        name: 'Shree Ram Bharose Hindu Hotel',
        id: '/',
        short_name: 'Ram Bharose',
        description: 'Orders, tables, billing and reports',
        theme_color: '#B4441B',
        background_color: '#FBF6EE',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        categories: ['business', 'food'],
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          { urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//, handler: 'CacheFirst', options: { cacheName: 'fonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } } },
          // API is never cached: the server is the source of truth.
        ],
      },
    }),
  ],
  server: {
    // `npm run dev` against running emulators (functions on :5001)
    proxy: { '/api': { target: 'http://127.0.0.1:5001', rewrite: (p) => `/demo-srbh/asia-south1/api${p}` } },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/tests/setup.ts'],
  },
});
