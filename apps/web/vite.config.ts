import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const resolve = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  // Relative base so the built app also works from file:// inside Electron.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@drafttracker/core': resolve('../../packages/core/src/index.ts'),
    },
  },
  server: { port: 5183 },
});
