import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 住哪儿：原页面（index.html + public/app.js）保持原样，
// 仅 AI 助手面板作为 React Island（src/assistant）经 Vite 构建进 dist。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    // vite dev 时把 API 与高德代理转发到本地 wrangler dev（8787）
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
