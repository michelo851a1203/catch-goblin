import { ref } from 'vue'

// 裝置類型：CrazyGames 規定以 SDK 的 user.systemInfo.device.type 判斷，不可依賴觸控偵測。
// SDK 不可用（其他網域、廣告阻擋器）時才退回 (pointer: coarse) media query
export type DeviceType = 'desktop' | 'tablet' | 'mobile'

function coarse() {
  try {
    return matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

let platformDevice: DeviceType | null = null

// 手機 / 平板（觸控為主的裝置）
export function isTouchDevice() {
  return platformDevice ? platformDevice !== 'desktop' : coarse()
}

// 觸控模式：觸控裝置預設開啟；之後依實際輸入切換，觸控筆電也能正確處理
export const touchMode = ref(isTouchDevice())

// 觸控裝置效能較弱，降低畫質（Game 建立時讀取，SDK 已在 boot() 中初始化完成）
export let lowPower = isTouchDevice()

// 由 crazygames.ts 在 SDK 初始化後呼叫，以平台回報的裝置類型為準
export function setPlatformDevice(type: string | undefined) {
  if (type !== 'desktop' && type !== 'tablet' && type !== 'mobile') return
  platformDevice = type
  touchMode.value = lowPower = isTouchDevice()
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch') touchMode.value = true
      else if (e.pointerType === 'mouse') touchMode.value = false
    },
    { capture: true, passive: true },
  )
}
