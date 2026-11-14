import { ref } from 'vue'
import { isCrazyGames } from '../platform'

// 網站版（Cloudflare Pages）：手機瀏覽器的網址列 / 工具列會吃掉畫面，iPhone 也不支援網頁全螢幕。
// 引導玩家「加入主畫面」，之後從主畫面圖示開啟就是全螢幕（manifest 由 site/plugin.ts 產生）。
// CrazyGames 版由平台提供全螢幕，不顯示。
export type MobileOs = 'ios' | 'android'

// iPadOS 13 起 Safari 預設回報桌機版 UA（Macintosh），以觸控點數區分
export function mobileOs(ua: string, maxTouchPoints = 0): MobileOs | null {
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return null
}

// 已經從主畫面圖示開啟（獨立視窗 / 全螢幕）
function standalone() {
  try {
    if ((navigator as Navigator & { standalone?: boolean }).standalone) return true
    return matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches
  } catch {
    return false
  }
}

const os = typeof navigator !== 'undefined' ? mobileOs(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0) : null

// 要顯示哪一種系統的步驟；null 表示不顯示
export const installGuide: MobileOs | null = !isCrazyGames && os && !standalone() ? os : null

// Android Chrome 可以直接跳出安裝視窗（beforeinstallprompt），拿得到時多顯示一顆「安裝」按鈕
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
let deferred: InstallPrompt | null = null
export const canPrompt = ref(false)

if (installGuide === 'android' && typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPrompt
    canPrompt.value = true
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    canPrompt.value = false
  })
}

export async function promptInstall() {
  const p = deferred
  if (!p) return
  // 每個事件只能 prompt 一次
  deferred = null
  canPrompt.value = false
  try {
    await p.prompt()
    await p.userChoice
  } catch {
    /* 瀏覽器拒絕時忽略，玩家仍可照步驟手動加入 */
  }
}
