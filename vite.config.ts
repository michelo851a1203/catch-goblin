import vue from '@vitejs/plugin-vue'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname
// 女精靈角色預覽頁（/elf-preview.html）是本機除錯用、已被 .gitignore 排除；檔案存在時才加入建置，CI 只建置遊戲本體
const preview = resolve(root, 'elf-preview.html')

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages 會把網站放在 /<repo>/ 底下，由部署流程透過 BASE_PATH 指定；本機開發維持 '/'
  base: process.env.BASE_PATH || '/',
  plugins: [vue()],
  build: {
    rollupOptions: {
      input: { main: resolve(root, 'index.html'), ...(existsSync(preview) ? { elfPreview: preview } : {}) },
    },
  },
})
