import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 纯前端：无后端、无外调。控制台与观众窗通过 BroadcastChannel 通信。
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT) || 8080,
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT) || 8080,
  },
});
