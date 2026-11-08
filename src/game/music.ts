import { audioContext, onMuteChange } from './audio'

// 背景音樂：主選單、精靈視角、哥布林視角各一首，循環播放；結算時依獲勝陣營播放勝利音樂（只播一次）。切換時淡出淡入。
// 以 <audio> 串流播放（不必整首解碼進記憶體），再接到 WebAudio 的 GainNode 控制音量（iOS 的 audio.volume 是唯讀的）
export type Track = 'menu' | 'elf' | 'goblin' | 'elfWin' | 'goblinWin'

const FILES: Record<Track, string> = {
  menu: 'menu.mp3',
  elf: 'elf.mp3',
  goblin: 'goblin.mp3',
  elfWin: 'elf-win.mp3',
  goblinWin: 'goblin-win.mp3',
}
// 勝利音樂只播一次，播完就安靜，直到玩家離開結算畫面
const ONCE = new Set<Track>(['elfWin', 'goblinWin'])
export const MUSIC_VOLUME = 0.4
const FADE = 0.8 // 秒

interface Channel {
  el: HTMLAudioElement
  gain: GainNode | null // 瀏覽器不支援 WebAudio 時退回 el.volume
  on: boolean // 目前的目標狀態（播放 / 停止）
  stopTimer: ReturnType<typeof setTimeout> | undefined
}

const channels = new Map<Track, Channel>()
let want: Track | null = null
let muted = false
let hidden = false
let unlocked = false // 瀏覽器規定要先有使用者互動才能播放聲音
let pending: ReturnType<typeof setTimeout> | undefined

function url(t: Track) {
  return `${import.meta.env.BASE_URL}music/${FILES[t]}`
}

function channel(t: Track) {
  let ch = channels.get(t)
  if (ch) return ch
  const el = new Audio(url(t))
  el.loop = !ONCE.has(t)
  el.preload = 'auto'
  el.dataset.track = t
  let gain: GainNode | null = null
  try {
    const ctx = audioContext()
    gain = ctx.createGain()
    gain.gain.value = 0
    ctx.createMediaElementSource(el).connect(gain).connect(ctx.destination)
  } catch {
    gain = null
    el.volume = 0
  }
  const c: Channel = { el, gain, on: false, stopTimer: undefined }
  // 被外部暫停（Mac 的播放 / 暫停媒體鍵、耳機、控制中心）但遊戲仍要播放時，自動接著播
  el.addEventListener('pause', () => {
    if (!c.on || el.ended || !unlocked || muted || hidden) return
    setTimeout(() => {
      if (c.on && el.paused && !el.ended && !muted && !hidden) void el.play().catch(() => {})
    }, 0)
  })
  channels.set(t, c)
  return c
}

function ramp(ch: Channel, to: number, dur: number) {
  if (!ch.gain) {
    ch.el.volume = to
    return
  }
  const g = ch.gain.gain
  const now = ch.gain.context.currentTime
  g.cancelScheduledValues(now)
  g.setValueAtTime(g.value, now)
  if (dur > 0) g.linearRampToValueAtTime(to, now + dur)
  else g.setValueAtTime(to, now)
}

function apply(fade = FADE) {
  const active = unlocked && !muted && !hidden
  if (active && want) channel(want)
  for (const [t, ch] of channels) {
    const on = active && t === want
    if (on) {
      clearTimeout(ch.stopTimer)
      // play() 必須在使用者互動的事件處理中同步呼叫，所以每次都檢查；只播一次的曲目播完（ended）後不要重播
      if (ch.el.paused && !ch.el.ended) void ch.el.play().catch(() => {})
      if (!ch.on) ramp(ch, MUSIC_VOLUME, fade)
    } else if (ch.on) {
      ramp(ch, 0, fade)
      // 換曲時下次從頭播；靜音 / 切到背景時保留進度
      const rewind = t !== want
      clearTimeout(ch.stopTimer)
      ch.stopTimer = setTimeout(() => {
        ch.el.pause()
        if (rewind) ch.el.currentTime = 0
      }, fade * 1000)
    }
    ch.on = on
  }
}

export const music = {
  // 設定目前要播的曲目。同一個 tick 內多次呼叫只取最後一次（例如再玩一局時 GameView 重新掛載），避免同一首被打斷
  play(t: Track | null) {
    want = t
    clearTimeout(pending)
    pending = setTimeout(() => apply(), 0)
  },
  get current() {
    return want
  },
}

// 第一次互動後才開始播；之後的互動也重試一次，處理 play() 被瀏覽器拒絕的情況
function unlock() {
  unlocked = true
  try {
    audioContext()
  } catch {
    /* 不支援 WebAudio */
  }
  apply()
}

// 背景音樂用 <audio> 播放，瀏覽器會把它登記成作業系統的「正在播放」媒體：Mac 鍵盤的播放 / 暫停 / 上一首 / 下一首媒體鍵、
// AirPods、控制中心都能暫停它。接管 Media Session 並全部設成不做事，遊戲中的聲音就不會被這些按鍵關掉
function claimMediaSession() {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
  if (!ms) return
  const noop = () => {}
  for (const action of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'] as MediaSessionAction[]) {
    try {
      ms.setActionHandler(action, noop)
    } catch {
      /* 瀏覽器不支援這個動作 */
    }
  }
}

if (typeof document !== 'undefined') {
  claimMediaSession()
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'])
    document.addEventListener(type, unlock, { capture: true, passive: true })
  // 切到背景時停止播放（手機省電，也避免在其他分頁出聲）
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden
    apply(0)
  })
  onMuteChange((on) => {
    muted = on
    apply(0)
  })
}
