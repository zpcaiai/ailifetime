import { defineConfig } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';
import path from 'node:path';

export default defineConfig({
  plugins: [uni()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@ailifetime/contracts': path.resolve(__dirname, 'src/contracts/index.ts'),
      '@ailifetime/sdk-ts': path.resolve(__dirname, 'src/sdk/index.ts'),
    },
  },
});
