import { defineConfig } from 'shaders/config'

export default defineConfig({
  // Components are imported from 'shaders/vue'
  framework: 'vue',
  // Shaders project this codebase is connected to
  project: '4a6f2fa3-5c05-44ca-929a-a0343b6d9340',
  // Where `npx shaders install` writes component files
  outDir: 'src/components/shaders',
})
