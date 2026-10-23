import { ref } from 'vue'

// 觸控模式：主要指標為觸控（手機 / 平板）時預設開啟；之後依實際輸入切換，觸控筆電也能正確處理
function coarse() {
  try {
    return matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

export const touchMode = ref(coarse())

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch') touchMode.value = true
      else if (e.pointerType === 'mouse') touchMode.value = false
    },
    { capture: true, passive: true },
  )
}

// 觸控裝置效能較弱，降低畫質
export const lowPower = coarse()
