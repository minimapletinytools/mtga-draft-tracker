import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolve = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@drafttracker/core': resolve('../../packages/core/src/index.ts'),
      '@drafttracker/arena': resolve('../../packages/arena/src/index.ts'),
      '@drafttracker/cards': resolve('../../packages/cards/src/index.ts'),
    },
  },
});
