import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages 會把網站放在 /<repo>/ 底下，由部署流程透過 BASE_PATH 指定；本機開發維持 '/'
  base: process.env.BASE_PATH || '/',
  plugins: [vue()],
  build: {
    rollupOptions: {
      // 女精靈角色預覽頁（/elf-preview.html）
      input: { main: resolve(__dirname, 'index.html'), elfPreview: resolve(__dirname, 'elf-preview.html') },
    },
  },
})
