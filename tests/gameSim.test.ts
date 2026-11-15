// 對局行為的 golden master：以固定亂數種子跑完整場（單機 AI 對 AI、玩家隨機操作、多人連線），
// 逐步記錄所有遊戲狀態、事件、音效與網路訊息的雜湊。重構時這些雜湊必須完全不變。
// 有意調整遊戲行為（平衡、AI）後，以 UPDATE_GOLDEN=1 bun run test 重新產生；DUMP_SIM=<dir> 會輸出逐步紀錄方便比對。
// 數學函式換成跨平台結果一致的版本（tests/sim/detMath），本機（arm64）產生的 golden 在 CI（x64）上才會相同。
import './sim/env'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.setConfig({ testTimeout: 60000 })
// 每個模擬都是同步的長迴圈，vitest 在同一個檔案的測試之間不會讓出事件迴圈：整個檔案（CI 上約 2 分鐘）等於一段同步程式，
// worker 回不了主行程的 RPC，超過 60 秒就報「Timeout calling "onTaskUpdate"」讓 CI 失敗（測試本身都通過）。
// 每個測試開始前讓出一次（setImmediate 會先處理 I/O），RPC 就能即時回應；不影響亂數與 golden
beforeEach(() => new Promise<void>((r) => setImmediate(r)))

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
  if (game.hud.phase === 'over' && acts.length) return `結算後精靈仍在 ${acts.join('+')}`
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

describe('時間到結算時精靈正在打包', () => {
  const run = (game: ReturnType<typeof makeGame>, sec: number) => {
    for (let i = 0; i < Math.round(sec * 30); i++) (game as unknown as { tick(dt: number, r: boolean): void }).tick(1 / 30, false)
  }

  it('哥布林獲勝後不會再被抓走：打包中止、哥布林放開、沒有 caught 事件', () => {
    const game = makeGame('elf', 'harp')
    const G = game as unknown as { present(ev: { e: string }): void; duration: number }
    const events: string[] = []
    const orig = G.present.bind(game)
    G.present = (ev) => (events.push(ev.e), orig(ev))
    run(game, 4)
    expect(game.hud.phase).toBe('play')
    const g = game.goblins[0]
    g.pos.copy(game.elf.pos).add({ x: 1, y: 0, z: 0 } as never)
    g.stun = 3
    expect(game.elfStartCapture()).toBe(true)
    expect(g.held).toBe(true)
    // 打包還要好幾秒，比賽只剩 0.3 秒
    game.elapsed = G.duration - 0.3
    run(game, 8)
    expect(game.hud.result?.winner).toBe('goblin')
    expect(events).not.toContain('caught')
    expect(g.captured).toBe(false)
    expect(g.held).toBe(false)
    expect(game.elf.packing).toBeNull()
    expect(game.elf.action).toBe('idle')
    game.dispose()
  })

  it('彈奏中時間到：結算後不再彈奏', () => {
    const game = makeGame('elf', 'harp')
    const G = game as unknown as { duration: number }
    run(game, 4)
    expect(game.elfStartMusic()).toBe(true)
    game.elapsed = G.duration - 0.1
    run(game, 1)
    expect(game.hud.phase).toBe('over')
    expect(game.elf.channel).toBe(-1)
    game.dispose()
  })
})

describe('開局前的載入', () => {
  const settled = async (p: Promise<unknown>) => {
    let done = false
    void p.then(() => (done = true))
    for (let i = 0; i < 10; i++) await Promise.resolve()
    return done
  }
  const link = (host: boolean) => {
    const fns = new Set<(from: string, m: { t: string }) => void>()
    return {
      fns,
      link: {
        host, me: (host ? 'elf' : 0) as 'elf' | 0, elfKind: 'harp' as const, peers: new Map(), numbers: new Map(), names: new Map(),
        send() {}, listen: (fn: (from: string, m: { t: string }) => void) => (fns.add(fn), () => fns.delete(fn)), onLeave: () => () => {}, onRejoin: () => () => {},
      },
    }
  }

  it('角色模型就緒後才能開始（單機、房主）', async () => {
    const solo = makeGame('elf', 'harp')
    expect(await settled(solo.ready)).toBe(true)
    const host = makeGame('elf', 'harp', link(true).link)
    expect(await settled(host.ready)).toBe(true)
    solo.dispose()
    host.dispose()
  })

  it('多人加入者：收到房主的第一個快照（房主已開始）才開始', async () => {
    const { link: l, fns } = link(false)
    const client = makeGame('goblin', 'harp', l)
    expect(await settled(client.ready)).toBe(false)
    const host = makeGame('elf', 'harp', link(true).link)
    const snap = (host as unknown as { snapshot(): object }).snapshot()
    for (const fn of fns) fn('host', JSON.parse(JSON.stringify(snap)))
    expect(await settled(client.ready)).toBe(true)
    client.dispose()
    host.dispose()
  })
})

describe('對局結束釋放 GPU 資源', () => {
  it('共用的卡通材質 / 貼圖會 dispose（讓舊 renderer 不再被參照），並釋放 WebGL context', async () => {
    const { toon, toonGradient } = await import('../src/game/toon')
    const { particleAtlas } = await import('../src/game/fx/atlas')
    const game = makeGame('elf', 'harp')
    const shared = [toon(0x7bbf3a), toonGradient(), particleAtlas()]
    const fired = shared.map(() => false)
    shared.forEach((o, i) => o.addEventListener('dispose', () => (fired[i] = true)))
    const r = (game as unknown as { renderer: { forceContextLoss(): void } }).renderer
    const lost = vi.spyOn(r, 'forceContextLoss')
    ;(window as unknown as { __game?: unknown }).__game = game
    game.dispose()
    expect(fired).toEqual([true, true, true])
    expect(lost).toHaveBeenCalledOnce()
    expect((window as unknown as { __game?: unknown }).__game).toBeUndefined()
  })
})

describe('哥布林生命週期', async () => {
  const { Goblin, Elf } = await import('../src/game/entities')
  it('逃竄 → 打包 → 放開 → 打包 → 捕獲；held 與 captured 不會同時成立', () => {
    const g = new Goblin(0, 'g', 0)
    expect(g.life).toBe('roaming')
    g.grab()
    expect([g.held, g.captured]).toEqual([true, false])
    g.release()
    expect(g.life).toBe('roaming')
    g.grab()
    g.capture()
    expect([g.held, g.captured]).toEqual([false, true])
  })

  it('已捕獲是終態：不能再被打包或放開', () => {
    const g = new Goblin(0, 'g', 0)
    g.capture()
    g.grab()
    g.release()
    expect(g.life).toBe('captured')
  })

  it('套用房主快照：captured 優先於 held', () => {
    const g = new Goblin(0, 'g', 0)
    g.syncLife(false, true)
    expect(g.life).toBe('held')
    g.syncLife(true, true)
    expect(g.life).toBe('captured')
    g.syncLife(false, false)
    expect(g.life).toBe('roaming')
  })

  it('精靈打包與哥布林 held 成對變動；結算時中止打包並放開', () => {
    const elf = new Elf('harp')
    const g = new Goblin(0, 'g', 0)
    elf.startPacking(g, 2)
    expect(g.held).toBe(true)
    elf.startChannel()
    elf.resetForResult()
    expect(elf.packing).toBeNull()
    expect(elf.channel).toBe(-1)
    expect(g.life).toBe('roaming')
  })
})

describe('頭上的進度條', async () => {
  const { setBarProgress, Goblin } = await import('../src/game/entities')
  it('前景條的左端固定（以螢幕空間的錨點對齊，不受角色轉向影響）', () => {
    const bar = new Goblin(0, 'g', 0).fx.bar
    for (const k of [1, 0.75, 0.5, 0.1]) {
      setBarProgress(bar, k)
      expect(bar.fg.visible).toBe(true)
      expect(bar.fg.scale.x).toBeCloseTo(1.16 * k)
      expect(-bar.fg.center.x * bar.fg.scale.x).toBeCloseTo(-0.58)
      expect(bar.fg.position.x).toBe(0)
    }
    setBarProgress(bar, 0)
    expect(bar.fg.visible).toBe(false)
  })
})

describe('房主驗證加入者回報的位置（防瞬移）', () => {
  const run = (game: ReturnType<typeof makeGame>, sec: number) => {
    for (let i = 0; i < Math.round(sec * 30); i++) (game as unknown as { tick(dt: number, r: boolean): void }).tick(1 / 30, false)
  }
  function hostWithGuestGoblin() {
    const link = {
      host: true, me: 'elf' as const, elfKind: 'harp' as const, peers: new Map([['peer-x', 0 as const]]), numbers: new Map(), names: new Map(),
      send() {}, listen: () => () => {}, onLeave: () => () => {}, onRejoin: () => () => {},
    }
    const game = makeGame('elf', 'harp', link as never)
    run(game, 4)
    const g = game.goblins[0]
    const apply = (x: number, z: number, vx = 0, vz = 0) =>
      (game as unknown as { applyInput(a: unknown, m: object): void }).applyInput(g, { p: [x, z, 0, vx, vz], c: g.corr })
    return { game, g, apply }
  }

  it('第一筆回報直接採用（加入者的出生點在自己那端決定）', () => {
    const { game, g, apply } = hostWithGuestGoblin()
    expect(g.netDriven).toBe(true)
    const to = { x: g.pos.x + 6, z: g.pos.z }
    apply(to.x, to.z)
    expect(g.pos.x).toBeCloseTo(to.x, 1)
    game.dispose()
  })

  it('之後瞬移 50 公尺：只會移動額度內的距離', () => {
    const { game, g, apply } = hostWithGuestGoblin()
    apply(g.pos.x, g.pos.z)
    const from = g.pos.clone()
    apply(from.x + 50, from.z)
    expect(g.pos.distanceTo(from)).toBeLessThanOrEqual(4.5) // 額度 4 公尺 + 碰撞推擠
    // 額度用完後立刻再瞬移：幾乎不能動
    const mid = g.pos.clone()
    apply(mid.x + 50, mid.z)
    expect(g.pos.distanceTo(mid)).toBeLessThan(1)
    game.dispose()
  })

  it('正常速度移動不受影響', () => {
    const { game, g, apply } = hostWithGuestGoblin()
    apply(g.pos.x, g.pos.z)
    for (let i = 0; i < 20; i++) {
      run(game, 0.05)
      const target = { x: g.pos.x + 6 * 0.05, z: g.pos.z }
      apply(target.x, target.z)
      expect(g.pos.x).toBeCloseTo(target.x, 3)
    }
    game.dispose()
  })

  it('灌入極大的速度：限制在合法的最高速度內', () => {
    const { game, g, apply } = hostWithGuestGoblin()
    apply(g.pos.x, g.pos.z, 1e9, 0)
    expect(g.vel.length()).toBeLessThan(20)
    game.dispose()
  })
})
