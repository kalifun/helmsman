// 职责：Vite 配置 —— dev proxy 把 /api 与 /api/events 代理到 Rust 服务（服务无 CORS 头，必须同源代理）。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // localhost(::1) 与 127.0.0.1 均可访问
    port: 5173,
    proxy: {
      // REST + WS（/api/events）统一代理到 helmsman 产品服务；ws:true 让 /api/events 走 WebSocket 升级。
      '/api': {
        target: 'http://127.0.0.1:3081',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});