import * as THREE from 'three'
import { CELL } from '../fx/atlas'
import type { ParticleSpec } from '../fx/Particles'
import { Ribbon } from '../fx/Ribbon'
import type { ElfMagicFx, ParticleSink } from './ElfMagicFx'

const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const NEBULA = [0x8a5cff, 0xa98bff, 0xd2b0ff, 0xff9fe0, 0x7d9bff]
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]
const UP = new THREE.Vector3(0, 1, 0)
const v1 = new THREE.Vector3()
const v2 = new THREE.Vector3()
const v3 = new THREE.Vector3()

// 紫晶精靈的技能特效：星雲紫霧、紫色音符、星空風絲帶、瞬移星塵、恐懼音符。
// 粒子沿用 FxSystem 的環形緩衝；魔法陣借用 ElfMagicFx 的物件池；絲帶是常駐的 3 條 Ribbon
export class ViolinFx {
  private glow: ParticleSink
  private soft: ParticleSink
  private rings: ElfMagicFx
  private scene: THREE.Scene
  private spec: ParticleSpec = { x: 0, y: 0, z: 0 }
  private ribbons: Ribbon[]
  private acc = { cast: 0, ghost: 0, wind: 0, dash: 0 }
  private t = 0

  constructor(scene: THREE.Scene, particles: { glow: ParticleSink; soft: ParticleSink }, rings: ElfMagicFx) {
    this.scene = scene
    this.glow = particles.glow
    this.soft = particles.soft
    this.rings = rings
    this.ribbons = [
      new Ribbon(56, 0.6, 0.32, [0x8a4dff, 0xe060c8, 0x4f8cff]),
      new Ribbon(56, 0.55, 0.26, [0x6b3cff, 0xa070ff, 0x5ab0ff]),
      new Ribbon(56, 0.7, 0.2, [0xc89bff, 0x9b5cff, 0xff7fd0]),
    ]
    for (const r of this.ribbons) scene.add(r.mesh)
  }

  private emit(sink: ParticleSink, fill: (s: ParticleSpec) => void) {
    const s = this.spec
    s.vx = s.vy = s.vz = 0
    s.gravity = s.drag = s.spin = s.wobble = 0
    s.rot = Math.random() * 6.28
    s.fadeIn = 0.08
    s.grow = 1
    s.alpha = 1
    s.color2 = undefined
    fill(s)
    sink.spawn(s)
  }

  // 星雲紫霧（一團向外擴散後迅速散去）
  private nebula(pos: THREE.Vector3, n: number, radius: number, life: number, y = 1) {
    for (let i = 0; i < n; i++) {
      this.emit(this.soft, (s) => {
        const a = Math.random() * Math.PI * 2
        const sp = rnd(0.6, 1.6) * radius
        s.x = pos.x + Math.cos(a) * 0.3
        s.y = y + rnd(-0.5, 0.8)
        s.z = pos.z + Math.sin(a) * 0.3
        s.vx = Math.cos(a) * sp
        s.vy = rnd(0.1, 0.9)
        s.vz = Math.sin(a) * sp
        s.color = pick(NEBULA)
        s.color2 = 0x7a5cc0
        s.size = rnd(0.8, 1.4)
        s.grow = rnd(2.2, 3.4)
        s.life = rnd(0.7, 1) * life
        s.cell = CELL.smoke
        s.alpha = rnd(0.35, 0.6)
        s.drag = 2.2
        s.spin = rnd(-1.2, 1.2)
        s.fadeIn = 0.05
      })
    }
    // 星塵與閃光
    for (let i = 0; i < n; i++) {
      this.emit(this.glow, (s) => {
        const a = Math.random() * Math.PI * 2
        const sp = rnd(0.8, 2.4) * radius
        s.x = pos.x + rnd(-0.4, 0.4)
        s.y = y + rnd(-0.4, 1)
        s.z = pos.z + rnd(-0.4, 0.4)
        s.vx = Math.cos(a) * sp
        s.vy = rnd(-0.2, 1.4)
        s.vz = Math.sin(a) * sp
        s.color = Math.random() < 0.5 ? 0xe8d8ff : 0xffc8f0
        s.color2 = 0x9b6bff
        s.size = rnd(0.1, 0.24)
        s.life = rnd(0.6, 1.2) * life
        s.cell = Math.random() < 0.5 ? CELL.star : CELL.sparkle
        s.spin = rnd(-6, 6)
        s.drag = 1.8
      })
    }
  }

  private notes(pos: THREE.Vector3, n: number, y = 1.5, speed = 1.6) {
    for (let i = 0; i < n; i++) {
      this.emit(this.glow, (s) => {
        const a = Math.random() * Math.PI * 2
        const sp = rnd(0.5, 1) * speed
        s.x = pos.x + Math.cos(a) * 0.3
        s.y = y + rnd(-0.2, 0.4)
        s.z = pos.z + Math.sin(a) * 0.3
        s.vx = Math.cos(a) * sp
        s.vy = rnd(0.5, 1.4)
        s.vz = Math.sin(a) * sp
        s.color = Math.random() < 0.5 ? 0xb07cff : 0xd8a8ff
        s.color2 = 0xffe0ff
        s.size = rnd(0.22, 0.34)
        s.life = rnd(1.1, 1.7)
        s.cell = Math.random() < 0.5 ? CELL.note : CELL.notes
        s.wobble = 0.7
        s.drag = 0.6
        s.fadeIn = 0.12
      })
    }
  }

  // ── 隱身 ──
  // 拉琴中（每幀）：紫色音符從琴弓飄出、星雲紫霧在腳邊繞圈聚集
  castTick(dt: number, pos: THREE.Vector3, k: number) {
    this.acc.cast += dt * (14 + k * 30)
    while (this.acc.cast >= 1) {
      this.acc.cast -= 1
      if (Math.random() < 0.45) this.notes(pos, 1, 1.45, 1.1)
      this.emit(this.soft, (s) => {
        const a = this.t * 3 + Math.random() * Math.PI * 2
        const r = rnd(0.8, 1.8) * (1 - k * 0.5)
        s.x = pos.x + Math.cos(a) * r
        s.y = rnd(0.1, 1.6)
        s.z = pos.z + Math.sin(a) * r
        s.vx = -Math.sin(a) * 1.6 - Math.cos(a) * 0.6
        s.vz = Math.cos(a) * 1.6 - Math.sin(a) * 0.6
        s.vy = rnd(0.1, 0.5)
        s.color = pick(NEBULA)
        s.color2 = 0x8a6ad0
        s.size = rnd(0.6, 1.0)
        s.grow = 2
        s.life = rnd(0.7, 1.1)
        s.cell = CELL.smoke
        s.alpha = 0.4
        s.drag = 0.8
        s.spin = rnd(-1, 1)
      })
    }
  }

  castStart(pos: THREE.Vector3) {
    this.rings.magicRing(pos, 1.8, 0xb48cff, 0.9, true)
  }

  // 隱身的瞬間：一大團星雲紫霧迅速散去（所有人都看得到）
  vanish(pos: THREE.Vector3) {
    this.nebula(pos, 34, 1.6, 1.3)
    this.notes(pos, 12, 1.4, 2.2)
    this.rings.magicRing(pos, 2.4, 0x9b6bff, 0.8)
  }

  // 現身：較小的紫霧；嚇到哥布林時擴散一圈恐懼波紋
  reveal(pos: THREE.Vector3, fearRadius: number) {
    this.nebula(pos, 18, 1.1, 1)
    if (fearRadius > 0) {
      this.rings.magicRing(pos, fearRadius, 0xc070ff, 1.0)
      this.notes(pos, 16, 1.2, 4)
    }
  }

  // 隱身中（只有精靈玩家自己看得到）：淡淡的紫色光點
  ghostTick(dt: number, pos: THREE.Vector3, move: number) {
    this.acc.ghost += dt * (3 + move * 8)
    while (this.acc.ghost >= 1) {
      this.acc.ghost -= 1
      this.emit(this.glow, (s) => {
        s.x = pos.x + rnd(-0.4, 0.4)
        s.y = rnd(0.2, 1.7)
        s.z = pos.z + rnd(-0.4, 0.4)
        s.vy = rnd(0.1, 0.4)
        s.color = 0xb48cff
        s.color2 = 0x6b3cff
        s.size = rnd(0.08, 0.14)
        s.life = rnd(0.6, 1)
        s.cell = CELL.glow
        s.alpha = 0.6
        s.wobble = 0.3
      })
    }
  }

  // ── 刺客之眼 ──
  eyeCast(pos: THREE.Vector3) {
    this.rings.magicRing(pos, 2.0, 0xc89bff, 0.9)
    for (let i = 0; i < 18; i++) {
      this.emit(this.glow, (s) => {
        const a = (i / 18) * Math.PI * 2
        s.x = pos.x + Math.cos(a) * 1.4
        s.y = 1.55
        s.z = pos.z + Math.sin(a) * 1.4
        s.vx = -Math.cos(a) * 2.6
        s.vz = -Math.sin(a) * 2.6
        s.vy = 0.1
        s.color = 0xe8d8ff
        s.color2 = 0x9b6bff
        s.size = rnd(0.12, 0.2)
        s.life = 0.5
        s.cell = CELL.sparkle
        s.spin = 5
      })
    }
  }

  // 瞬移：起點與終點各一團星空紫霧，中間一道星塵
  blink(from: THREE.Vector3, to: THREE.Vector3) {
    this.nebula(from, 22, 1.2, 1.1)
    this.nebula(to, 26, 1.3, 1.2)
    this.notes(to, 10, 1.4, 2)
    this.rings.magicRing(to, 1.8, 0xb48cff, 0.7)
    const n = Math.min(40, Math.ceil(from.distanceTo(to) * 1.5))
    for (let i = 0; i < n; i++) {
      const k = i / n
      this.emit(this.glow, (s) => {
        s.x = from.x + (to.x - from.x) * k + rnd(-0.2, 0.2)
        s.y = 1 + Math.sin(k * Math.PI) * 1.2 + rnd(-0.2, 0.2)
        s.z = from.z + (to.z - from.z) * k + rnd(-0.2, 0.2)
        s.vy = rnd(0, 0.4)
        s.color = 0xe0c8ff
        s.color2 = 0x7a4cff
        s.size = rnd(0.12, 0.22)
        s.life = rnd(0.4, 0.8)
        s.cell = CELL.star
        s.spin = 4
      })
    }
  }

  // ── 衝鋒 ──
  windupStart(pos: THREE.Vector3) {
    this.rings.magicRing(pos, 1.5, 0xb48cff, 0.6, true)
  }

  // 前搖：紫色星塵往身上聚集
  windupTick(dt: number, pos: THREE.Vector3) {
    this.acc.wind += dt * 40
    while (this.acc.wind >= 1) {
      this.acc.wind -= 1
      this.emit(this.glow, (s) => {
        const a = Math.random() * Math.PI * 2
        const r = rnd(1.2, 2)
        s.x = pos.x + Math.cos(a) * r
        s.y = rnd(0.3, 1.8)
        s.z = pos.z + Math.sin(a) * r
        s.vx = -Math.cos(a) * r * 3
        s.vz = -Math.sin(a) * r * 3
        s.vy = (1 - s.y) * 2
        s.color = Math.random() < 0.5 ? 0xc89bff : 0xff9fe0
        s.color2 = 0xffffff
        s.size = rnd(0.1, 0.2)
        s.life = 0.3
        s.cell = CELL.sparkle
        s.spin = 6
      })
    }
  }

  dashStart(pos: THREE.Vector3, dir: THREE.Vector3) {
    for (const r of this.ribbons) r.clear()
    this.rings.magicRing(pos, 1.4, 0xd8a8ff, 0.5)
    for (let i = 0; i < 16; i++) {
      this.emit(this.soft, (s) => {
        const a = Math.random() * Math.PI * 2
        s.x = pos.x
        s.y = 0.2
        s.z = pos.z
        s.vx = Math.cos(a) * 2 - dir.x * 2
        s.vz = Math.sin(a) * 2 - dir.z * 2
        s.vy = rnd(0.2, 0.8)
        s.color = pick(NEBULA)
        s.size = rnd(0.4, 0.7)
        s.grow = 2.5
        s.life = rnd(0.5, 0.8)
        s.cell = CELL.smoke
        s.alpha = 0.5
        s.drag = 2.5
      })
    }
  }

  // 突刺中（每幀）：三條星空風絲帶以螺旋繞著衝刺路徑，身後灑落星塵與音符
  dashTick(dt: number, pos: THREE.Vector3, dir: THREE.Vector3) {
    const right = v1.crossVectors(dir, UP).normalize()
    this.ribbons.forEach((r, i) => {
      const ph = this.t * 13 + (i * Math.PI * 2) / 3
      const rad = 0.55 + 0.15 * i
      const c = Math.cos(ph), s = Math.sin(ph)
      const p = v2.copy(pos).addScaledVector(right, c * rad)
      p.y = 1.0 + s * rad * 0.8 + i * 0.08
      // 寬度方向 = 螺旋的切線 → 緞帶像被風捲起的絲綢
      const side = v3.set(0, 0, 0).addScaledVector(right, -s).addScaledVector(UP, c * 0.8).addScaledVector(dir, 0.15)
      r.push(p, side)
    })
    this.acc.dash += dt * 70
    while (this.acc.dash >= 1) {
      this.acc.dash -= 1
      this.emit(this.glow, (s) => {
        s.x = pos.x + rnd(-0.5, 0.5)
        s.y = rnd(0.3, 1.8)
        s.z = pos.z + rnd(-0.5, 0.5)
        s.vx = -dir.x * rnd(1, 4) + rnd(-0.5, 0.5)
        s.vz = -dir.z * rnd(1, 4) + rnd(-0.5, 0.5)
        s.vy = rnd(-0.2, 0.6)
        s.color = pick([0xe8d8ff, 0xc89bff, 0xff9fe0, 0x9fd8ff])
        s.color2 = 0x6b3cff
        s.size = rnd(0.1, 0.26)
        s.life = rnd(0.4, 0.9)
        s.cell = Math.random() < 0.6 ? CELL.star : CELL.sparkle
        s.spin = rnd(-6, 6)
        s.drag = 1.5
      })
      if (Math.random() < 0.08) this.notes(pos, 1, 1.2, 1)
    }
  }

  // 命中：紫色星爆 + 音符
  chargeHit(pos: THREE.Vector3) {
    this.nebula(pos, 12, 1, 0.8, 1.1)
    this.notes(pos, 8, 1.6, 2.5)
    this.rings.magicRing(pos, 1.6, 0xff9fe0, 0.6)
  }

  // 恐懼中的哥布林：頭上冒紫色音符（呼叫端依每隻哥布林的速率呼叫）
  fearNote(pos: THREE.Vector3) {
    this.emit(this.glow, (s) => {
      s.x = pos.x + rnd(-0.3, 0.3)
      s.y = 1.6
      s.z = pos.z + rnd(-0.3, 0.3)
      s.vy = 0.7
      s.color = 0xb07cff
      s.color2 = 0xe8c8ff
      s.size = rnd(0.28, 0.36)
      s.life = 1.1
      s.cell = Math.random() < 0.5 ? CELL.note : CELL.notes
      s.wobble = 0.6
    })
  }

  update(dt: number) {
    this.t += dt
    for (const r of this.ribbons) r.update(dt)
  }

  dispose() {
    for (const r of this.ribbons) {
      this.scene.remove(r.mesh)
      r.dispose()
    }
    this.ribbons = []
  }
}
