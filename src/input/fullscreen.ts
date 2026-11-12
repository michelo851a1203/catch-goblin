import { ref } from 'vue'
import { touchMode } from './touch'
import { isCrazyGames } from '../platform'

// 全螢幕：手機上瀏覽器的網址列 / 導覽列會擋住畫面，提供按鈕讓玩家切換。
// iPhone Safari 不支援元素全螢幕（iPad 可以，舊版需 webkit 前綴），不支援時不顯示按鈕
type Doc = Document & {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}
type El = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

const doc = (typeof document !== 'undefined' ? document : undefined) as Doc | undefined

// CrazyGames 規定全螢幕由平台提供、遊戲內不可自己做：在 CrazyGames 上整個功能關閉（不顯示按鈕、不自動重新進入全螢幕）。
// Cloudflare Pages 等其他網域照舊提供
const onPlatformFullscreen = isCrazyGames
export const fullscreenSupported = !!doc && !onPlatformFullscreen && !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled)

function current() {
  return !!doc && !!(doc.fullscreenElement || doc.webkitFullscreenElement)
}

export const isFullscreen = ref(current())

// 玩家是否想要全螢幕：只有按全螢幕鈕才會改變。
// iPadOS Safari 的系統手勢（雙指往內捏、往下滑）、切換 App、播廣告都會讓瀏覽器自己退出全螢幕，
// 網頁無法阻止；這時在玩家下一次點擊畫面時自動回到全螢幕（requestFullscreen 必須在使用者操作中呼叫）
let wanted = false
let armed = false
// 全螢幕鈕自己會處理切換，自動恢復時要略過它，否則同一下點擊會先進入又立刻退出
export const FS_TOGGLE_ATTR = 'data-fs-toggle'
const REENTER_EVENTS = ['touchend', 'click'] as const

function reenter(e: Event) {
  if (!wanted || current()) return disarm()
  if ((e.target as Element | null)?.closest?.(`[${FS_TOGGLE_ATTR}]`)) return
  disarm()
  void enter().then((ok) => {
    // 這次不被瀏覽器接受（例如不算使用者操作）就等下一次點擊再試
    if (!ok && wanted && !current()) arm()
  })
}
function arm() {
  if (armed || !doc || !fullscreenSupported) return
  armed = true
  for (const type of REENTER_EVENTS) doc.addEventListener(type, reenter, { capture: true, passive: true })
}
function disarm() {
  if (!armed || !doc) return
  armed = false
  for (const type of REENTER_EVENTS) doc.removeEventListener(type, reenter, { capture: true })
}

if (doc) {
  const sync = () => {
    isFullscreen.value = current()
    if (isFullscreen.value) disarm()
    // 桌機按 Esc 離開全螢幕是玩家自己的意思，只在觸控裝置自動恢復
    else if (wanted && touchMode.value) arm()
  }
  doc.addEventListener('fullscreenchange', sync)
  doc.addEventListener('webkitfullscreenchange', sync)
}

async function enter() {
  if (!doc || !fullscreenSupported) return false
  try {
    const el = doc.documentElement as El
    await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.())
  } catch {
    /* 使用者拒絕或瀏覽器不允許（例如 iframe 未開放 fullscreen）時忽略 */
    return false
  }
  // 遊戲只能橫向玩；部分 Android 瀏覽器全螢幕後可以鎖定方向，不支援就算了
  const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
  await o?.lock?.('landscape').catch(() => {})
  return true
}

export async function toggleFullscreen() {
  if (!doc || !fullscreenSupported) return
  disarm()
  // 畫面上顯示「離開全螢幕」時才算玩家主動退出；其餘情況（含自動退出後）按下都是要進入全螢幕
  if (current()) {
    wanted = false
    try {
      await (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.())
    } catch {
      /* 已經不在全螢幕時忽略 */
    }
    return
  }
  // webkit 前綴版本不回傳 Promise，進入失敗時不會丟錯，以 fullscreenchange 為準
  if (await enter()) wanted = true
}
