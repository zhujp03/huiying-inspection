import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // 从根目录 .env（唯一配置来源）读取公开前端变量；不再要求 apps/admin/.env.local。
  envDir: "../..",
  envPrefix: ["VITE_"],
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    // 会话 cookie 为 SameSite=Strict，管理后台必须与 API 同源：开发期由 Vite 代理 /api 到本地后端。
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
