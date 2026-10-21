import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { ElfMagicFx } from '../src/game/elf/ElfMagicFx'
import type { ParticleSpec } from '../src/game/fx/Particles'

function sinks() {
  const glow: ParticleSpec[] = []
  const soft: ParticleSpec[] = []
  const specs = new Set<ParticleSpec>()
  const rec = (arr: ParticleSpec[]) => ({
    spawn(s: ParticleSpec) {
      specs.add(s)
      arr.push({ ...s })
    },
  })
  return { glow, soft, specs, particles: { glow: rec(glow), soft: rec(soft) } }
}

describe('ElfMagicFx', () => {
  it('魔法陣使用固定大小物件池，不會一直新增物件', () => {
    const scene = new THREE.Scene()
    const { particles } = sinks()
    const fx = new ElfMagicFx(scene, particles, 6)
    const before = scene.children.length
    const p = new THREE.Vector3()
    for (let i = 0; i < 50; i++) fx.magicRing(p, 2, 0xffffff, 1)
    expect(scene.children.length).toBe(before)
    expect(fx.activeRings).toBe(6)
    for (let i = 0; i < 100; i++) fx.update(0.05)
    expect(fx.activeRings).toBe(0)
  })

  it('粒子 spec 重複使用同一個物件（熱路徑無配置）', () => {
    const { particles, specs, glow } = sinks()
    const fx = new ElfMagicFx(new THREE.Scene(), particles)
    const p = new THREE.Vector3()
    for (let i = 0; i < 60; i++) fx.musicTick(1 / 60, p, 17)
    fx.ambient(2, p, 1)
    expect(glow.length).toBeGreaterThan(5)
    expect(specs.size).toBe(1)
  })

  it('每個技能都會產生特效', () => {
    const { particles, glow, soft } = sinks()
    const fx = new ElfMagicFx(new THREE.Scene(), particles)
    const p = new THREE.Vector3()
    fx.gaze(p, new THREE.Vector3(0, 0, 1))
    expect(soft.length).toBe(14)
    fx.stun(p)
    expect(glow.length).toBe(10)
    fx.capture(p)
    fx.musicStart(p)
    expect(soft.length).toBe(38)
    expect(fx.activeRings).toBe(3)
  })

  it('跟隨型魔法陣跟著角色移動', () => {
    const scene = new THREE.Scene()
    const { particles } = sinks()
    const fx = new ElfMagicFx(scene, particles)
    const pos = new THREE.Vector3(1, 0, 1)
    const ring = fx.magicRing(pos, 2, 0xffffff, 1, true)
    pos.set(5, 0, 5)
    fx.update(0.1)
    expect(ring.mesh.position.x).toBe(5)
  })

  it('dispose 釋放所有魔法陣', () => {
    const scene = new THREE.Scene()
    const { particles } = sinks()
    const fx = new ElfMagicFx(scene, particles, 4)
    fx.dispose()
    expect(scene.children.length).toBe(0)
    expect(fx.poolSize).toBe(0)
  })
})
