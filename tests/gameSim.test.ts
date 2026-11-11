// 對局行為的 golden master：以固定亂數種子跑完整場（單機 AI 對 AI、玩家隨機操作、多人連線），
// 逐步記錄所有遊戲狀態、事件、音效與網路訊息的雜湊。重構時這些雜湊必須完全不變。
// 有意調整遊戲行為（平衡、AI）後，以 UPDATE_GOLDEN=1 bun run test 重新產生；DUMP_SIM=<dir> 會輸出逐步紀錄方便比對。
import './sim/env'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

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
  }
  class FakePMREM {
    fromScene() {
      return { texture: new THREE.Texture() }
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
vi.setConfig({ testTimeout: 60000 })

const { makeGame, runMultiplayer, runSolo } = await import('./sim/harness')
const { sfxLog } = await import('./sim/sfxLog')
type RunResult = ReturnType<typeof runSolo>

// 第一次建立 Game 會填充模組層級的快取（貼圖、材質），途中可能用到亂數：先各跑一次暖機，
// 讓每個情境的結果不受測試執行順序影響
// three 的 generateUUID 也用 Math.random，快取命中與否會改變亂數序列。
for (const kind of ['harp', 'violin'] as const) {
  runSolo({ role: 'elf', kind, seed: 99, mode: 'player', duration: 5 })
  runMultiplayer({ kind, seed: 99, clientSlot: 'elf', duration: 5 })
}
{
  // 「POW」貼圖依文字＋顏色快取（見 Game.present 裡所有的 fx.pow 呼叫）
  const { FxSystem } = await import('../src/game/fx/Effects')
  const { t } = await import('../src/i18n')
  const { Scene, Vector3 } = await import('three')
  const fx = new FxSystem(new Scene())
  for (const [text, fill] of [[t('fBonk'), '#ffd23f'], [t('fFree'), '#8ff27a'], ['POW!', '#ffd23f'], [t('fBonk'), '#d8a8ff']]) fx.pow(new Vector3(), text, fill)
  fx.dispose()
}

const GOLDEN = resolve(__dirname, '__golden__/gameSim.json')
const update = !!process.env.UPDATE_GOLDEN
const dump = process.env.DUMP_SIM
let golden: Record<string, string> = {}
try {
  golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
} catch {
  /* 第一次產生 */
}
const fresh: Record<string, string> = {}

function check(name: string, r: RunResult) {
  if (dump && r.lines) {
    mkdirSync(dump, { recursive: true })
    writeFileSync(join(dump, `${name}.jsonl`), r.lines.join('\n'))
  }
  fresh[name] = r.hash
  expect(r.violations, `${name} 出現不合法的狀態組合`).toEqual([])
  if (process.env.SIM_STATS) console.log(name, r.steps, r.winner, JSON.stringify(r.stats), r.violations)
  if (update) {
    golden[name] = r.hash
    mkdirSync(resolve(__dirname, '__golden__'), { recursive: true })
    writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n')
    return
  }
  expect(golden[name], `缺少 golden：${name}（以 UPDATE_GOLDEN=1 產生）`).toBeTruthy()
  expect(r.hash, `${name} 的對局行為改變了`).toBe(golden[name])
}

const keep = !!dump

// 狀態不變式：隱式狀態機不該出現的組合
import type { Game } from '../src/game/Game'
function invariants(game: Game): string | null {
  const e = game.elf
  const acts = [e.packing && 'packing', e.channel >= 0 && 'channel', e.stealthCast >= 0 && 'stealthCast', e.charge && 'charge'].filter(Boolean)
  if (acts.length > 1) return `精靈同時處於 ${acts.join('+')}`
  if (e.stealthed && e.stealthCast >= 0) return '隱身中又在拉琴準備隱身'
  for (const g of game.goblins) if (g.captured && g.held) return `哥布林 ${g.id} 同時 captured 與 held`
  if (game.authority) {
    if (e.packing && (!e.packing.g.held || e.packing.g.captured)) return `打包中的哥布林 ${e.packing.g.id} 不是 held`
    for (const g of game.goblins) if (g.held && e.packing?.g !== g) return `哥布林 ${g.id} held 但沒有被打包`
  }
  return null
}
const INV = [invariants]
const SEEDS = [1, 2, 3]

describe('對局 golden master（單機）', () => {
  for (const kind of ['harp', 'violin'] as const)
    for (const seed of SEEDS) {
      it(`AI 對 AI：${kind} #${seed}`, () => {
        const r = runSolo({ role: 'elf', kind, seed, mode: 'ai', keep, invariants: INV })
        // 要真的打過：有捕獲、有對局結果
        expect(r.winner).not.toBeNull()
        check(`ai-${kind}-${seed}`, r)
      })
      it(`精靈玩家隨機操作：${kind} #${seed}`, () => check(`elf-player-${kind}-${seed}`, runSolo({ role: 'elf', kind, seed, mode: 'player', keep, invariants: INV })))
      it(`哥布林玩家隨機操作：${kind} #${seed}`, () => check(`goblin-player-${kind}-${seed}`, runSolo({ role: 'goblin', kind, seed, mode: 'player', keep, invariants: INV })))
    }
})

describe('對局 golden master（長局，精靈有機會獲勝）', () => {
  for (const kind of ['harp', 'violin'] as const)
    for (const seed of [1, 4]) it(`AI 對 AI 10 分鐘：${kind} #${seed}`, () => check(`ai-long-${kind}-${seed}`, runSolo({ role: 'elf', kind, seed, mode: 'ai', duration: 600, keep, invariants: INV })))
})

describe('對局 golden master（多人）', () => {
  for (const kind of ['harp', 'violin'] as const)
    for (const seed of SEEDS.slice(0, 2)) {
      it(`加入者當精靈：${kind} #${seed}`, () => check(`mp-elf-${kind}-${seed}`, runMultiplayer({ kind, seed, clientSlot: 'elf', keep, invariants: INV })))
      it(`加入者當哥布林：${kind} #${seed}`, () => check(`mp-goblin-${kind}-${seed}`, runMultiplayer({ kind, seed, clientSlot: 2, keep, invariants: INV })))
      it(`房主 AI 精靈抓加入者：${kind} #${seed}`, () => check(`mp-ai-${kind}-${seed}`, runMultiplayer({ kind, seed, clientSlot: 1, hostAi: true, duration: 300, keep, invariants: INV })))
      it(`加入者斷線後重連：${kind} #${seed}`, () =>
        check(`mp-rejoin-${kind}-${seed}`, runMultiplayer({ kind, seed, clientSlot: 3, leaveAt: 900, rejoinAt: 1500, keep, invariants: INV })))
    }
})

it('同一個種子跑兩次結果相同（確認模擬是確定性的）', () => {
  const a = runSolo({ role: 'elf', kind: 'violin', seed: 7, mode: 'player', duration: 40 })
  const b = runSolo({ role: 'elf', kind: 'violin', seed: 7, mode: 'player', duration: 40 })
  expect(a.hash).toBe(b.hash)
  const c = runMultiplayer({ kind: 'harp', seed: 7, clientSlot: 'elf', duration: 30 })
  const d = runMultiplayer({ kind: 'harp', seed: 7, clientSlot: 'elf', duration: 30 })
  expect(c.hash).toBe(d.hash)
})

it('golden 沒有多餘的項目', () => {
  if (update) return
  expect(Object.keys(golden).sort()).toEqual(Object.keys(fresh).sort())
})

describe('CrazyGames 遊玩狀態回報', () => {
  // 房主的連線介面（沒有其他玩家）
  const hostLink = () => ({
    host: true, me: 'elf' as const, elfKind: 'harp' as const, peers: new Map(), numbers: new Map(), names: new Map(),
    send() {}, listen: () => () => {}, onLeave: () => () => {}, onRejoin: () => () => {},
  })
  const cg = () => sfxLog.filter((s) => s.startsWith('cg:'))
  const run = (game: ReturnType<typeof makeGame>, sec: number) => {
    for (let i = 0; i < sec * 30; i++) (game as unknown as { tick(dt: number, r: boolean): void }).tick(1 / 30, false)
  }

  it('多人連線中暫停時倒數結束：暫停期間不回報遊玩中，恢復後才回報', () => {
    const game = makeGame('elf', 'harp', hostLink())
    sfxLog.length = 0
    game.pause('hidden')
    run(game, 4) // 多人連線暫停時模擬照跑，倒數在暫停中結束
    expect(game.hud.phase).toBe('play')
    expect(cg()).not.toContain('cg:start')
    game.resume('hidden')
    expect(cg().at(-1)).toBe('cg:start')
    game.pause('portrait')
    expect(cg().at(-1)).toBe('cg:stop')
    game.dispose()
  })

  it('單機：開局回報遊玩中、暫停 / 恢復切換、離開時停止', () => {
    const game = makeGame('elf', 'harp')
    sfxLog.length = 0
    run(game, 4)
    expect(cg()).toEqual(['cg:start'])
    game.pause('hidden')
    game.pause('portrait')
    game.resume('hidden')
    expect(cg().at(-1)).toBe('cg:stop') // 還有一個暫停原因
    game.resume('portrait')
    expect(cg().at(-1)).toBe('cg:start')
    game.dispose()
    expect(cg().at(-1)).toBe('cg:stop')
  })
})

describe('紫晶精靈隱身的狀態轉移', () => {
  const run = (game: ReturnType<typeof makeGame>, sec: number) => {
    for (let i = 0; i < Math.round(sec * 30); i++) (game as unknown as { tick(dt: number, r: boolean): void }).tick(1 / 30, false)
  }
  // 開局、拉琴進入隱身，並把一隻哥布林放在精靈身邊（恐懼範圍內）
  function stealthed() {
    const game = makeGame('elf', 'violin')
    run(game, 4)
    expect(game.violinStealth()).toBe(true)
    run(game, 1)
    expect(game.elf.stealthed).toBe(true)
    expect(game.elf.stealthCast).toBe(-1)
    const g = game.goblins[0]
    g.pos.copy(game.elf.pos).add({ x: 2, y: 0, z: 0 } as never)
    return { game, g }
  }

  it('時間到自然現身：進入冷卻，不嚇到身邊的哥布林', () => {
    const { game, g } = stealthed()
    game.elf.stealth = 0.05
    run(game, 0.1)
    expect(game.elf.stealthed).toBe(false)
    expect(game.elf.cd.stealth).toBeGreaterThan(11.8)
    expect(g.terror).toBe(0)
    game.dispose()
  })

  it('隱身中再按一次手動現身：進入冷卻並嚇到身邊的哥布林', () => {
    const { game, g } = stealthed()
    expect(game.violinStealth()).toBe(true)
    expect(game.elf.stealthed).toBe(false)
    expect(game.elf.cd.stealth).toBe(12)
    expect(g.terror).toBe(3)
    game.dispose()
  })
})
