import { setMuted } from './game/audio'

// CrazyGames SDK v3 包裝：SDK 由 index.html 載入。被廣告阻擋器擋掉，或在 CrazyGames 以外的網域（environment 為 disabled）時，全部改成 no-op
interface AdError {
  code: string
  message: string
}
interface AdCallbacks {
  adStarted(): void
  adFinished(): void
  adError(error: AdError): void
}
interface RoomInfo {
  roomId: string
  isJoinable: boolean
  inviteParams?: Record<string, string>
}
interface Settings {
  muteAudio?: boolean
}
type InviteParams = Record<string, string> | null | undefined

interface CrazyGamesSDK {
  init(): Promise<void>
  environment: 'local' | 'crazygames' | 'disabled'
  ad: { requestAd(type: 'midgame' | 'rewarded', callbacks: AdCallbacks): void }
  game: {
    loadingStart(): void
    loadingStop(): void
    gameplayStart(): void
    gameplayStop(): void
    inviteParams?: InviteParams
    isInstantMultiplayer?: boolean
    settings?: Settings
    addSettingsChangeListener?(fn: (s: Settings) => void): void
    addJoinRoomListener?(fn: (params: InviteParams) => void): void
    updateRoom?(room: RoomInfo): void
    leftRoom?(): void
  }
  user: {
    isUserAccountAvailable: boolean
    systemInfo?: { locale?: string }
    getUser(): Promise<{ username: string } | null>
  }
  data: { getItem(key: string): string | null; setItem(key: string, value: string): void }
}

declare global {
  interface Window {
    CrazyGames?: { SDK?: CrazyGamesSDK }
  }
}

// SDK 卡住時不要讓玩家一直等
const INIT_TIMEOUT = 5000
// 請求廣告後遲遲沒有回應時放行；廣告開始播放後就會等到播完
const AD_START_TIMEOUT = 8000

let sdk: CrazyGamesSDK | null = null
let loaded = false
let playing = false
let adMuted = false
let settingsMuted = false
let initP: Promise<void> | null = null

function syncMute() {
  setMuted(adMuted || settingsMuted)
}

export function init() {
  initP ??= doInit()
  return initP
}

async function doInit() {
  const s = window.CrazyGames?.SDK
  if (!s) return
  try {
    const ok = await Promise.race([s.init().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), INIT_TIMEOUT))])
    if (!ok || s.environment === 'disabled') return
    sdk = s
    s.game.loadingStart()
    // 平台的靜音設定優先於遊戲內的音效
    settingsMuted = !!s.game.settings?.muteAudio
    syncMute()
    s.game.addSettingsChangeListener?.((v) => {
      settingsMuted = !!v.muteAudio
      syncMute()
    })
  } catch {
    sdk = null // 廣告阻擋器：遊戲照常進行
  }
}

// 只有初始化完成時才呼叫 SDK；SDK 內部的錯誤不能影響遊戲
function call(fn: (s: CrazyGamesSDK) => void) {
  if (!sdk) return
  try {
    fn(sdk)
  } catch {
    /* ignore */
  }
}

export function loadingFinished() {
  if (loaded) return
  loaded = true
  call((s) => s.game.loadingStop())
}

export function gameplayStart() {
  if (!sdk || playing) return
  playing = true
  call((s) => s.game.gameplayStart())
}

export function gameplayStop() {
  if (!sdk || !playing) return
  playing = false
  call((s) => s.game.gameplayStop())
}

// 插頁廣告：只在回合之間呼叫，播放頻率由 CrazyGames 控制；真的開始播放時才靜音
export async function commercialBreak() {
  await init()
  const s = sdk
  if (!s) return
  gameplayStop()
  await new Promise<void>((resolve) => {
    let timer = 0
    const done = () => {
      clearTimeout(timer)
      adMuted = false
      syncMute()
      resolve()
    }
    timer = window.setTimeout(done, AD_START_TIMEOUT)
    try {
      s.ad.requestAd('midgame', {
        adStarted() {
          clearTimeout(timer)
          adMuted = true
          syncMute()
        },
        adFinished: done,
        adError: done, // 沒有廣告、冷卻中、被阻擋：直接繼續
      })
    } catch {
      done()
    }
  })
}

// ───────────── 存檔 ─────────────
// 與 localStorage 相同的介面；登入的玩家可跨裝置同步。SDK 不可用（或投稿時未開啟 Progress Save）時退回 localStorage
export const store = {
  getItem(key: string): string | null {
    if (sdk) {
      try {
        return sdk.data.getItem(key)
      } catch {
        /* 退回 localStorage */
      }
    }
    return localStorage.getItem(key)
  },
  setItem(key: string, value: string) {
    if (sdk) {
      try {
        sdk.data.setItem(key, value)
        return
      } catch {
        /* 退回 localStorage */
      }
    }
    localStorage.setItem(key, value)
  },
}

// ───────────── 玩家資訊 ─────────────
export function platformLocale() {
  try {
    return sdk?.user.systemInfo?.locale
  } catch {
    return undefined
  }
}

// 已登入 CrazyGames 時回傳使用者名稱
export async function username() {
  if (!sdk?.user.isUserAccountAvailable) return ''
  try {
    return (await sdk.user.getUser())?.username ?? ''
  } catch {
    return ''
  }
}

// ───────────── 多人連線：好友邀請 / 加入 ─────────────
const inviteCode = (params: InviteParams) => (params?.room && /^\d{4}$/.test(params.room) ? params.room : null)

// 遊戲是從邀請連結開啟時回傳房號
export function startupInvite() {
  return inviteCode(sdk?.game.inviteParams)
}

export function isInstantMultiplayer() {
  return !!sdk?.game.isInstantMultiplayer
}

// 玩家已經在遊戲中，又接受了好友邀請
export function onInvite(fn: (code: string) => void) {
  call((s) =>
    s.game.addJoinRoomListener?.((params) => {
      const code = inviteCode(params)
      if (code) fn(code)
    }),
  )
}

export function updateRoom(code: string, isJoinable: boolean) {
  call((s) => s.game.updateRoom?.({ roomId: code, isJoinable, inviteParams: { room: code } }))
}

export function leftRoom() {
  call((s) => s.game.leftRoom?.())
}
