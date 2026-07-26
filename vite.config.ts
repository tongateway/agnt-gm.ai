import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy: api.agnt-gm.ai does not allow cross-origin browser calls,
// so /api is proxied during development. In production host the app
// behind the same domain or a reverse proxy that forwards /api.
export default defineConfig({
  // The app is served from https://agnt-gm.ai/app so the apex can hold the
  // indexable promo page instead of a JS shell. This only rewrites the asset
  // URLs baked into index.html (→ /app/assets/…); the files themselves still
  // sit at the bundle root, and the worker strips the prefix before looking
  // them up.
  //
  // Internal navigation is unaffected: the app routes on the hash
  // (#/bots/<id>/chat), so there are no path routes to rebase.
  base: '/app/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'https://api.agnt-gm.ai',
        changeOrigin: true,
        // the API 403s browser Origins that aren't allowlisted — don't forward them
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');
          });
        },
      },
    },
  },
});
