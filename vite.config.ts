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

  // Optimize dependencies for better production builds
  optimizeDeps: {
    include: ['@monaco-editor/react', 'monaco-editor'],
  },

  build: {
    // Increase chunk size warning limit for Monaco (it's a large library)
    chunkSizeWarningLimit: 1500,
    // Strip console.log/debug calls from production builds
    minify: 'esbuild',
    rollupOptions: {
      output: {
        // Ensure Monaco workers are properly chunked
        manualChunks: {
          monaco: ['@monaco-editor/react', 'monaco-editor'],
        },
      },
    },
  },
  esbuild: {
    // Remove console.log and console.debug in production
    drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
  },

  worker: {
    format: 'es',
  },
}));
