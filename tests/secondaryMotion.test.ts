import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { SecondaryMotion, type SpringParams } from '../src/game/elf/SecondaryMotion'

// 一條往下垂的三節骨鏈，掛在可移動的根節點上
function rig(p: SpringParams) {
  const root = new THREE.Group()
  const bones: THREE.Bone[] = []
  let parent: THREE.Object3D = root
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Bone()
    b.position.set(0, i === 0 ? 1 : -0.25, 0)
    if (i === 0) b.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI) // 區域 +Y 朝下
    else b.position.set(0, 0.25, 0)
    parent.add(b)
    parent = b
    bones.push(b)
  }
  const sm = new SecondaryMotion()
  sm.random = () => 0.5
  sm.addChain(bones, p)
  const tip = new THREE.Object3D()
  tip.position.set(0, 0.25, 0)
  bones[2].add(tip)
  // speed(i)：第 i 幀的前進速度（m/s，沿 +Z）
  const run = (frames: number, speed: (i: number) => number, each?: (i: number) => void) => {
    for (let i = 0; i < frames; i++) {
      root.position.z += speed(i) / 60
      root.updateMatrixWorld(true)
      sm.update(1 / 60, root)
      root.updateMatrixWorld(true)
      each?.(i)
    }
  }
  // 尖端在根節點後方多遠（正值 = 往後飄）、離地高度
  const trail = () => root.position.z - tip.getWorldPosition(new THREE.Vector3()).z
  const height = () => tip.getWorldPosition(new THREE.Vector3()).y
  return { run, trail, height, bones }
}

const BASE: SpringParams = { stiffness: 0.03, gravity: 0.018, drag: 0.12, hitRadius: 0.03, maxAngle: 0.85, wind: 0, colliders: 0 }

describe('SecondaryMotion：薄紗用的選用參數', () => {
  it('不設定 air / airMax / inertia 時與原本的 Verlet 完全相同（air 預設 = drag）', () => {
    const a = rig({ ...BASE, drag: 0.2 })
    const b = rig({ ...BASE, drag: 0.2, air: 0.2 })
    const speed = (i: number) => (i < 60 ? 6 : i < 90 ? 0 : 3)
    const qa: number[] = [], qb: number[] = []
    a.run(140, speed, () => qa.push(...a.bones.flatMap((x) => x.quaternion.toArray())))
    b.run(140, speed, () => qb.push(...b.bones.flatMap((x) => x.quaternion.toArray())))
    expect(qa.length).toBe(qb.length)
    for (let i = 0; i < qa.length; i++) expect(qa[i]).toBeCloseTo(qb[i], 9)
  })

  it('移動時往後飄；airMax 限制迎風量：全速也不會被吹成水平', () => {
    const free = rig({ ...BASE, air: 0.16 })
    const capped = rig({ ...BASE, air: 0.16, airMax: 0.036 })
    free.run(240, () => 7.4)
    capped.run(240, () => 7.4)
    expect(capped.trail()).toBeGreaterThan(0.15) // 仍然明顯往後飄
    expect(capped.trail()).toBeLessThan(free.trail())
    expect(capped.height()).toBeLessThan(free.height() - 0.1) // 沒有上限時尾端被吹得高很多
  })

  it('走路的速度就飄得起來（迎風量未達上限時與速度成正比）', () => {
    const still = rig({ ...BASE, air: 0.16, airMax: 0.036 })
    const walk = rig({ ...BASE, air: 0.16, airMax: 0.036 })
    still.run(240, () => 0)
    walk.run(240, () => 2)
    expect(walk.trail() - still.trail()).toBeGreaterThan(0.1)
  })

  it('inertia < 1：急停時不會整條甩到前面', () => {
    const full = rig({ ...BASE, air: 0.16, airMax: 0.036 })
    const soft = rig({ ...BASE, air: 0.16, airMax: 0.036, inertia: 0.4 })
    const ahead = (r: ReturnType<typeof rig>) => {
      let m = -Infinity
      r.run(120, () => 7.4)
      r.run(90, () => 0, () => (m = Math.max(m, -r.trail())))
      return m
    }
    const a = ahead(full), b = ahead(soft)
    expect(a).toBeGreaterThan(0.3) // 完全的慣性：尖端甩到根節點前方
    expect(b).toBeLessThan(a * 0.6)
  })

  it('flutter：移動時形狀持續變化，靜止時不抖', () => {
    const r = rig({ ...BASE, air: 0.16, airMax: 0.036, flutter: 0.045 })
    r.run(240, () => 7.4)
    const hs: number[] = []
    r.run(60, () => 7.4, () => hs.push(r.height()))
    expect(Math.max(...hs) - Math.min(...hs)).toBeGreaterThan(0.01)
    r.run(300, () => 0)
    const rest: number[] = []
    r.run(60, () => 0, () => rest.push(r.height()))
    expect(Math.max(...rest) - Math.min(...rest)).toBeLessThan(0.002)
  })
})
