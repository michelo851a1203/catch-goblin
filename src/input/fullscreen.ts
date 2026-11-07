import { ref } from 'vue'

// 全螢幕：手機上瀏覽器的網址列 / 導覽列會擋住畫面，提供按鈕讓玩家切換。
// iPhone Safari 不支援元素全螢幕（iPad 可以，舊版需 webkit 前綴），不支援時不顯示按鈕
type Doc = Document & {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}
type El = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

const doc = (typeof document !== 'undefined' ? document : undefined) as Doc | undefined

export const fullscreenSupported = !!doc && !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled)

function current() {
  return !!doc && !!(doc.fullscreenElement || doc.webkitFullscreenElement)
}

export const isFullscreen = ref(current())

if (doc) {
  const sync = () => (isFullscreen.value = current())
  doc.addEventListener('fullscreenchange', sync)
  doc.addEventListener('webkitfullscreenchange', sync)
}

export async function toggleFullscreen() {
  if (!doc || !fullscreenSupported) return
  try {
    if (current()) {
      await (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.())
      return
    }
    const el = doc.documentElement as El
    await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.())
    // 遊戲只能橫向玩；部分 Android 瀏覽器全螢幕後可以鎖定方向，不支援就算了
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
    await o?.lock?.('landscape').catch(() => {})
  } catch {
    /* 使用者拒絕或瀏覽器不允許（例如 iframe 未開放 fullscreen）時忽略 */
  }
}
