// 遊俠精靈（長笛遊俠）：技能規則、HUD、對局模擬（單機 / 多人）與 golden master。設計見 docs/ranger.md
// 有意調整遊俠的行為後，以 UPDATE_GOLDEN=1 npx vitest run tests/ranger.test.ts 重新產生 tests/__golden__/ranger.json
import './sim/env'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
// 長時間的同步模擬之間讓出事件迴圈（見 gameSim.test.ts）
beforeEach(() => new Promise<void>((r) => setImmediate(r)))

const { makeGame, runMultiplayer, runSolo, seeded } = await import('./sim/harness')
const { CONFIG } = await import('../src/game/config')
const { arrowEffect, canPlantAt, chainCatches, pressured, reelRange, trapChains, TRAP_GONE } = await import('../src/game/ranger')
type G = ReturnType<typeof makeGame>
type Goblin = G['goblins'][number]
const R = CONFIG.ranger

// 暖機：第一次建立 Game 會填充模組層級的快取（貼圖、材質），途中用到的亂數會讓第一場和之後的結果不同
runSolo({ role: 'elf', kind: 'ranger', seed: 99, mode: 'ai', duration: 30 })
runMultiplayer({ kind: 'ranger', seed: 99, clientSlot: 'elf', duration: 5 })
runMultiplayer({ kind: 'ranger', seed: 99, clientSlot: 1, hostAi: true, duration: 30 })

const tick = (game: G, sec: number) => {
  for (let i = 0; i < Math.round(sec * 30); i++) (game as unknown as { tick(dt: number, r: boolean): void }).tick(1 / 30, false)
}
const dist = (a: { pos: THREE.Vector3 }, b: { pos: THREE.Vector3 }) => Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)
const X = new THREE.Vector3(1, 0, 0)

// 找一塊空地：p 往 +x 28 公尺都沒有障礙物、視線暢通
function clearing(game: G) {
  const w = game.world
  for (let z = 20; z < 60; z += 4)
    for (let x = -40; x < 20; x += 4) {
      const p = new THREE.Vector3(x, 0, z)
      let ok = w.lineOfSight(p, p.clone().addScaledVector(X, 28)) && w.regionOf(p) === 0
      for (let k = -2; ok && k <= 30; k += 1) ok = !w.blockedAt(x + k, z, 2.2) && w.zoneOf(new THREE.Vector3(x + k, 0, z)) < 0
      if (ok) return p
    }
  throw new Error('找不到空地')
}

// 遊俠在空地上面向 +x，所有哥布林停在遠處不動（AI 關掉，只測規則）；at(g, d)＝把哥布林放到精靈前方 d 公尺
function setup(role: 'elf' | 'goblin' = 'elf') {
  const game = makeGame(role, 'ranger')
  tick(game, 4)
  expect(game.hud.phase).toBe('play')
  const elf = game.elf
  if (role === 'goblin') elf.isPlayer = true // 精靈也不交給 AI
  for (const g of game.goblins) g.isPlayer = true
  game.setTouchMove(0, 0)
  const o = clearing(game)
  elf.pos.copy(o)
  elf.yaw = Math.PI / 2
  elf.vel.set(0, 0, 0)
  game.goblins.forEach((g, i) => g.pos.set(o.x - 30 - i * 3, 0, o.z + 40))
  const at = (g: Goblin, d: number, side = 0) => {
    g.pos.set(o.x + d, 0, o.z + side)
    g.vel.set(0, 0, 0)
    return g
  }
  const events: { e: string; [k: string]: unknown }[] = []
  const P = game as unknown as { present(ev: { e: string }): void }
  const orig = P.present.bind(game)
  P.present = (ev) => (events.push(ev), orig(ev))
  return { game, elf, r: elf.ranger!, at, events, o }
}

const origRandom = Math.random
beforeEach(() => {
  Math.random = seeded(7)
})
afterEach(() => {
  Math.random = origRandom
})

describe('遊俠：純判定', () => {
  it('箭矢效果：近距離只減速、遠距離標記、已標記 / 減速 / 受困的目標＝受困', () => {
    const none = { mark: 0, slow: 0, snare: 0 }
    expect(arrowEffect(R.arrow.fullRange - 0.1, none)).toBe('slow')
    expect(arrowEffect(R.arrow.fullRange + 0.1, none)).toBe('mark')
    expect(arrowEffect(2, { ...none, mark: 1 })).toBe('snare')
    expect(arrowEffect(20, { ...none, slow: 1 })).toBe('snare')
    expect(arrowEffect(20, { ...none, snare: 1 })).toBe('snare')
  })
  it('收網距離：太近 / 剛好 / 太遠', () => {
    expect(reelRange(R.reel.minRange - 0.1)).toBe('near')
    expect(reelRange(R.reel.minRange + 0.1)).toBe('ok')
    expect(reelRange(R.reel.maxRange + 0.1)).toBe('far')
  })
  it('貼身干擾只算行動自如的哥布林；受困哥布林附近不能放陷阱', () => {
    const p = new THREE.Vector3()
    const g = (x: number, o: object = {}) => ({ pos: new THREE.Vector3(x, 0, 0), captured: false, disabled: false, held: false, snare: 0, ...o })
    expect(pressured(p, [g(2)], R.pressureRadius)).toBe(true)
    expect(pressured(p, [g(2, { disabled: true })], R.pressureRadius)).toBe(false)
    expect(pressured(p, [g(R.pressureRadius + 0.5)], R.pressureRadius)).toBe(false)
    expect(canPlantAt(p, [g(1)])).toBe(true)
    expect(canPlantAt(p, [g(1, { snare: 2 })])).toBe(false)
    expect(canPlantAt(p, [g(R.trap.noTrapRadius + 1, { snare: 2 })])).toBe(true)
  })
})

describe('遊俠：召喚箭矢', () => {
  it('遠距離第一箭標記（命中後冷卻縮短），第二箭受困；整個過程沒有暈眩 / 定身', () => {
    const { game, elf, r, at, events } = setup()
    const g = at(game.goblins[0], 15)
    expect(game.rangerArrow(X.clone())).toBe(true)
    expect(elf.busy).toBe(true)
    expect(elf.pose === 'normal' || elf.pose === 'shoot').toBe(true)
    tick(game, R.arrow.draw + 15 / R.arrow.speed + 0.15)
    expect(events.find((e) => e.e === 'arrowHit')).toMatchObject({ g: g.id, k: 'mark' })
    expect(g.mark).toBeGreaterThan(R.arrow.markTime - 1)
    expect(g.snare).toBe(0)
    expect(r.cd.arrow).toBeLessThanOrEqual(R.arrow.hitCooldown)
    // 標記期間腳步變慢、精靈的小地圖看得到
    expect(game.elfMapColor(g)).toBeTruthy()
    tick(game, R.arrow.hitCooldown)
    expect(game.rangerArrow(X.clone())).toBe(true)
    tick(game, R.arrow.draw + 15 / R.arrow.speed + 0.15)
    expect(events.filter((e) => e.e === 'arrowHit').at(-1)).toMatchObject({ g: g.id, k: 'snare' })
    expect(g.snare).toBeGreaterThan(0)
    expect(g.mark).toBe(0)
    expect(g.disabled).toBe(true)
    expect(g.stun).toBe(0)
    expect(g.rooted).toBe(0)
    game.dispose()
  })

  it('近距離（fullRange 內）只會減速', () => {
    const { game, at, events } = setup()
    const g = at(game.goblins[0], R.arrow.fullRange - 2)
    game.rangerArrow(X.clone())
    tick(game, R.arrow.draw + 0.3)
    expect(events.find((e) => e.e === 'arrowHit')).toMatchObject({ g: g.id, k: 'slow' })
    expect(g.slow).toBeGreaterThan(0)
    expect(g.mark).toBe(0)
    expect(g.snare).toBe(0)
    game.dispose()
  })

  it('落空要等完整的冷卻；冷卻中不能再射', () => {
    const { game, r } = setup()
    expect(game.rangerArrow(X.clone())).toBe(true)
    tick(game, R.arrow.draw + R.arrow.range / R.arrow.speed + 0.2)
    expect(r.cd.arrow).toBeGreaterThan(R.arrow.hitCooldown)
    expect(game.rangerArrow(X.clone())).toBe(false)
    game.dispose()
  })

  it('輔助瞄準：準星附近的哥布林會被鎖定，射出時對準牠的位置', () => {
    const { game, at, events } = setup()
    const g = at(game.goblins[0], 16, 1.5) // 偏離準星約 5°，直射會從旁邊飛過
    game.rangerArrow(X.clone())
    tick(game, R.arrow.draw + 16 / R.arrow.speed + 0.2)
    expect(events.find((e) => e.e === 'arrowHit')).toMatchObject({ g: g.id })
    game.dispose()
  })

  it('貼身干擾：身邊有哥布林時吹笛變慢（箭比較晚射出）', () => {
    const { game, at, events } = setup()
    at(game.goblins[1], -2) // 背後 2 公尺
    expect(game.rangerRate()).toBe(R.pressureRate)
    game.rangerArrow(X.clone())
    tick(game, R.arrow.draw + 0.1)
    expect(events.some((e) => e.e === 'arrow')).toBe(false)
    tick(game, R.arrow.draw / R.pressureRate - R.arrow.draw)
    expect(events.some((e) => e.e === 'arrow')).toBe(true)
    game.dispose()
  })
})

describe('遊俠：藤蔓陷阱', () => {
  it('吹笛後陷阱長在面前，消耗一層充能；生效後踩到的哥布林受困並顯示在小地圖', () => {
    const { game, r, at, events, o } = setup()
    expect(game.rangerTrap()).toBe(true)
    expect(r.traps.length).toBe(0)
    tick(game, R.trap.castTime + 0.05)
    expect(r.traps.length).toBe(1)
    expect(r.charges).toBe(R.trap.charges - 1)
    expect(r.traps[0].pos.x - o.x).toBeCloseTo(1.3, 1)
    // 還沒生效：踩上去沒事
    const g = at(game.goblins[0], 1.3)
    tick(game, 0.2)
    expect(g.snare).toBe(0)
    at(g, 12)
    tick(game, R.trap.armTime)
    expect(r.traps[0].arm).toBe(0)
    at(g, 1.3)
    tick(game, 0.1)
    expect(g.snare).toBeGreaterThan(0)
    expect(g.reveal).toBeGreaterThan(0)
    expect(r.traps.length).toBe(0)
    expect(events.find((e) => e.e === 'trapGone')).toMatchObject({ why: TRAP_GONE.snap, g: g.id })
    // 充能會回來
    tick(game, R.trap.recharge)
    expect(r.charges).toBe(R.trap.charges)
    game.dispose()
  })

  it('沒有充能不能放；陷阱不會隨時間消失，放新的也不會讓舊的消失', () => {
    const { game, elf, r } = setup()
    r.charges = 0
    expect(game.rangerTrap()).toBe(false)
    const ids: number[] = []
    for (let i = 0; i < R.trap.charges + 3; i++) {
      r.charges = 1
      elf.pos.x += 3
      expect(game.rangerTrap()).toBe(true)
      tick(game, R.trap.castTime + 0.05)
      ids.push(r.traps.at(-1)!.id)
    }
    expect(r.traps.map((t) => t.id)).toEqual(ids)
    tick(game, 300)
    expect(r.traps.map((t) => t.id)).toEqual(ids)
    game.dispose()
  })

  it('哥布林在陷阱旁按攪局可以拆掉；太遠不行', () => {
    const { game, r, at } = setup()
    game.rangerTrap()
    tick(game, R.trap.castTime + 0.05)
    const g = at(game.goblins[0], 1.3 + R.trap.disarmRange + 1)
    expect(game.goblinInterfere(g)).toBe(false)
    at(g, 1.3 + R.trap.disarmRange - 0.5)
    expect(game.goblinInterfere(g)).toBe(true)
    expect(r.traps.length).toBe(0)
    expect(g.interfereCd).toBeGreaterThan(0)
    game.dispose()
  })

  it('哥布林玩家只看得到身邊的陷阱', () => {
    const { game, r, at } = setup('goblin')
    game.rangerTrap()
    tick(game, R.trap.castTime + 0.05)
    const me = game.playerGoblin!
    const seen = () => (game as unknown as { trapVisible(p: THREE.Vector3): boolean }).trapVisible(r.traps[0].pos)
    at(me, 1.3 + R.trap.revealRadius + 2)
    expect(seen()).toBe(false)
    at(me, 1.3 + R.trap.revealRadius - 0.5)
    expect(seen()).toBe(true)
    game.dispose()
  })
})

describe('遊俠：後躍撤步', () => {
  it('往遠離最近哥布林的方向跳開 distance 公尺，原地留下陷阱（不佔充能），追上來的哥布林會踩到', () => {
    const { game, elf, r, at, o, events } = setup()
    const g = at(game.goblins[0], 2)
    expect(game.rangerLeap()).toBe(true)
    expect(elf.pose === 'normal' || elf.pose === 'leap').toBe(true)
    // 起跳時朝前方射出一支召喚箭矢，不佔箭的冷卻
    expect(events.some((e) => e.e === 'arrow')).toBe(true)
    expect(r.cd.arrow).toBe(0)
    tick(game, R.leap.time + 0.1)
    expect(r.leap).toBe(null)
    expect(o.x - elf.pos.x).toBeCloseTo(R.leap.distance, 0)
    expect(r.charges).toBe(R.trap.charges)
    expect(r.traps.length).toBe(1)
    expect(r.cd.leap).toBeGreaterThan(R.leap.cooldown - 1)
    expect(game.rangerLeap()).toBe(false)
    // 直線追上來：踩到陷阱
    at(g, 0.3)
    tick(game, 0.3)
    expect(g.snare).toBeGreaterThan(0)
    game.dispose()
  })
})

describe('遊俠：藤蔓連鎖', () => {
  const trap = (id: number, x: number, z: number, arm = 0) => ({ id, pos: new THREE.Vector3(x, 0, z), arm, region: 0 })
  // 直接在場上種下已生效的陷阱（相對精靈的位置）
  const plant = (s: ReturnType<typeof setup>, pts: [number, number][]) => {
    for (const [dx, dz] of pts) s.r.traps.push(trap(++s.r.seq, s.o.x + dx, s.o.z + dz))
  }

  it('linkRange 內的已生效陷阱相連；三個兩兩相連形成一個面；太遠或還沒生效的不相連', () => {
    const L = R.chain.linkRange
    const chains = trapChains([trap(1, 0, 0), trap(2, 6, 0), trap(3, 3, 5), trap(4, 3 + L + 4, 5), trap(5, 0, 2, 0.5)])
    expect(chains.map((c) => c.traps.map((t) => t.id))).toEqual([[1, 2, 3], [4]])
    const [ch] = chains
    expect(ch.links.length).toBe(3)
    expect(ch.faces.length).toBe(1)
    // 連線上、面內會被纏住；外面不會
    expect(chainCatches(ch, new THREE.Vector3(3, 0, R.chain.linkRadius - 0.1))).toBe(true)
    expect(chainCatches(ch, new THREE.Vector3(3, 0, 2))).toBe(true)
    expect(chainCatches(ch, new THREE.Vector3(3, 0, -2))).toBe(false)
    // 兩個陷阱只有連線，沒有面
    const line = trapChains([trap(1, 0, 0), trap(2, 6, 0)])[0]
    expect(line.faces.length).toBe(0)
    expect(chainCatches(line, new THREE.Vector3(3, 0, 0.3))).toBe(true)
    expect(chainCatches(line, new THREE.Vector3(3, 0, 2))).toBe(false)
  })

  it('踩到兩個陷阱之間的連線＝受困，連鎖上的陷阱全部消耗', () => {
    const s = setup()
    plant(s, [[6, 0], [12, 0], [30, 20]])
    const g = s.at(s.game.goblins[0], 9, 0.3)
    tick(s.game, 0.1)
    expect(g.snare).toBeGreaterThan(0)
    expect(s.r.traps.length).toBe(1)
    expect(s.events.filter((e) => e.e === 'trapGone' && e.why === TRAP_GONE.snap).length).toBe(2)
    expect(s.events.filter((e) => e.e === 'vine')).toMatchObject([{ g: g.id, far: 0 }])
    s.game.dispose()
  })

  it('三個陷阱形成的面內：範圍內的哥布林全部受困，三個陷阱一起消耗', () => {
    const s = setup()
    plant(s, [[5, -3], [11, -3], [8, 3]])
    const a = s.at(s.game.goblins[0], 7, -1)
    const b = s.at(s.game.goblins[1], 9, -1)
    tick(s.game, 0.1)
    expect(a.snare).toBeGreaterThan(0)
    expect(b.snare).toBeGreaterThan(0)
    expect(s.r.traps.length).toBe(0)
    s.game.dispose()
  })

  it('遠處的哥布林中陷阱：小地圖顯示 farReveal 秒，精靈短暫加速', () => {
    const s = setup()
    const far = R.chain.farRange + 4
    plant(s, [[far, 0]])
    const g = s.at(s.game.goblins[0], far)
    tick(s.game, 0.1)
    expect(g.snare).toBeGreaterThan(0)
    expect(g.reveal).toBeGreaterThan(R.chain.farReveal - 1)
    expect(s.r.haste).toBeGreaterThan(0)
    // 加速：同樣時間走得比較遠
    const run = () => {
      const x0 = s.elf.pos.x
      s.game.setTouchMove(0, -1)
      tick(s.game, 1)
      s.game.setTouchMove(0, 0)
      return Math.abs(s.elf.pos.x - x0) + Math.abs(s.elf.pos.z - s.o.z)
    }
    const fast = run()
    tick(s.game, R.chain.hasteTime)
    expect(s.r.haste).toBe(0)
    s.elf.pos.copy(s.o)
    const slow = run()
    expect(fast).toBeGreaterThan(slow * 1.1)
    s.game.dispose()
  })

  it('近處中陷阱：不加速，小地圖只顯示 minimapTime 秒', () => {
    const s = setup()
    plant(s, [[5, 0]])
    const g = s.at(s.game.goblins[0], 5)
    tick(s.game, 0.1)
    expect(g.snare).toBeGreaterThan(0)
    expect(g.reveal).toBeLessThanOrEqual(R.trap.minimapTime)
    expect(s.r.haste).toBe(0)
    s.game.dispose()
  })

  it('哥布林站在連線旁按攪局：拆掉最近的陷阱，連鎖斷開', () => {
    const s = setup()
    plant(s, [[4, 0], [11, 0]])
    const g = s.at(s.game.goblins[0], 7.5, R.trap.disarmRange - 0.5)
    expect(s.game.goblinInterfere(g)).toBe(true)
    expect(s.r.traps.length).toBe(1)
    s.game.dispose()
  })
})

describe('遊俠：收網', () => {
  const snared = (d: number) => {
    const s = setup()
    const g = s.at(s.game.goblins[0], d)
    g.snare = 3
    return { ...s, g }
  }

  it('只能對 minRange～maxRange 內受困的哥布林收網：太近、太遠、沒受困都不行', () => {
    for (const d of [R.reel.minRange - 1, R.reel.maxRange + 1]) {
      const { game } = snared(d)
      expect(game.elfStartCapture()).toBe(false)
      game.dispose()
    }
    const { game, g } = snared(8)
    g.snare = 0
    expect(game.elfStartCapture()).toBe(false)
    g.snare = 3
    expect(game.elfStartCapture()).toBe(true)
    expect(g.held).toBe(true)
    game.dispose()
  })

  it('收網時把哥布林拖到身邊，time 秒後抓進牢籠', () => {
    const { game, elf, g, events } = snared(10)
    expect(game.elfStartCapture()).toBe(true)
    tick(game, 1.2)
    expect(dist(g, elf)).toBeCloseTo(R.reel.pullTo, 0)
    expect(g.captured).toBe(false)
    tick(game, R.reel.time - 1.2 + 0.1)
    expect(g.captured).toBe(true)
    expect(events.some((e) => e.e === 'caught' && e.g === g.id)).toBe(true)
    expect(elf.packing).toBe(null)
    game.dispose()
  })

  it('射箭鍵在有哥布林受困時變成收網（HUD 也換成收網）', () => {
    const { game, g } = snared(8)
    ;(game as unknown as { syncHud(): void }).syncHud()
    expect(game.hud.skills.map((s) => s.icon)).toEqual(['skill-trap', 'skill-leap', 'skill-reel', 'skill-reel'])
    expect(game.hud.skills[0].count).toBe(R.trap.charges)
    game.onAction('Mouse0')
    expect(g.held).toBe(true)
    tick(game, 0.2)
    ;(game as unknown as { syncHud(): void }).syncHud()
    expect(game.hud.progress).toBeGreaterThan(0)
    game.dispose()
  })

  it('隊友要到被困者身邊才割得斷繩索；割斷後保留進度，割繩者與被救者都被標記', () => {
    const { game, elf, g, at } = snared(10)
    const far = at(game.goblins[1], 10 + R.reel.cutRange + 6)
    game.elfStartCapture()
    tick(game, 1.5) // 已被拖到精靈身邊
    expect(game.goblinInterfere(far)).toBe(false)
    const near = at(game.goblins[2], R.reel.pullTo + R.reel.cutRange - 0.5)
    const done = elf.packing!.t / elf.packing!.total
    expect(game.goblinInterfere(near)).toBe(true)
    expect(g.held).toBe(false)
    expect(g.snare).toBe(0)
    expect(g.grace).toBeGreaterThan(0)
    expect(elf.packing).toBe(null)
    expect(elf.stagger).toBeCloseTo(R.reel.cutStagger, 1)
    expect(g.packSaved).toBeCloseTo(Math.min(R.reel.keepMax, done * R.reel.keep), 2)
    expect(near.mark).toBeGreaterThan(0)
    expect(g.mark).toBeGreaterThan(0)
    game.dispose()
  })

  it('被收網的哥布林可以用大招掙脫（進度歸零、不會被標記）', () => {
    const { game, g } = snared(9)
    game.elfStartCapture()
    tick(game, 1)
    expect(game.goblinUlt(g)).toBe(true)
    expect(g.held).toBe(false)
    expect(g.packSaved).toBe(0)
    expect(g.mark).toBe(0)
    expect(g.ultUsed).toBe(true)
    game.dispose()
  })

  it('貼身干擾：有哥布林貼在精靈身邊時收網速度減半', () => {
    const { game, elf, at } = snared(10)
    at(game.goblins[1], -2)
    game.elfStartCapture()
    tick(game, 1)
    expect(elf.packing!.t).toBeCloseTo(1 * R.pressureRate, 1)
    game.dispose()
  })

  it('時間到結算時正在收網：中止並放開哥布林', () => {
    const { game, elf, g } = snared(9)
    game.elfStartCapture()
    ;(game as unknown as { finish(w: string): void }).finish('goblin')
    expect(game.hud.phase).toBe('over')
    expect(elf.packing).toBe(null)
    expect(g.held).toBe(false)
    expect(g.captured).toBe(false)
    game.dispose()
  })
})

// ───── 對局模擬：不變式、確定性、golden ─────
function invariants(game: G): string | null {
  const e = game.elf
  const r = e.ranger!
  const acts = [e.packing && 'packing', r.draw && 'draw', r.plant >= 0 && 'plant', r.leap && 'leap'].filter(Boolean)
  // 收網中可以沒有其他動作；吹笛 / 後躍彼此互斥
  if (acts.filter((a) => a !== 'packing').length > 1) return `精靈同時處於 ${acts.join('+')}`
  if (game.hud.phase === 'over' && acts.length) return `結算後精靈仍在 ${acts.join('+')}`
  if (r.charges < 0 || r.charges > R.trap.charges) return `充能 ${r.charges} 超出範圍`
  for (const g of game.goblins) {
    if (g.captured && g.held) return `哥布林 ${g.id} 同時 captured 與 held`
    if (g.stun > 0 || g.rooted > 0 || g.terror > 0) return `遊俠的對局出現暈眩 / 定身 / 恐懼（哥布林 ${g.id}）`
    if (![g.pos.x, g.pos.z, g.snare, g.mark, g.slow].every(Number.isFinite)) return `哥布林 ${g.id} 的狀態不是有限數值`
  }
  if (game.authority) {
    if (e.packing && (!e.packing.g.held || e.packing.g.captured)) return `收網中的哥布林 ${e.packing.g.id} 不是 held`
    for (const g of game.goblins) if (g.held && e.packing?.g !== g) return `哥布林 ${g.id} held 但沒有被收網`
  }
  return null
}
const INV = [invariants]

const GOLDEN = resolve(__dirname, '__golden__/ranger.json')
const update = !!process.env.UPDATE_GOLDEN
let golden: Record<string, string> = {}
try {
  golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
} catch {
  /* 第一次產生 */
}
function check(name: string, r: ReturnType<typeof runSolo>) {
  expect(r.violations, `${name} 出現不合法的狀態組合`).toEqual([])
  if (update) {
    golden[name] = r.hash
    mkdirSync(resolve(__dirname, '__golden__'), { recursive: true })
    writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n')
    return
  }
  expect(golden[name], `缺少 golden：${name}（以 UPDATE_GOLDEN=1 產生）`).toBeTruthy()
  expect(r.hash, `${name} 的對局行為改變了`).toBe(golden[name])
}

describe('遊俠：對局 golden master', () => {
  for (const map of ['meadow', 'mushroom'] as const) {
    for (const seed of [1, 2]) {
      it(`AI 對 AI（${map}）#${seed}`, () => {
        const r = runSolo({ role: 'elf', kind: 'ranger', seed, mode: 'ai', duration: 240, map, invariants: INV })
        // 技能都有用到
        for (const e of ['draw', 'arrow', 'arrowHit', 'trap', 'pack']) expect(r.stats[`solo:${e}`] ?? 0, e).toBeGreaterThan(0)
        check(`ai-${map}-${seed}`, r)
      })
      it(`精靈玩家隨機操作（${map}）#${seed}`, () => check(`elf-player-${map}-${seed}`, runSolo({ role: 'elf', kind: 'ranger', seed, mode: 'player', map, invariants: INV })))
      it(`哥布林玩家隨機操作（${map}）#${seed}`, () => check(`goblin-player-${map}-${seed}`, runSolo({ role: 'goblin', kind: 'ranger', seed, mode: 'player', map, invariants: INV })))
    }
    it(`多人：加入者當精靈（${map}）`, () => check(`mp-elf-${map}`, runMultiplayer({ kind: 'ranger', seed: 1, clientSlot: 'elf', map, invariants: INV })))
    it(`多人：加入者當哥布林（${map}）`, () => check(`mp-goblin-${map}`, runMultiplayer({ kind: 'ranger', seed: 1, clientSlot: 2, map, invariants: INV })))
    it(`多人：房主 AI 遊俠抓加入者、斷線後重連（${map}）`, () => {
      const r = runMultiplayer({ kind: 'ranger', seed: 2, clientSlot: 1, hostAi: true, duration: 240, leaveAt: 1500, rejoinAt: 2100, map, invariants: INV })
      // 加入者收到的技能事件和房主一致（房主的判定確實同步過去）
      for (const e of ['arrow', 'trap', 'pack']) {
        expect(r.stats[`host:${e}`] ?? 0, e).toBeGreaterThan(0)
        expect(r.stats[`client:${e}`] ?? 0, e).toBeGreaterThan(0)
      }
      check(`mp-ai-${map}`, r)
    })
  }

  it('同一個種子跑兩次結果相同', () => {
    const a = runSolo({ role: 'elf', kind: 'ranger', seed: 5, mode: 'ai', duration: 120, map: 'mushroom' })
    const b = runSolo({ role: 'elf', kind: 'ranger', seed: 5, mode: 'ai', duration: 120, map: 'mushroom' })
    expect(a.hash).toBe(b.hash)
  })
})

describe('遊俠：多人連線的狀態同步', () => {
  it('加入者（哥布林）看到的陷阱、受困 / 標記狀態與房主一致', () => {
    // 房主＝AI 遊俠，加入者＝1 號哥布林；以記憶體佇列傳訊
    const toClient: string[] = []
    const toHost: string[] = []
    const hl = new Set<(from: string, m: { t: string }) => void>()
    const cl = new Set<(from: string, m: { t: string }) => void>()
    const base = { elfKind: 'ranger' as const, map: 'meadow' as const, numbers: new Map<'elf' | number, number>([['elf', 1], [1, 2]]), names: new Map<'elf' | number, string>([['elf', 'H'], [1, 'C']]) }
    const host = makeGame('elf', 'ranger', {
      ...base, host: true, me: 'elf', peers: new Map([['c', 1]]),
      send: (m: unknown) => void toClient.push(JSON.stringify(m)),
      listen: (fn: never) => (hl.add(fn), () => hl.delete(fn)), onLeave: () => () => {}, onRejoin: () => () => {},
    } as never)
    const client = makeGame('goblin', 'ranger', {
      ...base, host: false, me: 1, peers: new Map(),
      send: (m: unknown) => void toHost.push(JSON.stringify(m)),
      listen: (fn: never) => (cl.add(fn), () => cl.delete(fn)), onLeave: () => () => {}, onRejoin: () => () => {},
    } as never)
    host.elf.isPlayer = false
    let checked = 0
    for (let step = 0; step < 150 * 30; step++) {
      for (const m of toClient.splice(0)) for (const fn of cl) fn('h', JSON.parse(m))
      for (const m of toHost.splice(0)) for (const fn of hl) fn('c', JSON.parse(m))
      tick(host, 1 / 30)
      tick(client, 1 / 30)
      if (step % 30 !== 29 || host.hud.phase !== 'play') continue
      // 快照每 1/15 秒一次：請房主立刻再送一份目前的狀態，加入者收到後比對
      const H = host as unknown as { netT: number; netSync(dt: number): void }
      H.netT = 0
      H.netSync(0)
      for (const m of toClient.splice(0)) for (const fn of cl) fn('h', JSON.parse(m))
      const hr = host.elf.ranger!, cr = client.elf.ranger!
      expect(cr.traps.map((t) => t.id)).toEqual(hr.traps.map((t) => t.id))
      expect(cr.charges).toBe(hr.charges)
      host.goblins.forEach((g, i) => {
        const c = client.goblins[i]
        expect([c.captured, c.held, c.snare > 0, c.mark > 0]).toEqual([g.captured, g.held, g.snare > 0, g.mark > 0])
      })
      checked++
    }
    expect(checked).toBeGreaterThan(100)
    expect(host.goblins.some((g) => g.captured)).toBe(true)
    host.dispose()
    client.dispose()
  })
})
