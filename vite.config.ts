import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const serverConfPath = resolve(__dirname, './conf/server.conf')

const readDevServerPort = (): number => {
  const envPort = Number(process.env.VITE_DEV_PORT)
  if (Number.isFinite(envPort) && envPort > 0) {
    return Math.floor(envPort)
  }

  try {
    const content = readFileSync(serverConfPath, 'utf-8')
    const match = content.match(/^\s*port\s*=\s*(\d+)\s*$/m)
    if (match) {
      const port = Number(match[1])
      if (Number.isFinite(port) && port > 0) {
        return port
      }
    }
  } catch {
    // Fall back to the default dev port when server.conf is missing or invalid.
  }

  return 5173
}

const readDevServerHost = (): string => {
  const envHost = String(process.env.VITE_DEV_HOST || '').trim()
  if (envHost) {
    return envHost
  }

  return '127.0.0.1'
}

export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    host: readDevServerHost(),
    port: readDevServerPort(),
    strictPort: true,
  },
  build: {
    outDir: 'dist',
  }
}))
