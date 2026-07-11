import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // vendor 分包：框架 / 高亮 / markdown 各自成 chunk，改业务代码不再抖动整包缓存。
        // vite 8（rolldown 内核）不再接受对象形 manualChunks，只认函数形。
        manualChunks(id: string) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) return "react";
          if (id.includes("node_modules/highlight.js/")) return "hljs";
          if (id.includes("node_modules/marked/") || id.includes("node_modules/dompurify/")) return "markdown";
          return undefined;
        },
      },
    },
  },
  server: {
    // 本地联调：wrangler-accounts dev 默认 8787
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
      "/openapi.json": { target: "http://localhost:8787" },
    },
  },
});
