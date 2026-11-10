import vue from '@vitejs/plugin-vue'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { sitePlugin } from './site/plugin.ts'

const root = import.meta.dirname
// 女精靈角色預覽頁（/elf-preview.html）是本機除錯用、已被 .gitignore 排除；檔案存在時才加入建置，CI 只建置遊戲本體
const preview = resolve(root, 'elf-preview.html')

// https://vite.dev/config/
export default defineConfig({
  // CrazyGames 會把遊戲放在自己的路徑底下，資源一律使用相對路徑
  base: './',
  // SITE_URL：只有網站版（Cloudflare Pages）建置時設定，注入 SEO / 社群卡片（見 site/plugin.ts）；CrazyGames 版不設定
  plugins: [vue(), sitePlugin(process.env.SITE_URL)],
  build: {
    rollupOptions: {
      input: { main: resolve(root, 'index.html'), ...(existsSync(preview) ? { elfPreview: preview } : {}) },
    },
  },
})
