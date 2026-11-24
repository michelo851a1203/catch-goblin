// 平台判斷：以網域區分 CrazyGames / itch.io / 網站版，決定短局玩法與入口站限制（不用 Esc、不鎖定滑鼠、不顯示加入主畫面）
import { afterEach, describe, expect, it, vi } from 'vitest'

async function platformOn(hostname: string) {
  vi.resetModules()
  vi.stubGlobal('location', { hostname })
  return import('../src/platform')
}

afterEach(() => vi.unstubAllGlobals())

describe('平台判斷', () => {
  it('itch.io 的 iframe 網域', async () => {
    const { onItch } = await platformOn('')
    for (const h of ['html-classic.itch.zone', 'v6p9d9t4.itch.zone', 'someone.itch.io', 'itch.io']) expect(onItch(h), h).toBe(true)
    for (const h of ['itch.zone.evil.com', 'notitch.io', 'elf-and-goblins.pages.dev', 'localhost', '']) expect(onItch(h), h).toBe(false)
  })

  it('itch.io：短局 + 入口站限制，但不是 CrazyGames', async () => {
    const p = await platformOn('html-classic.itch.zone')
    expect(p.isItch).toBe(true)
    expect(p.isCrazyGames).toBe(false)
    expect(p.isShortSession).toBe(true)
    expect(p.isEmbedded).toBe(true)
  })

  it('CrazyGames：短局 + 入口站限制', async () => {
    const p = await platformOn('run-goblins.game-files.crazygames.com')
    expect(p.isCrazyGames).toBe(true)
    expect(p.isItch).toBe(false)
    expect(p.isShortSession).toBe(true)
    expect(p.isEmbedded).toBe(true)
  })

  it('網站版：長局、沒有入口站限制', async () => {
    const p = await platformOn('elf-and-goblins.pages.dev')
    expect(p.isCrazyGames).toBe(false)
    expect(p.isItch).toBe(false)
    expect(p.isShortSession).toBe(false)
    expect(p.isEmbedded).toBe(false)
  })
})
