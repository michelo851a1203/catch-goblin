// CrazyGames 版的短局設定（4 分鐘、6 隻哥布林、小地圖、最終狩獵）只在 CrazyGames 網域生效，網站版維持原本的長局
import { afterEach, describe, expect, it, vi } from 'vitest'

async function configOn(hostname: string) {
  vi.resetModules()
  vi.stubGlobal('location', { hostname })
  return (await import('../src/game/config')).CONFIG
}

afterEach(() => vi.unstubAllGlobals())

describe('平台對局設定', () => {
  it('CrazyGames：4 分鐘、7 隻哥布林、地圖縮小、最後 70 秒最終狩獵、紫晶精靈加強', async () => {
    const c = await configOn('run-goblins.game-files.crazygames.com')
    expect(c.matchDuration).toBe(240)
    expect(c.goblinCount).toBe(7)
    expect(c.finalHunt).toBe(70)
    expect(c.mapScale).toBe(0.7)
    expect(c.worldRadius).toBe(80)
    expect(c.elf.aiSpeed).toBe(6.8)
    expect(c.violin.stealth).toMatchObject({ cooldown: 8, fearRadius: 12, fearTime: 4.5 })
    expect(c.violin.eye.cooldown).toBe(10)
    expect(c.violin.charge).toMatchObject({ cooldown: 3.5, stun: 2 })
    expect(c.violin.aiEyeAfter).toBe(5)
  })

  it('網站版（Cloudflare Pages）維持 10 分鐘、8 隻、無最終狩獵', async () => {
    const c = await configOn('elf-and-goblins.pages.dev')
    expect(c.matchDuration).toBe(600)
    expect(c.goblinCount).toBe(8)
    expect(c.finalHunt).toBe(0)
    expect(c.mapScale).toBe(1)
    expect(c.worldRadius).toBe(115)
    expect(c.elf.aiSpeed).toBe(6.2)
    expect(c.violin.stealth).toMatchObject({ cooldown: 12, fearRadius: 8, fearTime: 3 })
    expect(c.violin.eye.cooldown).toBe(20)
    expect(c.violin.charge).toMatchObject({ cooldown: 7, stun: 1.5 })
    expect(c.violin.aiEyeAfter).toBe(25)
  })
})

describe('哥布林出生山洞', () => {
  it('8 隻沿用原本的分配', async () => {
    vi.resetModules()
    const { goblinCaves } = await import('../src/game/Game')
    expect(goblinCaves(8, 5)).toEqual([0, 0, 1, 1, 2, 2, 3, 4])
  })

  it('7 隻：每座洞至少一隻，玩家的 0 號洞有同伴', async () => {
    vi.resetModules()
    const { goblinCaves } = await import('../src/game/Game')
    const d = goblinCaves(7, 5)
    expect(d).toEqual([0, 1, 2, 3, 4, 0, 1])
    expect(new Set(d).size).toBe(5)
  })
})
