import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { fileURLToPath, URL } from 'node:url';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => {
  // Tauri CLI sets TAURI_ENV_PLATFORM for `tauri dev/build`.
  // Only the plain browser build should use the HTTP/SSE shim; replacing the
  // Tauri API in a real desktop build breaks every invoke with "Failed to fetch".
  // @ts-expect-error process is a nodejs global
  const isTauriBuild = Boolean(process.env.TAURI_ENV_PLATFORM || process.env.TAURI_DEV)
  const tauriShimAliases = isTauriBuild
    ? {}
    : {
        // 浏览器版：把 Tauri 的 invoke/listen/Channel 换成 HTTP + SSE。
        '@tauri-apps/api/core': fileURLToPath(
          new URL('./src/web-tauri.ts', import.meta.url)
        ),
        '@tauri-apps/api/event': fileURLToPath(
          new URL('./src/web-tauri.ts', import.meta.url)
        )
      }

  return {
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@protobufjs/inquire': fileURLToPath(
          new URL('./src/shims/protobuf-inquire-shim.cjs', import.meta.url)
        ),
        ...tauriShimAliases
      }
    },
    plugins: [
      vue(),
      nodePolyfills({
        include: ['buffer', 'stream', 'util', 'path'],
        globals: { Buffer: true, process: true }
      })
    ],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalizedId = id.replace(/\\/g, '/')

            if (
              normalizedId.includes('/node_modules/protobufjs/') ||
              normalizedId.includes('/node_modules/@protobufjs/') ||
              normalizedId.includes('/node_modules/long/')
            ) {
              return 'protobuf-runtime'
            }

            if (
              normalizedId.endsWith('/src/api-shim.ts') ||
              normalizedId.endsWith('/src/utils/mqtt_protocol.ts') ||
              normalizedId.endsWith('/src/generated/mqtt-proto.json')
            ) {
              return 'mqtt-runtime'
            }

            if (normalizedId.includes('/node_modules/@tauri-apps/')) {
              return 'tauri-runtime'
            }

            return undefined
          }
        }
      }
    },
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
        // 浏览器演示时还要忽略截图 profile 和编辑器的临时目录，
        // 否则 Windows 上 chokidar 会因 EBUSY 直接崩掉。
        ignored: [
          "**/src-tauri/**",
          "**/screenshots/**",
          "**/.*.tmpdir/**",
          "**/.*.tmp",
        ],
      },
    },
  }
});
