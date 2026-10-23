import { setMuted } from './game/audio'

// Poki SDK 包裝：SDK 由 index.html 載入；被廣告阻擋器擋掉或本機測試時 window.PokiSDK 可能不存在，全部改成 no-op
interface PokiSDKApi {
  init(): Promise<void>
  setDebug(on: boolean): void
  gameLoadingFinished(): void
  gameplayStart(): void
  gameplayStop(): void
  commercialBreak(onStart?: () => void): Promise<void>
}

declare global {
  interface Window {
    PokiSDK?: PokiSDKApi
  }
}

let ready = false
let loaded = false
let playing = false
let initP: Promise<void> | null = null

export function init() {
  initP ??= doInit()
  return initP
}

async function doInit() {
  const sdk = window.PokiSDK
  if (!sdk) return
  try {
    // 避免 SDK 卡住導致按下開始後一直等待
    await Promise.race([sdk.init(), new Promise((r) => setTimeout(r, 5000))])
    ready = true
    if (import.meta.env.DEV) sdk.setDebug(true)
  } catch {
    /* 廣告阻擋器：遊戲照常進行 */
  }
}

export async function loadingFinished() {
  await init()
  if (!ready || loaded) return
  loaded = true
  window.PokiSDK!.gameLoadingFinished()
}

export function gameplayStart() {
  if (!ready || playing) return
  playing = true
  window.PokiSDK!.gameplayStart()
}

export function gameplayStop() {
  if (!ready || !playing) return
  playing = false
  window.PokiSDK!.gameplayStop()
}

// 插頁廣告：只在回合之間呼叫，播放頻率由 Poki 控制；廣告期間靜音
export async function commercialBreak() {
  await init()
  if (!ready) return
  gameplayStop()
  try {
    await window.PokiSDK!.commercialBreak(() => setMuted(true))
  } catch {
    /* ignore */
  } finally {
    setMuted(false)
  }
}
