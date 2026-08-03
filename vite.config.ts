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
    host: host || false,
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
