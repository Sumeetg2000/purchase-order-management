import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import browserslistToEsbuild from 'browserslist-to-esbuild';
import { defineConfig } from 'vite';

// Vite does not read `browserslist`, so the build target is derived from the list in
// package.json (research R22).
export const buildTarget: string[] = browserslistToEsbuild(undefined, {
  path: fileURLToPath(new URL('.', import.meta.url)),
});

export default defineConfig({
  plugins: [react()],
  build: {
    target: buildTarget,
    // .vite/manifest.json, which the bundle budget check reads; the web image deletes it.
    manifest: true,
  },
});
