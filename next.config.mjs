import withPWA from 'next-pwa';

const pwaConfig = withPWA({
  dest: 'public',
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development',
  buildExcludes: [/middleware-manifest\.json$/],
  // Don't precache page JS chunks — they're content-hashed so always fresh,
  // and precaching them causes stale bundle issues on deploy.
  exclude: [/^\/\_next\/static\/chunks\/app\//],
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default pwaConfig(nextConfig);
