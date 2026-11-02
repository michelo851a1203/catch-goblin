import { beforeEach, describe, expect, it, vi } from 'vitest'

const setMuted = vi.fn()
vi.mock('../src/game/audio', () => ({ setMuted }))

type Callbacks = { adStarted(): void; adFinished(): void; adError(e: unknown): void }

function fakeSdk(environment = 'crazygames') {
  return {
    environment,
    init: vi.fn(async () => {}),
    ad: { requestAd: vi.fn() as ReturnType<typeof vi.fn> },
    game: { loadingStart: vi.fn(), loadingStop: vi.fn(), gameplayStart: vi.fn(), gameplayStop: vi.fn(), settings: { muteAudio: false } },
    user: { isUserAccountAvailable: false, getUser: vi.fn() },
    data: { getItem: vi.fn(() => 'saved'), setItem: vi.fn() },
  }
}

async function load(sdk?: ReturnType<typeof fakeSdk>) {
  vi.resetModules()
  vi.stubGlobal('window', { CrazyGames: sdk ? { SDK: sdk } : undefined, setTimeout, clearTimeout })
  const cg = await import('../src/crazygames')
  await cg.init()
  return cg
}

describe('crazygames', () => {
  beforeEach(() => setMuted.mockClear())

  it('沒有 SDK 時全部是 no-op，廣告直接放行', async () => {
    const cg = await load()
    cg.gameplayStart()
    await expect(cg.commercialBreak()).resolves.toBeUndefined()
    expect(setMuted).not.toHaveBeenCalled()
  })

  it('其他網域（disabled）不呼叫 SDK', async () => {
    const sdk = fakeSdk('disabled')
    const cg = await load(sdk)
    cg.gameplayStart()
    expect(sdk.game.gameplayStart).not.toHaveBeenCalled()
  })

  it('gameplayStart / Stop 不重複送出', async () => {
    const sdk = fakeSdk()
    const cg = await load(sdk)
    cg.gameplayStart()
    cg.gameplayStart()
    cg.gameplayStop()
    cg.gameplayStop()
    expect(sdk.game.gameplayStart).toHaveBeenCalledTimes(1)
    expect(sdk.game.gameplayStop).toHaveBeenCalledTimes(1)
  })

  it('廣告真的開始才靜音，結束後恢復', async () => {
    const sdk = fakeSdk()
    let cb!: Callbacks
    sdk.ad.requestAd.mockImplementation((_: string, c: Callbacks) => (cb = c))
    const cg = await load(sdk)
    setMuted.mockClear()
    const p = cg.commercialBreak()
    await Promise.resolve()
    await Promise.resolve()
    expect(setMuted).not.toHaveBeenCalled()
    cb.adStarted()
    expect(setMuted).toHaveBeenLastCalledWith(true)
    cb.adFinished()
    await p
    expect(setMuted).toHaveBeenLastCalledWith(false)
  })

  it('沒有廣告（adError）時直接繼續', async () => {
    const sdk = fakeSdk()
    sdk.ad.requestAd.mockImplementation((_: string, c: Callbacks) => c.adError({ code: 'unfilled' }))
    const cg = await load(sdk)
    await expect(cg.commercialBreak()).resolves.toBeUndefined()
  })

  it('平台靜音設定優先：廣告結束後仍維持靜音', async () => {
    const sdk = fakeSdk()
    sdk.game.settings.muteAudio = true
    sdk.ad.requestAd.mockImplementation((_: string, c: Callbacks) => c.adFinished())
    const cg = await load(sdk)
    await cg.commercialBreak()
    expect(setMuted).toHaveBeenLastCalledWith(true)
  })

  it('存檔走 SDK，失敗時退回 localStorage', async () => {
    const sdk = fakeSdk()
    const local = { getItem: vi.fn(() => 'local'), setItem: vi.fn() }
    vi.stubGlobal('localStorage', local)
    const cg = await load(sdk)
    expect(cg.store.getItem('k')).toBe('saved')
    sdk.data.getItem.mockImplementation(() => {
      throw new Error('dataModuleDisabled')
    })
    expect(cg.store.getItem('k')).toBe('local')
  })
})
