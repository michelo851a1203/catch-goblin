import './style.css'
import * as crazygames from './crazygames'

// 遊戲嵌在 CrazyGames 的 iframe 中，避免方向鍵 / 空白鍵捲動外層頁面
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
})

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
