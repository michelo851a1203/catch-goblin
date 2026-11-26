// 蘑菇秘境：地形結構（區域連通、傳送點落點、上下層的距離）、所有角色都能走過傳送門（單機與多人）、整場 AI 對局不會卡進牆裡
import './sim/env'
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
vi.setConfig({ testTimeout: 120000 })

const { makeGame, runMultiplayer, runSolo } = await import('./sim/harness')
const { CONFIG } = await import('../src/game/config')
import type { Game } from '../src/game/Game'
type W = Game['world']

const tick = (g: Game, n: number) => {
  for (let i = 0; i < n; i++) (g as unknown as { tick(dt: number, r: boolean): void }).tick(1 / 30, false)
}

function checkStructure(world: W) {
  expect(world.caves.filter((c) => c.kind === 'cave')).toHaveLength(2)
  expect(world.caves.filter((c) => c.kind === 'plateau')).toHaveLength(3)
  expect(world.plateaus.map((p) => p.region)).toEqual([1, 2, 3])
  for (const w of world.warps) {
    expect(world.regionOf(w.from), `warp ${w.id} 的入口區域`).toBe(w.region)
    expect(world.regionOf(w.to), `warp ${w.id} 的落點區域`).toBe(w.toRegion)
    expect(world.blockedAt(w.to.x, w.to.z, CONFIG.elf.radius), `warp ${w.id} 的落點被擋住`).toBe(false)
    expect(world.blockedAt(w.from.x, w.from.z, CONFIG.elf.radius), `warp ${w.id} 的入口被擋住`).toBe(false)
    // 落點不在任何傳送點的範圍內（不會一落地又被傳走）
    for (const o of world.warps) if (o.region === w.toRegion) expect(Math.hypot(o.from.x - w.to.x, o.from.z - w.to.z)).toBeGreaterThan(o.radius + 0.6)
    expect(Math.hypot(w.to.x, w.to.z)).toBeLessThan(CONFIG.worldRadius - 2)
  }
  // 每個區域都到得了其他區域；每座台地至少兩個出口（被精靈堵住一個還能從另一個逃）
  const regions = [0, ...world.plateaus.map((p) => p.region)]
  for (const a of regions)
    for (const b of regions) {
      if (a === b) continue
      const from = a === 0 ? world.cagePos.clone().setX(5) : world.plateaus[a - 1].center.clone().setX(world.plateaus[a - 1].center.x + 4)
      const to = b === 0 ? world.cagePos.clone().setZ(9) : world.plateaus[b - 1].center.clone().setZ(world.plateaus[b - 1].center.z + 4)
      expect(world.route(from, a, to, b), `區域 ${a} → ${b}`).not.toBeNull()
    }
  for (const p of world.plateaus) expect(world.warps.filter((w) => w.region === p.region).length).toBeGreaterThanOrEqual(2)
  // 台地上下的角色至少相隔多遠：沿崖壁取樣上下兩側最靠近崖壁、又沒被擋住的點
  let gap = Infinity
  for (const p of world.plateaus)
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2
      let inner = 0, outer = 99
      for (let r = p.radius - 4; r < p.radius; r += 0.05) if (!world.blockedAt(p.center.x + Math.cos(a) * r, p.center.z + Math.sin(a) * r, CONFIG.goblin.radius)) inner = r
      for (let r = p.radius + 4; r > p.radius; r -= 0.05) if (!world.blockedAt(p.center.x + Math.cos(a) * r, p.center.z + Math.sin(a) * r, CONFIG.goblin.radius)) outer = r
      gap = Math.min(gap, outer - inner)
    }
  // 大於擊暈、捕獲、攪局的距離：不能隔著崖壁打人 / 救人
  expect(gap).toBeGreaterThan(Math.max(CONFIG.elf.stun.range, CONFIG.elf.capture.range, CONFIG.goblin.interfereRange))
  // 崖壁擋視線
  const p = world.plateaus[0]
  expect(world.lineOfSight(p.center.clone().setX(p.center.x + 5), p.center.clone().setX(p.center.x + 25))).toBe(false)
}

describe('蘑菇秘境的地形', () => {
  it('網站版（長局）：2 座山洞 + 3 座台地、傳送點落點合法、區域互通、上下層距離夠遠', () => {
    const g = makeGame('elf', 'harp', null, 'mushroom')
    checkStructure(g.world)
    g.dispose()
  })

  it('短局版（itch.io / CrazyGames）也一樣', async () => {
    vi.resetModules()
    vi.stubGlobal('location', { search: '', hostname: 'html-classic.itch.zone', href: 'http://test/' })
    try {
      // 先載入 config（重新載入 harness 時 sim/env 會把網域改回 test）
      const c = (await import('../src/game/config')).CONFIG
      const h = await import('./sim/harness')
      expect(c.mapScale).toBe(0.7)
      const g = h.makeGame('elf', 'harp', null, 'mushroom')
      checkStructure(g.world)
      g.dispose()
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  it('預設草原沒有台地、傳送點、孢子噴泉', () => {
    const g = makeGame('elf', 'harp')
    expect(g.world.plateaus).toHaveLength(0)
    expect(g.world.warps).toHaveLength(0)
    expect(g.world.vents).toHaveLength(0)
    expect(g.world.caves.every((c) => c.kind === 'cave')).toBe(true)
    g.dispose()
  })

  it('孢子噴泉噴霧時擋住穿過霧的視線，停止後恢復', () => {
    const g = makeGame('elf', 'harp', null, 'mushroom')
    const w = g.world
    const v = w.vents[0]
    const a = v.pos.clone().setX(v.pos.x - 8), b = v.pos.clone().setX(v.pos.x + 8)
    w.simTime = v.period - v.phase + 1 // 噴霧中
    expect(w.lineOfSight(a, b)).toBe(false)
    w.simTime = v.period - v.phase + v.duration + 1 // 已停止
    expect(w.lineOfSight(a, b)).toBe(true)
    g.dispose()
  })
})

// 從傳送點前方走進去：回傳走過去之後所在的區域
function walkInto(g: Game, me: { pos: { x: number; z: number; set(x: number, y: number, z: number): unknown } }, warp: number) {
  const w = g.world.warps[warp]
  tick(g, 100) // 倒數 3 秒
  const back = g.world.regionOf(w.from) === 0 ? 3.2 : 2.4
  // 從入口「外側」往入口走：台地上的入口從台地中央走過去，地面的入口從地圖中央走過去
  const center = w.region === 0 ? { x: 0, z: 0 } : g.world.plateaus[w.region - 1].center
  const dx = w.from.x - center.x, dz = w.from.z - center.z, l = Math.hypot(dx, dz)
  me.pos.set(w.from.x - (dx / l) * back, 0, w.from.z - (dz / l) * back)
  ;(g as unknown as { camYaw: number }).camYaw = Math.atan2(-dx, -dz)
  g.setTouchMove(0, 1)
  tick(g, 30)
  g.setTouchMove(0, 0)
  return g.world.regionOf(me.pos)
}

describe('所有角色都能走過傳送門 / 彈跳蘑菇（單機）', () => {
  for (const [role, kind] of [['elf', 'harp'], ['elf', 'violin'], ['goblin', 'harp'], ['goblin', 'violin']] as const)
    it(`${role === 'elf' ? kind + ' 精靈' : '哥布林（對手 ' + kind + '）'}：地面 → 台地 → 地面（傳送門）→ 台地 → 彈跳蘑菇`, () => {
      const g = makeGame(role, kind, null, 'mushroom')
      const me = role === 'elf' ? g.elf : g.playerGoblin!
      // AI 不要來干擾
      for (const x of [g.elf, ...g.goblins]) if (x !== me) x.netDriven = true
      for (const [w, expectRegion] of [[0, 1], [1, 0], [3, 2], [4, 0], [6, 3]] as const) expect(walkInto(g, me, w), `warp ${w}`).toBe(expectRegion)
      // 彈跳蘑菇（台地 3 → 地面）
      const pad = g.world.warps.find((w) => w.kind === 'bounce' && w.region === 3)!
      expect(walkInto(g, me, pad.id)).toBe(0)
      // 畫面上：落地後模型在地面；在台地上時模型墊高
      tick(g, 40)
      expect(me.root.position.y).toBeCloseTo(0)
      walkInto(g, me, 0)
      expect(me.root.position.y).toBeCloseTo(6)
      g.dispose()
    })
})

describe('多人：加入者走進傳送門由房主判定，加入者以房主位置為準', () => {
  for (const slot of [2, 'elf'] as const)
    it(`加入者當${slot === 'elf' ? '精靈' : '哥布林'}`, () => {
      const regions: number[] = []
      let want = -1
      runMultiplayer({
        kind: 'harp', seed: 5, clientSlot: slot, duration: 12, map: 'mushroom', hostAi: true,
        clientScript: (g, step) => {
          const me = g.actorOf(slot)
          // 從出生的地方自己走到同一區域裡最近的傳送門（不能瞬移：房主會擋掉不合理的位移）
          const r = g.world.regionOf(me.pos)
          const w = g.world.warps.filter((x) => x.kind === 'portal' && x.region === r).sort((a, b) => Math.hypot(a.from.x - me.pos.x, a.from.z - me.pos.z) - Math.hypot(b.from.x - me.pos.x, b.from.z - me.pos.z))[0]
          if (step === 100) want = w.toRegion
          // 被房主傳送（corr 改變）後就停下
          if (step > 100 && me.corr === 0) {
            ;(g as unknown as { camYaw: number }).camYaw = Math.atan2(-(w.from.x - me.pos.x), -(w.from.z - me.pos.z))
            g.setTouchMove(0, 1)
          } else g.setTouchMove(0, 0)
          if (step % 10 === 0) regions.push(g.world.regionOf(me.pos))
        },
      })
      // 加入者本機的位置最後在另一個區域（房主傳送後以 corr 強制同步）
      expect(want).toBeGreaterThanOrEqual(0)
      expect(regions.at(-1)).toBe(want)
    })
})

describe('蘑菇秘境整場 AI 對局', () => {
  for (const kind of ['harp', 'violin'] as const)
    for (const seed of [1, 2])
      it(`${kind} #${seed}：有結果、雙方都用過傳送點、沒有角色卡進牆裡`, () => {
        const bad: string[] = []
        const warped = new Set<string>()
        const r = runSolo({
          role: 'elf', kind, seed, mode: 'ai', duration: 240, map: 'mushroom',
          invariants: [
            (g) => {
              for (const a of [g.elf, ...g.goblins.filter((x) => !x.captured)])
                if (g.world.blockedAt(a.pos.x, a.pos.z, a.radius * 0.5) && bad.length < 5) bad.push(`${a === g.elf ? 'elf' : 'goblin'} @ ${a.pos.x.toFixed(1)},${a.pos.z.toFixed(1)}`)
              for (const a of [g.elf, ...g.goblins]) if (a.warpCd > 0.55) warped.add(a === g.elf ? 'elf' : 'goblin')
              return null
            },
          ],
        })
        expect(r.winner).not.toBeNull()
        expect(bad).toEqual([])
        expect(warped).toEqual(new Set(['elf', 'goblin']))
      })
})
