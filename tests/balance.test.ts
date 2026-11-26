// 地圖平衡量測（預設不執行）：以無頭 AI 對 AI 模擬，比較兩張地圖的精靈勝率。
// BALANCE=1 BAL_MAP=mushroom BAL_KIND=harp BAL_VARIANT=ai BAL_N=48 BAL_SEED=1000 BAL_SHORT=1 BAL_OUT=file npx vitest run tests/balance.test.ts
// variant：ai＝AI 精靈速度；player＝AI 精靈換成玩家速度（近似真人操控精靈）
import './sim/env'
import { appendFileSync } from 'node:fs'
import { describe, it, vi } from 'vitest'

vi.mock('three', async (importOriginal) => {
  const THREE = await importOriginal<typeof import('three')>()
  class FakeRenderer {
    shadowMap = { enabled: false, type: 0 }
    domElement = (globalThis as unknown as { document: Document }).document.createElement('canvas')
    setPixelRatio() {}
    getPixelRatio() {
      return 1
    }
    setSize() {}
    render() {}
    dispose() {}
    forceContextLoss() {}
  }
  class FakePMREM {
    fromScene() {
      return { texture: new THREE.Texture(), dispose() {} }
    }
    dispose() {}
  }
  return { ...THREE, WebGLRenderer: FakeRenderer, PMREMGenerator: FakePMREM }
})
vi.mock('three/addons/effects/OutlineEffect.js', () => ({
  OutlineEffect: class {
    render() {}
  },
}))
// GLB 在 Node 讀不到：精靈維持程序化替身（與遊戲邏輯無關）
vi.mock('../src/game/elf/ElfCharacter', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/game/elf/ElfCharacter')>()
  class HeadlessElfCharacter extends mod.ElfCharacter {
    constructor(opts: ConstructorParameters<typeof mod.ElfCharacter>[0] = {}) {
      super({ ...opts, autoLoad: false, lowEnd: true })
    }
  }
  return { ...mod, ElfCharacter: HeadlessElfCharacter }
})
vi.mock('../src/game/audio', async () => {
  const { sfxLog } = await import('./sim/sfxLog')
  const sfx = new Proxy({} as Record<string, (...a: unknown[]) => void>, {
    get: (_, name: string) => (...args: unknown[]) => void sfxLog.push(args.length ? `${name}(${args.join(',')})` : name),
  })
  return {
    sfx,
    setMuted() {},
    onMuteChange() {},
    audioContext() {
      throw new Error('no audio')
    },
  }
})

// CrazyGames 的 gameplayStart / gameplayStop 也納入紀錄（SDK 不存在時原本就是 no-op）
vi.mock('../src/crazygames', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/crazygames')>()
  const { sfxLog } = await import('./sim/sfxLog')
  return {
    ...mod,
    gameplayStart: () => void sfxLog.push('cg:start'),
    gameplayStop: () => void sfxLog.push('cg:stop'),
  }
})
vi.setConfig({ testTimeout: 3_600_000 })

const env = process.env
describe.runIf(!!env.BALANCE)('地圖平衡', () => {
  it('量測精靈勝率', async () => {
    // 短局版（itch.io / CrazyGames）的設定：要在載入 config 之前改網域
    if (env.BAL_SHORT) (globalThis as unknown as { location: { hostname: string } }).location.hostname = 'html-classic.itch.zone'
    const { CONFIG } = await import('../src/game/config')
    const { runSolo } = await import('./sim/harness')
    // BAL_TUNE='{"vents":2}'：暫時覆寫蘑菇秘境的平衡參數
    if (env.BAL_TUNE) Object.assign((await import('../src/game/mushroomWorld')).MUSHROOM_TUNE, JSON.parse(env.BAL_TUNE))
    const map = (env.BAL_MAP ?? 'meadow') as 'meadow' | 'mushroom'
    const kind = (env.BAL_KIND ?? 'harp') as 'harp' | 'violin'
    if (env.BAL_VARIANT === 'player') {
      CONFIG.elf.aiSpeed = CONFIG.elf.speed
      CONFIG.violin.aiSpeed = CONFIG.elf.speed
    }
    const n = Number(env.BAL_N ?? 16)
    const seed0 = Number(env.BAL_SEED ?? 1000)
    const duration = CONFIG.matchDuration
    let wins = 0
    for (let i = 0; i < n; i++) {
      const r = runSolo({ role: 'elf', kind, seed: seed0 + i, mode: 'ai', duration, map })
      if (r.winner === 'elf') wins++
      const line = JSON.stringify({ tune: env.BAL_TUNE ?? '', map, kind, variant: env.BAL_VARIANT ?? 'ai', short: !!env.BAL_SHORT, seed: seed0 + i, winner: r.winner, steps: r.steps, caught: r.stats['solo:caught'] ?? 0, warps: r.stats['solo:warp'] ?? 0 })
      if (env.BAL_OUT) appendFileSync(env.BAL_OUT, line + '\n')
    }
    console.log(`${map} ${kind} ${env.BAL_VARIANT ?? 'ai'}: ${wins}/${n}`)
  })
})
