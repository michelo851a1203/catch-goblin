import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import * as poki from './poki'

// 遊戲嵌在 Poki 的 iframe 中，避免方向鍵 / 空白鍵捲動外層頁面
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
})

// SDK 在背景初始化，畫面先顯示；之後的 SDK 呼叫會等初始化完成
void poki.init()
createApp(App).mount('#app')
