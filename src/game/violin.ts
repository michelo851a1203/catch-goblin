// 紫晶精靈技能的純判定邏輯（不依賴場景 / 繪圖，方便測試）
import * as THREE from 'three'

export interface Target {
  id: number
  pos: THREE.Vector3
  yaw: number
  radius: number
  captured: boolean
  held: boolean
  grace: number
}

function d2(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

// 可以被技能影響的哥布林：還沒被抓、沒被打包、不在掙脫後的無敵時間
export function targetable(g: Target) {
  return !g.captured && !g.held && g.grace <= 0
}

// 刺客之眼瞬移：range 內最近的哥布林（打包中的不算，已掙脫無敵中的仍可瞬移過去）
export function nearestTarget<T extends Target>(pos: THREE.Vector3, list: readonly T[], range: number): T | null {
  let best: T | null = null
  let bd = range
  for (const g of list) {
    if (g.captured || g.held) continue
    const d = d2(g.pos, pos)
    if (d < bd) {
      bd = d
      best = g
    }
  }
  return best
}

// 哥布林身後 dist 公尺（依面向）；out 為輸出
export function behindSpot(g: Target, dist: number, out = new THREE.Vector3()) {
  return out.set(g.pos.x - Math.sin(g.yaw) * dist, 0, g.pos.z - Math.cos(g.yaw) * dist)
}

// 衝鋒的掃掠判定：from → to 這一段（含角色半徑 radius）碰到的第一隻哥布林
export function sweepHit<T extends Target>(from: THREE.Vector3, to: THREE.Vector3, list: readonly T[], radius: number): T | null {
  const dx = to.x - from.x, dz = to.z - from.z
  const len2 = dx * dx + dz * dz
  let best: T | null = null
  let bt = Infinity
  for (const g of list) {
    if (!targetable(g)) continue
    const ox = g.pos.x - from.x, oz = g.pos.z - from.z
    const t = len2 > 1e-9 ? Math.max(0, Math.min(1, (ox * dx + oz * dz) / len2)) : 0
    const px = from.x + dx * t - g.pos.x, pz = from.z + dz * t - g.pos.z
    if (px * px + pz * pz <= (radius + g.radius) ** 2 && t < bt) {
      bt = t
      best = g
    }
  }
  return best
}

// 現身時被嚇到的哥布林
export function fearTargets<T extends Target>(pos: THREE.Vector3, list: readonly T[], radius: number): T[] {
  return list.filter((g) => targetable(g) && d2(g.pos, pos) < radius)
}
