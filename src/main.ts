import './style.css'
import * as crazygames from './crazygames'

// 遊戲嵌在 CrazyGames 的 iframe 中，避免方向鍵 / 空白鍵捲動外層頁面
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
})

// 手機：禁止雙指 / 雙擊縮放頁面。iOS Safari 會忽略 viewport 的 user-scalable=no，只能用事件攔截。
// 遊戲內的雙指縮放視角走 Pointer Events（TouchControls），不受這裡影響
const stop = (e: Event) => e.preventDefault()
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, stop, { passive: false })
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.touches.length > 1) e.preventDefault()
  },
  { passive: false },
)
// 舊版 iOS 不吃 touch-action: manipulation，快速連點兩下時取消第二下的預設行為（縮放）
let lastTouchEnd = 0
document.addEventListener(
  'touchend',
  (e) => {
    const now = e.timeStamp
    const el = e.target as Element | null
    // 輸入框要保留雙擊選字
    if (now - lastTouchEnd < 350 && !el?.closest?.('input, textarea, [contenteditable]')) e.preventDefault()
    lastTouchEnd = now
  },
  { passive: false },
)

// 語言、鍵位、戰績都從 SDK 的存檔讀取，所以要等 SDK 初始化完成才載入遊戲
async function boot() {
  await crazygames.init()
  const [{ createApp }, { default: App }, { saveName }] = await Promise.all([import('vue'), import('./App.vue'), import('./net/room')])
  // 多人連線必須顯示 CrazyGames 使用者名稱，好友才認得出來
  const name = await crazygames.username()
  if (name) saveName(name)
  createApp(App).mount('#app')
}
void boot()
