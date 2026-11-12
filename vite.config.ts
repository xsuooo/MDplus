import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import config from './config/application.json';
import { buildId } from './config/build';
import { katexWoff2 } from './config/katexFonts';

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  // The Markdown decoder's browser export needs document, which Workers do not have.
  resolve: {
    alias: {
      'decode-named-character-reference': fileURLToPath(
        import.meta.resolve('decode-named-character-reference'),
      ),
    },
  },
  // Avoid a dependency-optimization reload when the first outline Worker starts.
  optimizeDeps: {
    include: ['unified', 'remark-parse', 'remark-gfm', 'remark-math', 'mdast-util-to-markdown'],
  },
  define: { __MDPLUS_BUILD_ID__: JSON.stringify(buildId()) },
  css: { postcss: { plugins: [katexWoff2()] } },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: config.development.port,
    strictPort: true,
    // 本机 localhost 解析到 ::1,而 tauri CLI 的健康检查访问 127.0.0.1:
    // 显式绑定 IPv4 回环,避免启动时卡在"等待前端 dev server"。
    host: host || config.development.host,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: config.development.hmrPort,
        }
      : undefined,
    watch: {
      // Native build and sandbox evidence files can be exclusively locked on Windows.
      ignored: ['**/src-tauri/**', '**/.audit/**', '**/_backup/**'],
    },
  },
  // 4. code-split third-party deps into stable vendor chunks
  //    仅分组同步依赖(React / 编辑器核心);mermaid 及其依赖交给
  //    rollup 默认拆分,保持「用到时才加载」的异步分包。
  build: {
    chunkSizeWarningLimit: config.limits.chunkWarningKb,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          editor: [
            '@milkdown/kit',
            '@milkdown/react',
            '@milkdown/theme-nord',
            '@milkdown/plugin-math',
            '@milkdown/plugin-prism',
            'katex',
            'refractor',
          ],
        },
      },
    },
  },
}));
