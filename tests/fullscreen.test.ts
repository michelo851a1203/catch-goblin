import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/game/audio', () => ({ setMuted: vi.fn() }))
// vue 的 DOM runtime 載入時會用到真正的 document，這裡只需要 ref
vi.mock('vue', () => ({ ref: <T>(value: T) => ({ value }) }))
vi.mock('../src/input/touch', () => ({ touchMode: { value: true } }))

// 模擬支援全螢幕的瀏覽器，記錄是否掛上自動重新進入的點擊監聽、是否呼叫 requestFullscreen
async function load(hostname: string) {
  vi.resetModules()
  const listeners: string[] = []
  const requestFullscreen = vi.fn(async () => {})
  vi.stubGlobal('location', { hostname })
  vi.stubGlobal('screen', {})
  vi.stubGlobal('document', {
    fullscreenEnabled: true,
    fullscreenElement: null,
    documentElement: { requestFullscreen },
    addEventListener: (type: string) => listeners.push(type),
    removeEventListener: () => {},
  })
  const fs = await import('../src/input/fullscreen')
  return { fs, listeners, requestFullscreen }
}

describe('fullscreen', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('CrazyGames 上關閉遊戲內全螢幕（全螢幕由平台提供）', async () => {
    const { fs, listeners, requestFullscreen } = await load('elf-and-goblins.game-files.crazygames.com')
    expect(fs.fullscreenSupported).toBe(false)
    await fs.toggleFullscreen()
    expect(requestFullscreen).not.toHaveBeenCalled()
    expect(listeners).not.toContain('click')
  })

  it('Cloudflare Pages 照舊提供全螢幕按鈕', async () => {
    const { fs, requestFullscreen } = await load('elf-and-goblins.pages.dev')
    expect(fs.fullscreenSupported).toBe(true)
    await fs.toggleFullscreen()
    expect(requestFullscreen).toHaveBeenCalled()
  })
})
