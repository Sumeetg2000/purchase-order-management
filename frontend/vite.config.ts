import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import browserslistToEsbuild from 'browserslist-to-esbuild';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { SECURITY_HEADERS, devContentSecurityPolicy } from '../deploy/security-headers.mjs';

// Vite does not read `browserslist`, so the build target is derived from the list in
// package.json (research R22).
export const buildTarget: string[] = browserslistToEsbuild(undefined, {
  path: fileURLToPath(new URL('.', import.meta.url)),
});

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The dev server for `npm run dev` (research R25): the production port and headers, and
 * /api/ proxied to the host-run API as nginx proxies it, so the browser sees one origin.
 * The one difference is a per-start nonce for the inline React Refresh preamble and the
 * styles Vite injects. Not applied to builds or Vitest.
 */
function devServer(): Plugin {
  return {
    name: 'po-dev-server',
    apply: (_config, { command }) => command === 'serve' && process.env['VITEST'] === undefined,
    config: () => {
      const env = loadEnv('development', REPO_ROOT, ['WEB_PORT', 'HTTP_PORT']);
      const nonce = randomBytes(16).toString('base64');
      return {
        html: { cspNonce: nonce },
        server: {
          port: Number(env['WEB_PORT']),
          strictPort: true,
          headers: {
            ...SECURITY_HEADERS,
            'Content-Security-Policy': devContentSecurityPolicy(nonce),
          },
          proxy: {
            '/api/': {
              target: `http://127.0.0.1:${env['HTTP_PORT'] ?? ''}`,
              rewrite: (path) => path.replace(/^\/api/, ''),
              // As nginx does: replace any client-supplied value rather than append to it.
              configure: (proxy) => {
                proxy.on('proxyReq', (proxyReq, req) => {
                  proxyReq.setHeader('X-Forwarded-For', req.socket.remoteAddress ?? '');
                  proxyReq.setHeader('X-Forwarded-Proto', 'http');
                });
              },
            },
          },
        },
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), devServer()],
  build: {
    target: buildTarget,
    // .vite/manifest.json, which the bundle budget check reads; the web image deletes it.
    manifest: true,
  },
});
