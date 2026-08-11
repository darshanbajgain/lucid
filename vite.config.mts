import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import manifest from './manifest.json'
import { resolve } from 'path'

export default defineConfig({
    plugins: [tailwindcss(), react(), crx({ manifest })],
    build: {
        rollupOptions: {
            input: {
                offscreen: resolve(__dirname, 'offscreen.html'),
            },
        },
    },
    server: {
        port: 5173,
        strictPort: true,
        hmr: {
            port: 5173,
        },
    },
})
