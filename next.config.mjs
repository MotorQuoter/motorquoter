import withPWA from 'next-pwa';
import defaultCache from 'next-pwa/cache.js';

// The default cache.js intercepts same-origin GET /api/ routes with NetworkFirst
// (10 s timeout → stale cache fallback). In PWA standalone mode on Android this
// causes the DVLA lookup to hang or silently return a stale response. Replace that
// entry with NetworkOnly so the service worker never caches API calls.
const runtimeCaching = defaultCache.map(entry =>
  entry.options?.cacheName === 'apis'
    ? { urlPattern: entry.urlPattern, handler: 'NetworkOnly' }
    : entry
);

const pwaConfig = withPWA({
  dest: 'public',
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development',
  // Don't precache page JS chunks — they're content-hashed so always fresh,
  // and precaching them causes stale bundle issues on deploy.
  buildExcludes: [/middleware-manifest\.json$/, /static\/chunks\/app\//],
  runtimeCaching,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      },
    ];
  },
};

export default pwaConfig(nextConfig);
