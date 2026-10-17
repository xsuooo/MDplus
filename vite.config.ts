import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // 本机 localhost 解析到 ::1,而 tauri CLI 的健康检查访问 127.0.0.1:
    // 显式绑定 IPv4 回环,避免启动时卡在"等待前端 dev server"。
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // 4. code-split third-party deps into stable vendor chunks
  //    仅分组同步依赖(React / 编辑器核心);mermaid 及其依赖交给
  //    rollup 默认拆分,保持「用到时才加载」的异步分包。
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          editor: [
            "@milkdown/kit",
            "@milkdown/react",
            "@milkdown/theme-nord",
            "@milkdown/plugin-math",
            "@milkdown/plugin-prism",
            "katex",
            "refractor",
          ],
        },
      },
    },
  },
}));
