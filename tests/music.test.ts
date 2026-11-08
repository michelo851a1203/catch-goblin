import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 替身：<audio>、WebAudio、document 事件
class FakeAudio {
  static all: FakeAudio[] = []
  paused = true
  ended = false
  _t = 0
  get currentTime() {
    return this._t
  }
  // 跟瀏覽器一樣：移動播放位置會清除 ended
  set currentTime(v: number) {
    this._t = v
    this.ended = false
  }
  loop = false
  preload = ''
  volume = 1
  dataset: Record<string, string> = {}
  play = vi.fn(async () => {
    if (this.ended) this.currentTime = 0
    this.paused = false
  })
  finish() {
    this.paused = true
    this.ended = true
  }
  // 瀏覽器在暫停後觸發 pause 事件
  listeners: Record<string, (() => void)[]> = {}
  addEventListener(type: string, fn: () => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  pause = vi.fn(() => {
    this.paused = true
    for (const fn of this.listeners.pause ?? []) fn()
  })
  constructor(public src: string) {
    FakeAudio.all.push(this)
  }
}

function fakeGain() {
  const param = {
    value: 0,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn((v: number) => (param.value = v)),
    // 測試只關心最後的目標音量
    linearRampToValueAtTime: vi.fn((v: number) => (param.value = v)),
  }
  const node = { gain: param, context: { currentTime: 0 }, connect: vi.fn((n: unknown) => n) }
  return node
}

let muteFn: (on: boolean) => void = () => {}
vi.mock('../src/game/audio', () => ({
  audioContext: () => ({
    destination: {},
    createGain: fakeGain,
    createMediaElementSource: () => ({ connect: (n: unknown) => n }),
  }),
  onMuteChange: (fn: (on: boolean) => void) => {
    muteFn = fn
    fn(false)
  },
}))

let handlers: Record<string, () => void> = {}
const doc = { hidden: false, addEventListener: (type: string, fn: () => void) => (handlers[type] = fn) }

async function load() {
  vi.resetModules()
  handlers = {}
  FakeAudio.all = []
  doc.hidden = false
  vi.stubGlobal('document', doc)
  vi.stubGlobal('Audio', FakeAudio)
  return (await import('../src/game/music')).music
}

const playing = () => FakeAudio.all.filter((a) => !a.paused).map((a) => a.src.split('/').pop())
const track = (name: string) => FakeAudio.all.find((a) => a.src.endsWith(name))!

describe('背景音樂', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('使用者互動前不播放，互動後播放主選單音樂並循環', async () => {
    const music = await load()
    music.play('menu')
    vi.runAllTimers()
    expect(FakeAudio.all).toHaveLength(0)
    handlers.pointerdown()
    expect(playing()).toEqual(['menu.mp3'])
    expect(track('menu.mp3').loop).toBe(true)
  })

  it('依陣營切換曲目：舊曲淡出後暫停並倒回開頭', async () => {
    const music = await load()
    music.play('menu')
    handlers.pointerdown()
    track('menu.mp3').currentTime = 42
    music.play('elf')
    vi.advanceTimersByTime(1)
    expect(playing()).toEqual(['menu.mp3', 'elf.mp3']) // 淡出中，交叉淡入
    vi.advanceTimersByTime(1000)
    expect(playing()).toEqual(['elf.mp3'])
    expect(track('menu.mp3').currentTime).toBe(0)

    music.play('menu')
    vi.advanceTimersByTime(1000)
    music.play('goblin')
    vi.advanceTimersByTime(1000)
    expect(playing()).toEqual(['goblin.mp3'])
  })

  it('同一個 tick 內換回原曲（再玩一局）不會中斷', async () => {
    const music = await load()
    music.play('elf')
    handlers.pointerdown()
    const elf = track('elf.mp3')
    elf.currentTime = 30
    music.play('menu')
    music.play('elf')
    vi.advanceTimersByTime(2000)
    expect(playing()).toEqual(['elf.mp3'])
    expect(elf.pause).not.toHaveBeenCalled()
    expect(elf.currentTime).toBe(30)
    expect(FakeAudio.all.some((a) => a.src.endsWith('menu.mp3'))).toBe(false)
  })

  it('被外部暫停（Mac 媒體鍵、耳機、控制中心）時自動接著播', async () => {
    const music = await load()
    music.play('goblin')
    handlers.pointerdown()
    vi.runAllTimers()
    const el = track('goblin.mp3')
    el.pause()
    expect(el.paused).toBe(true)
    vi.advanceTimersByTime(1)
    expect(playing()).toEqual(['goblin.mp3'])
  })

  it('Media Session：媒體鍵的播放 / 暫停等動作都被接管成不做事', async () => {
    const actions: string[] = []
    vi.stubGlobal('navigator', { mediaSession: { setActionHandler: (a: string) => actions.push(a) } })
    await load()
    expect(actions).toEqual(expect.arrayContaining(['play', 'pause', 'stop', 'previoustrack', 'nexttrack']))
  })

  it('靜音（廣告 / 平台設定）時暫停，解除後從原位置繼續', async () => {
    const music = await load()
    music.play('goblin')
    handlers.pointerdown()
    const g = track('goblin.mp3')
    g.currentTime = 12
    muteFn(true)
    vi.advanceTimersByTime(10)
    expect(playing()).toEqual([])
    expect(g.currentTime).toBe(12)
    muteFn(false)
    expect(playing()).toEqual(['goblin.mp3'])
  })

  it('切到背景時暫停，回來後繼續', async () => {
    const music = await load()
    music.play('menu')
    handlers.keydown()
    doc.hidden = true
    handlers.visibilitychange()
    vi.advanceTimersByTime(10)
    expect(playing()).toEqual([])
    doc.hidden = false
    handlers.visibilitychange()
    expect(playing()).toEqual(['menu.mp3'])
  })

  it('play() 被瀏覽器拒絕時，下一次互動會重試', async () => {
    const music = await load()
    music.play('menu')
    vi.runAllTimers()
    handlers.pointerdown()
    const m = track('menu.mp3')
    m.paused = true // 模擬 play() 失敗
    handlers.touchend()
    expect(m.play).toHaveBeenCalledTimes(2)
    expect(playing()).toEqual(['menu.mp3'])
  })

  it('勝利音樂只播一次：播完後點擊不重播，下一次獲勝再從頭播', async () => {
    const music = await load()
    music.play('elf')
    handlers.pointerdown()
    music.play('elfWin')
    vi.advanceTimersByTime(1000)
    expect(playing()).toEqual(['elf-win.mp3'])
    const win = track('elf-win.mp3')
    expect(win.loop).toBe(false)

    win.finish()
    handlers.pointerdown()
    handlers.touchend()
    expect(win.play).toHaveBeenCalledTimes(1)
    expect(playing()).toEqual([])

    // 再玩一局 → 又是精靈獲勝
    music.play('elf')
    vi.advanceTimersByTime(1000)
    music.play('elfWin')
    vi.advanceTimersByTime(1)
    expect(win.play).toHaveBeenCalledTimes(2)
    expect(playing()).toContain('elf-win.mp3')
  })

  it('哥布林勝利播哥布林勝利音樂，回選單換回主選單音樂', async () => {
    const music = await load()
    music.play('goblin')
    handlers.pointerdown()
    music.play('goblinWin')
    vi.advanceTimersByTime(1000)
    expect(playing()).toEqual(['goblin-win.mp3'])
    music.play('menu')
    vi.advanceTimersByTime(1000)
    expect(playing()).toEqual(['menu.mp3'])
    expect(track('goblin-win.mp3').currentTime).toBe(0)
  })
})
