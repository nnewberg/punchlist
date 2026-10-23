import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

// PL-014: `vite build` stamps one id into the web bundle and the Worker (shared/build.ts), so an open
// tab can tell when a newer build is deployed. The commit in CI; otherwise the time of the build.
// Picked once per process: the client and the Worker are built from separate loads of this config.
// `vite` (npm run dev) leaves it out, and dev tabs never reload themselves.
const buildId = () => (process.env.PUNCH_BUILD ||= process.env.GITHUB_SHA?.slice(0, 12) || `t${Date.now().toString(36)}`);

export default defineConfig(({ command }) => ({
  publicDir: 'web/public',
  plugins: [react(), cloudflare()],
  ...(command === 'build' ? { define: { __PUNCH_BUILD__: JSON.stringify(buildId()) } } : {}),
}));
