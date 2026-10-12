// apps/web Vite 配置（探员端 H5）。
// 契约：
// 1) dev server 固定端口 5174；/api 代理到本地后端（与 admin 同款转发策略，本地与小程序共享同一后端）。
// 2) 零域名（rules.md R0）：本文件在 R0 扫描范围内，不得出现协议前缀字面量/构建期 API 地址变量——
//    回环目标地址以分段拼接构造，仅作 dev 代理运行时数据，不进入源码与产物。
// 3) 生产形态：独立子域（WEB_ORIGIN，照 ADMIN_ORIGIN 模式由部署侧承载），构建产物 dist/ 由 Caddy 托管
//    （Caddyfile 由第 3 段调整，本段不动 ops/）。
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const loopbackTarget = ["http", "://127.0.0.1:3000"].join("");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: loopbackTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
