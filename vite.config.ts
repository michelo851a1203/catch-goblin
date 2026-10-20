import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages 會把網站放在 /<repo>/ 底下，由部署流程透過 BASE_PATH 指定；本機開發維持 '/'
  base: process.env.BASE_PATH || '/',
  plugins: [vue()],
})
