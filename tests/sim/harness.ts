// 無頭對局模擬：以固定亂數種子跑完整場對局，逐步記錄所有遊戲狀態 / 事件 / 音效 / 網路訊息，
// 用來確認重構前後的遊戲行為完全一致（golden master）。
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto'
import { setSearch } from './env'
import { Game, createHudState } from '../../src/game/Game'
import type { ElfKind, Role } from '../../src/game/config'
import type { NetLink } from '../../src/net/room'
import type { Slot } from '../../src/net/assign'

export { sfxLog } from './sfxLog'
import { sfxLog } from './sfxLog'

// 固定種子的亂數（mulberry32）
export function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const v = (p: { x: number; z: number }) => [p.x, p.z]

// 遊戲狀態的完整描述（不經過網路快照的四捨五入）
export function stateOf(game: Game) {
  const G = game as any
  const e = game.elf
  return {
    ph: game.hud.phase,
    cdn: G.countdown,
    el: game.elapsed,
    pk: game.packId,
    elf: {
      p: v(e.pos), v: v(e.vel), y: e.yaw, w: v(e.wish), m: e.moveAmt, pose: e.pose, z: e.zone,
      cd: { ...e.cd }, sc: e.stealthCast, st: e.stealth, eye: e.eye, ch: e.channel, sg: e.stagger, ct: e.castT, cp: e.castPose,
      chg: e.charge ? [e.charge.phase, e.charge.t, v(e.charge.dir), e.charge.done, e.charge.hit] : null,
      pack: e.packing ? [e.packing.g.id, e.packing.t, e.packing.total] : null,
      busy: e.busy, stealthed: e.stealthed, corr: e.corr, nd: e.netDriven, net: e.net && { ...e.net },
      ma: [...e.musicAffected].map((g) => g.id), op: e.character.currentOpacity,
      ai: { t: e.ai.target?.id ?? -1, pc: e.ai.patrolCave, pw: e.ai.patrolWait, plc: e.ai.plannedChannel, d: e.ai.dest && v(e.ai.dest), th: e.ai.think },
    },
    g: game.goblins.map((g) => ({
      p: v(g.pos), v: v(g.vel), y: g.yaw, m: g.moveAmt, pose: g.pose, z: g.zone, hc: g.homeCave,
      s: [g.captured, g.held, g.ultUsed, g.stun, g.rooted, g.terror, g.attract, g.charm, g.grace, g.dashT, g.dashCd, g.interfereCd],
      dis: g.disabled, corr: g.corr, nd: g.netDriven, net: g.net && { ...g.net }, name: g.name,
      fl: g.flight && [g.flight.t, g.flight.dur], fx: [g.fx.radar.visible, g.fx.eyeWarn.visible, g.fx.bar.group.visible],
      ai: { ...g.ai, lastElf: g.ai.lastElf && v(g.ai.lastElf), target: g.ai.target && v(g.ai.target) },
    })),
    xray: G.xrayOn,
    radarWas: G.radarWas,
    efx: [e.fx.stunned.visible, e.fx.bar.group.visible],
  }
}

function hudOf(game: Game) {
  const h = game.hud
  return JSON.parse(JSON.stringify(h))
}

interface Side {
  game: Game
  name: string
  // 每步要做的事（輸入腳本）
  script?: (game: Game, step: number, rnd: () => number) => void
}

class Recorder {
  private hash = createHash('sha256')
  lines: string[] | null
  constructor(keep: boolean) {
    this.lines = keep ? [] : null
  }
  add(o: unknown) {
    const s = JSON.stringify(o)
    this.hash.update(s)
    this.hash.update('\n')
    this.lines?.push(s)
  }
  digest() {
    return this.hash.digest('hex')
  }
}

// 記錄每個 present 的事件
function tapEvents(game: Game, out: unknown[]) {
  const G = game as any
  const orig = G.present.bind(game)
  G.present = (ev: unknown) => {
    out.push(ev)
    orig(ev)
  }
}

export interface Invariant {
  (game: Game, step: number): string | null
}

export interface RunResult {
  hash: string
  lines: string[] | null
  steps: number
  winner: Role | null
  violations: string[]
  stats: Record<string, number>
}

// 單機 / 多人通用的模擬迴圈
function simulate(sides: Side[], opts: { steps: number; dt: number; seed: number; keep: boolean; between?: (step: number) => void; invariants?: Invariant[] }): RunResult {
  const rec = new Recorder(opts.keep)
  const rnd = seeded(opts.seed ^ 0x9e3779b9)
  const events = sides.map(() => [] as unknown[])
  sides.forEach((s, i) => tapEvents(s.game, events[i]))
  const violations: string[] = []
  const stats: Record<string, number> = {}
  let steps = 0
  for (let step = 0; step < opts.steps; step++) {
    opts.between?.(step)
    for (const [i, s] of sides.entries()) {
      sfxLog.length = 0
      s.script?.(s.game, step, rnd)
      ;(s.game as any).tick(opts.dt, false)
      if (step % 3 === 0) (s.game as any).syncHud()
      const ev = events[i].splice(0)
      for (const e of ev as { e: string }[]) stats[`${s.name}:${e.e}`] = (stats[`${s.name}:${e.e}`] ?? 0) + 1
      rec.add({ k: s.name, step, st: stateOf(s.game), ev, sfx: [...sfxLog], hud: step % 3 === 0 ? hudOf(s.game) : undefined })
      for (const inv of opts.invariants ?? []) {
        const msg = inv(s.game, step)
        if (msg && violations.length < 20) violations.push(`${s.name}@${step}: ${msg}`)
      }
    }
    steps = step + 1
    if (sides.every((s) => s.game.hud.phase === 'over') && sides.every((s) => (s.game as any).__overAt !== undefined && step - (s.game as any).__overAt > 90)) break
    for (const s of sides) if (s.game.hud.phase === 'over' && (s.game as any).__overAt === undefined) (s.game as any).__overAt = step
  }
  const r = sides[0].game.hud.result
  return { hash: rec.digest(), lines: rec.lines, steps, winner: r ? r.winner : null, violations, stats }
}

export function makeGame(role: Role, kind: ElfKind, net: NetLink | null = null) {
  const hud = createHudState(role, kind)
  const container = (globalThis as any).document.createElement('div')
  const minimap = (globalThis as any).document.createElement('canvas')
  return new Game(container, minimap, role, hud, () => {}, net, kind)
}

function withRandom<T>(seed: number, fn: () => T): T {
  const orig = Math.random
  Math.random = seeded(seed)
  try {
    return fn()
  } finally {
    Math.random = orig
  }
}

// ───── 輸入腳本：隨機（但固定種子）按技能鍵、移動、轉視角 ─────
const ELF_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Mouse0', 'Mouse2']
const GOBLIN_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Tab', 'Mouse0']
export function randomPlayer(keys: string[], every = 9) {
  return (game: Game, step: number, rnd: () => number) => {
    if (step % every !== 0) return
    const r = rnd()
    if (r < 0.35) game.setTouchMove(rnd() * 2 - 1, rnd() * 2 - 1)
    else if (r < 0.45) game.setTouchMove(0, 0)
    else if (r < 0.6) game.touchLook((rnd() - 0.5) * 400, (rnd() - 0.5) * 60)
    else game.onAction(keys[Math.floor(rnd() * keys.length)])
  }
}
export const elfPlayer = randomPlayer(ELF_KEYS)
export const goblinPlayer = randomPlayer(GOBLIN_KEYS)

export interface SoloOpts {
  role: Role
  kind: ElfKind
  seed: number
  // ai：精靈角色也交給 AI（role = elf 時）
  mode: 'ai' | 'player' | 'idle'
  duration?: number
  keep?: boolean
  invariants?: Invariant[]
}

export function runSolo(o: SoloOpts): RunResult {
  return withRandom(o.seed, () => {
    setSearch(`?fast=${o.duration ?? 150}`)
    const game = makeGame(o.role, o.kind)
    let script: Side['script']
    if (o.mode === 'ai' && o.role === 'elf') game.elf.isPlayer = false
    if (o.mode === 'ai' && o.role === 'goblin') game.playerGoblin!.isPlayer = false
    if (o.mode === 'player') script = o.role === 'elf' ? elfPlayer : goblinPlayer
    const res = simulate([{ game, name: 'solo', script }], { steps: ((o.duration ?? 150) + 8) * 30, dt: 1 / 30, seed: o.seed, keep: !!o.keep, invariants: o.invariants })
    game.dispose()
    return res
  })
}

// ───── 多人：房主 + 一位加入者，以記憶體中的佇列傳訊（JSON 來回，等同真實序列化）─────
export interface MpOpts {
  kind: ElfKind
  seed: number
  // 加入者操控的角色
  clientSlot: Slot
  duration?: number
  // 第幾步讓加入者斷線（房主改由 AI 接手），之後再重新連回
  leaveAt?: number
  rejoinAt?: number
  // 房主操控的角色交給 AI（精靈 AI 才抓得到人，涵蓋多人的捕獲流程）
  hostAi?: boolean
  keep?: boolean
  invariants?: Invariant[]
}

export function runMultiplayer(o: MpOpts): RunResult {
  return withRandom(o.seed, () => {
    setSearch(`?fast=${o.duration ?? 120}`)
    const CLIENT = 'peer-client'
    const toClient: string[] = []
    const toHost: string[] = []
    const hostListen = new Set<(from: string, m: { t: string }) => void>()
    const clientListen = new Set<(from: string, m: { t: string }) => void>()
    const leave = new Set<(p: string) => void>()
    let rejoin: ((peer: string, prev: Slot, name: string, n: number) => Slot | null) | null = null
    const hostSlot: Slot = o.clientSlot === 'elf' ? 0 : 'elf'
    const names = () => new Map<Slot, string>([[hostSlot, 'Host'], [o.clientSlot, 'Guest']])
    const numbers = () => new Map<Slot, number>([[hostSlot, 1], [o.clientSlot, 2]])
    const hostLink: NetLink = {
      host: true, me: hostSlot, elfKind: o.kind, peers: new Map([[CLIENT, o.clientSlot]]), numbers: numbers(), names: names(),
      send: (msg) => void toClient.push(JSON.stringify(msg)),
      listen: (fn) => (hostListen.add(fn), () => hostListen.delete(fn)),
      onLeave: (fn) => (leave.add(fn), () => leave.delete(fn)),
      onRejoin: (fn) => ((rejoin = fn), () => (rejoin = null)),
    }
    const clientLink: NetLink = {
      host: false, me: o.clientSlot, elfKind: o.kind, peers: new Map(), numbers: numbers(), names: names(),
      send: (msg) => void toHost.push(JSON.stringify(msg)),
      listen: (fn) => (clientListen.add(fn), () => clientListen.delete(fn)),
      onLeave: () => () => {},
      onRejoin: () => () => {},
    }
    const host = makeGame(hostSlot === 'elf' ? 'elf' : 'goblin', o.kind, hostLink)
    const client = makeGame(o.clientSlot === 'elf' ? 'elf' : 'goblin', o.kind, clientLink)
    if (o.hostAi) host.actorOf(hostSlot).isPlayer = false
    let connected = true
    const wire: string[] = []
    const res = simulate(
      [
        { game: host, name: 'host', script: o.hostAi ? undefined : randomPlayer(hostSlot === 'elf' ? ELF_KEYS : GOBLIN_KEYS, 11) },
        { game: client, name: 'client', script: (g, s, r) => connected && randomPlayer(o.clientSlot === 'elf' ? ELF_KEYS : GOBLIN_KEYS, 7)(g, s, r) },
      ],
      {
        steps: ((o.duration ?? 120) + 8) * 30,
        dt: 1 / 30,
        seed: o.seed,
        keep: !!o.keep,
        invariants: o.invariants,
        between: (step) => {
          if (step === o.leaveAt && connected) {
            connected = false
            for (const fn of leave) fn(CLIENT)
          }
          if (step === o.rejoinAt && !connected) {
            connected = true
            const slot = rejoin?.(CLIENT, o.clientSlot, 'Guest', 2)
            wire.push(`rejoin:${slot}`)
          }
          // 投遞上一步累積的訊息
          for (const m of toClient.splice(0)) {
            wire.push('H>' + m)
            if (connected) for (const fn of clientListen) fn('host', JSON.parse(m))
          }
          for (const m of toHost.splice(0)) {
            wire.push('C>' + m)
            if (connected) for (const fn of hostListen) fn(CLIENT, JSON.parse(m))
          }
        },
      },
    )
    // 網路訊息內容也納入雜湊
    const h = createHash('sha256').update(res.hash).update(wire.join('\n')).digest('hex')
    host.dispose()
    client.dispose()
    return { ...res, hash: h }
  })
}
