import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 純 JS 工具腳本，無型別宣告
import { inspectGlb } from '../tools/validate-glb.mjs'
import { CONFIG } from '../src/game/config'
import { ElfAnimState } from '../src/game/elf/ElfAnimState'
import { ElfCharacter } from '../src/game/elf/ElfCharacter'
import { VIOLINIST_ANIM, VIOLINIST_CLIPS, VIOLINIST_RIG } from '../src/game/elf/rigs'
import { behindSpot, fearTargets, nearestTarget, sweepHit, type Target } from '../src/game/violin'
import { fakeFallback, fileLoad, VIOLINIST_GLB } from './helpers'

const g = (id: number, x: number, z: number, extra: Partial<Target> = {}): Target => ({
  id, pos: new THREE.Vector3(x, 0, z), yaw: 0, radius: 0.55, captured: false, held: false, grace: 0, ...extra,
})

describe('紫晶精靈技能判定', () => {
  it('衝鋒掃掠：命中路徑上最先碰到的那一隻（單體）', () => {
    const list = [g(0, 0, 6), g(1, 0, 3), g(2, 3, 3)]
    const hit = sweepHit(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 9), list, 0.8)
    expect(hit?.id).toBe(1)
  })

  it('衝鋒不會撞到已被抓 / 打包中 / 掙脫無敵的哥布林', () => {
    const list = [g(0, 0, 2, { captured: true }), g(1, 0, 3, { held: true }), g(2, 0, 4, { grace: 1 }), g(3, 0, 8)]
    expect(sweepHit(new THREE.Vector3(), new THREE.Vector3(0, 0, 9), list, 0.8)?.id).toBe(3)
  })

  it('衝鋒落空：路徑旁太遠的不算', () => {
    expect(sweepHit(new THREE.Vector3(), new THREE.Vector3(0, 0, 9), [g(0, 2, 4)], 0.8)).toBeNull()
  })

  it('瞬移：範圍內最近的哥布林；超出範圍時為 null', () => {
    const list = [g(0, 10, 0), g(1, 30, 0), g(2, 3, 0, { held: true })]
    expect(nearestTarget(new THREE.Vector3(), list, 45)?.id).toBe(0)
    expect(nearestTarget(new THREE.Vector3(), [g(0, 60, 0)], 45)).toBeNull()
  })

  it('瞬移到哥布林身後（依面向）', () => {
    const t = g(0, 5, 5, { yaw: 0 }) // 面向 +Z
    const p = behindSpot(t, CONFIG.violin.eye.behind)
    expect(p.x).toBeCloseTo(5)
    expect(p.z).toBeCloseTo(5 - CONFIG.violin.eye.behind)
  })

  it('現身恐懼只影響半徑內、可被影響的哥布林', () => {
    const list = [g(0, 2, 0), g(1, 9, 0), g(2, 1, 1, { held: true })]
    expect(fearTargets(new THREE.Vector3(), list, CONFIG.violin.stealth.fearRadius).map((x) => x.id)).toEqual([0])
  })

  it('平衡：與預設精靈同速、衝鋒距離大於打暈距離、各技能冷卻符合設計', () => {
    const V = CONFIG.violin
    expect(CONFIG.elf.speed).toBeGreaterThan(CONFIG.goblin.speed)
    expect(V.charge.distance).toBeGreaterThan(CONFIG.elf.stun.range * 2)
    expect([V.stealth.duration, V.stealth.cooldown, V.stealth.fearTime]).toEqual([15, 12, 3])
    expect([V.eye.duration, V.eye.cooldown]).toEqual([20, 20])
    expect([V.charge.windup, V.charge.stun, V.charge.cooldown]).toEqual([0.5, 1.5, 7])
  })
})

describe('紫晶精靈動畫狀態機', () => {
  it('衝鋒三段姿勢對應到前搖 / 突刺 / 收招動作', () => {
    const s = new ElfAnimState(VIOLINIST_ANIM)
    expect(s.update('windup', 0).clip).toBe('ChargeWindup')
    expect(s.update('dash', 1.3).clip).toBe('ChargeDash')
    expect(s.update('recover', 0).clip).toBe('ChargeRecover')
    expect(s.update('play', 0).clip).toBe('Play')
    expect(s.update('pack', 0).clip).toBe('Capture')
  })

  it('步態依 Mixamo 量測的參考速度播放（不滑步）', () => {
    const s = new ElfAnimState(VIOLINIST_ANIM)
    const r = s.update('normal', 1, 7.4)
    expect(r.clip).toBe('Run')
    expect(r.timeScale * VIOLINIST_ANIM.gaitRef.Run).toBeCloseTo(7.4, 5)
  })
})

describe('紫晶精靈 GLB', () => {
  const info = inspectGlb(readFileSync(VIOLINIST_GLB))

  it('結構無錯誤，包含所有動作、LOD 與道具骨', () => {
    expect(info.errors).toEqual([])
    const names = info.animations.map((a: { name: string }) => a.name)
    for (const c of VIOLINIST_CLIPS) expect(names).toContain(c)
    for (const n of [...VIOLINIST_RIG.lod, 'prop_violin', 'prop_bow', 'Violin', 'Bow']) expect(info.nodes).toContain(n)
  })

  it('尺寸：約 1.7m；Mixamo rest（T-pose）腳底比動作中低約 0.1m（動作的骨盆位移會把腳放回地面）', () => {
    expect(info.bounds.size[1]).toBeGreaterThan(1.5)
    expect(info.bounds.size[1]).toBeLessThan(1.95)
    expect(info.bounds.min[1]).toBeGreaterThan(-0.15)
    expect(info.bounds.min[1]).toBeLessThan(0.05)
  })

  it('ElfCharacter 以紫晶規格載入，小提琴掛在左手的 prop_violin 骨', async () => {
    const elf = new ElfCharacter({ rig: VIOLINIST_RIG, load: fileLoad, fallback: fakeFallback(), lowEnd: false })
    await elf.ready
    expect(elf.status).toBe('ready')
    expect([...elf.actions.keys()].sort()).toEqual([...VIOLINIST_CLIPS].sort())
    const chain: string[] = []
    let p: THREE.Object3D | null = elf.root.getObjectByName('Violin')!
    while (p) {
      chain.push(p.name)
      p = p.parent
    }
    expect(chain).toContain('prop_violin')
    expect(chain).toContain('LeftHand')
    // 所有姿勢都能播放
    for (const pose of ['normal', 'play', 'cast', 'windup', 'dash', 'recover', 'pack', 'stunned'] as const) elf.animate(0.05, 0, pose)
    // 隱身：完全看不見 / 半透明 / 恢復
    elf.setOpacity(0)
    expect(elf.root.visible).toBe(false)
    elf.setOpacity(0.3)
    expect(elf.root.visible).toBe(true)
    elf.setOpacity(1)
    elf.dispose()
  })
})
