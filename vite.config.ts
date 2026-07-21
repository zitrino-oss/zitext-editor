import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
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
    // Monaco's TypeScript worker is intentionally isolated and large; exact
    // per-asset budgets are enforced after every build.
    chunkSizeWarningLimit: 7500,
    rollupOptions: {
      output: {
        // Ensure Monaco workers are properly chunked. Rolldown (Vite 8) only
        // accepts the function form of manualChunks.
        manualChunks: (id: string) =>
          id.includes('monaco-editor') || id.includes('@monaco-editor/react')
            ? 'monaco'
            : undefined,
      },
    },
  },
  // NOTE: The former `esbuild.drop` that stripped console.*/debugger from
  // production builds was removed in the Vite 8 upgrade. Vite 8 minifies with
  // Oxc and no longer honors that option, and no equivalent is currently
  // exposed through Vite's config. Revisit once Oxc/Rolldown surface a
  // console-drop option in Vite.

  worker: {
    format: 'es',
  },
});
