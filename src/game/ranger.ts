// 遊俠精靈（長笛遊俠）的技能狀態與純判定邏輯（不依賴場景 / 繪圖，方便測試）。設計見 docs/ranger.md
import * as THREE from 'three'
import { CONFIG } from './config'

// 藤蔓陷阱：arm＝還要幾秒才生效（≤0 已生效）、life＝剩餘存在秒數、region＝所在區域（地面 / 台地）
export interface Trap {
  id: number
  pos: THREE.Vector3
  arm: number
  life: number
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

// 陷阱消失的原因：存在時間到 / 超過數量上限、被踩到、被哥布林拆掉
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
