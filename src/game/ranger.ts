// 遊俠精靈（長笛遊俠）的技能狀態與純判定邏輯（不依賴場景 / 繪圖，方便測試）。設計見 docs/ranger.md
import * as THREE from 'three'
import { CONFIG } from './config'

// 藤蔓陷阱：arm＝還要幾秒才生效（≤0 已生效）、region＝所在區域（地面 / 台地）。陷阱不會隨時間消失
export interface Trap {
  id: number
  pos: THREE.Vector3
  arm: number
  region: number
}

// 吹笛召喚的箭矢：done＝已飛行距離、len＝最遠能飛多遠（射程或牆壁）
export interface Arrow {
  id: number
  // 射出的位置（命中時以此算飛行距離）
  from: THREE.Vector3
  pos: THREE.Vector3
  dir: THREE.Vector3
  done: number
  len: number
}

// 箭矢命中的效果：近距離只減速、遠距離標記、命中已標記 / 減速中的目標＝受困
export type ArrowEffect = 'slow' | 'mark' | 'snare'
export const ARROW_EFFECTS: readonly ArrowEffect[] = ['slow', 'mark', 'snare']

// 陷阱消失的原因：old（保留給舊版協定，目前不會發生）、被踩到、被哥布林拆掉
export const TRAP_GONE = { old: 0, snap: 1, cut: 2 } as const

export class RangerState {
  cd = { arrow: 0, leap: 0 }
  charges: number = CONFIG.ranger.trap.charges
  // 距離下一層充能還有幾秒（充能已滿時為 0）
  recharge = 0
  traps: Trap[] = []
  arrows: Arrow[] = []
  seq = 0
  // 吹笛召喚箭矢中（t＝已吹奏的秒數，受貼身干擾時走得慢）
  // aim＝鎖定的哥布林編號（-1＝沒有，朝 dir 直射）
  draw: { t: number; dir: THREE.Vector3; aim: number } | null = null
  // 吹笛放陷阱中（≥0＝經過的秒數）
  plant = -1
  // 後躍撤步
  leap: { t: number; dir: THREE.Vector3; done: number } | null = null
  // 遠處的哥布林中陷阱後的加速（剩餘秒數）
  haste = 0

  get busy() {
    return this.draw !== null || this.plant >= 0 || this.leap !== null
  }

  // 結算 / 被打斷：停止所有進行中的動作（陷阱與飛行中的箭留在場上）
  cancel() {
    this.draw = null
    this.plant = -1
    this.leap = null
  }
}

interface Marked {
  mark: number
  slow: number
  snare: number
}

// 箭矢命中 flown 公尺外的目標時的效果
export function arrowEffect(flown: number, g: Marked): ArrowEffect {
  if (g.mark > 0 || g.slow > 0 || g.snare > 0) return 'snare'
  return flown > CONFIG.ranger.arrow.fullRange ? 'mark' : 'slow'
}

function d2(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

interface Body {
  pos: THREE.Vector3
  captured: boolean
  disabled: boolean
}

// 貼身干擾：radius 內有行動自如的哥布林（被困 / 暈眩 / 被打包的不算）
export function pressured(pos: THREE.Vector3, goblins: readonly Body[], radius: number) {
  return goblins.some((g) => !g.captured && !g.disabled && d2(g.pos, pos) < radius)
}

// 能不能在 at 放陷阱：被困（或收網中）的哥布林 noTrapRadius 內不行
export function canPlantAt(at: THREE.Vector3, goblins: readonly { pos: THREE.Vector3; captured: boolean; held: boolean; snare: number }[]) {
  const R = CONFIG.ranger.trap.noTrapRadius
  return !goblins.some((g) => !g.captured && (g.held || g.snare > 0) && d2(g.pos, at) < R)
}

// 收網距離的判定：太近 / 剛好 / 太遠
export function reelRange(d: number): 'near' | 'ok' | 'far' {
  const R = CONFIG.ranger.reel
  return d < R.minRange ? 'near' : d > R.maxRange ? 'far' : 'ok'
}

// ───── 藤蔓連鎖 ─────
// 已生效的陷阱彼此相距 linkRange 內（同一區域、視線可及）就以藤蔓相連；三個兩兩相連的陷阱形成一個面。
// 互相連通的陷阱是一條連鎖：踩到任何一個陷阱、連線或面，整條連鎖一起觸發並消耗
export interface TrapChain {
  traps: Trap[]
  links: [Trap, Trap][]
  faces: [Trap, Trap, Trap][]
  region: number
}

// 依陷阱清單算出所有連鎖（每個已生效的陷阱屬於恰好一條，單獨的陷阱是只有一個節點的連鎖）。
// canLink：額外的連線條件（例如兩點之間沒有牆）；結果只依陷阱清單的順序決定，房主與加入者算出來相同
export function trapChains(traps: readonly Trap[], canLink: (a: Trap, b: Trap) => boolean = () => true): TrapChain[] {
  const C = CONFIG.ranger.chain
  const armed = traps.filter((t) => t.arm <= 0)
  const n = armed.length
  const adj: boolean[][] = armed.map(() => new Array(n).fill(false))
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const a = armed[i], b = armed[j]
      if (a.region === b.region && d2(a.pos, b.pos) <= C.linkRange && canLink(a, b)) adj[i][j] = adj[j][i] = true
    }
  const seen = new Array(n).fill(false)
  const out: TrapChain[] = []
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue
    const idx: number[] = []
    const stack = [s]
    seen[s] = true
    while (stack.length) {
      const i = stack.pop()!
      idx.push(i)
      for (let j = 0; j < n; j++)
        if (adj[i][j] && !seen[j]) {
          seen[j] = true
          stack.push(j)
        }
    }
    idx.sort((a, b) => a - b)
    const ch: TrapChain = { traps: idx.map((i) => armed[i]), links: [], faces: [], region: armed[s].region }
    for (let x = 0; x < idx.length; x++)
      for (let y = x + 1; y < idx.length; y++) {
        const i = idx[x], j = idx[y]
        if (!adj[i][j]) continue
        ch.links.push([armed[i], armed[j]])
        for (let z = y + 1; z < idx.length; z++) {
          const k = idx[z]
          if (adj[i][k] && adj[j][k]) ch.faces.push([armed[i], armed[j], armed[k]])
        }
      }
    out.push(ch)
  }
  return out
}

// 點 p 到線段 ab 的水平距離
export function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const abx = b.x - a.x, abz = b.z - a.z
  const L = abx * abx + abz * abz
  const t = L > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / L)) : 0
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t))
}

// 點 p 是否在三角形 abc 內（水平面）
export function inTriangle(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  const s1 = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x)
  const s2 = (c.x - b.x) * (p.z - b.z) - (c.z - b.z) * (p.x - b.x)
  const s3 = (a.x - c.x) * (p.z - c.z) - (a.z - c.z) * (p.x - c.x)
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
}

// 點 p 到連鎖（節點、連線、面）的距離；在面內為 0
export function chainDist(ch: TrapChain, p: THREE.Vector3) {
  for (const [a, b, c] of ch.faces) if (inTriangle(p, a.pos, b.pos, c.pos)) return 0
  let d = Infinity
  for (const t of ch.traps) d = Math.min(d, d2(t.pos, p))
  for (const [a, b] of ch.links) d = Math.min(d, segDist(p, a.pos, b.pos))
  return d
}

// 站在 p 會不會被這條連鎖纏住：陷阱 triggerRadius 內、連線 linkRadius 內、或在面內
export function chainCatches(ch: TrapChain, p: THREE.Vector3) {
  const T = CONFIG.ranger.trap
  const C = CONFIG.ranger.chain
  if (ch.traps.some((t) => d2(t.pos, p) <= T.triggerRadius)) return true
  if (ch.links.some(([a, b]) => segDist(p, a.pos, b.pos) <= C.linkRadius)) return true
  return ch.faces.some(([a, b, c]) => inTriangle(p, a.pos, b.pos, c.pos))
}
