import * as THREE from 'three'
import { CELL } from '../fx/atlas'
import type { ParticleSpec } from '../fx/Particles'
import { noOutline } from '../toon'

export interface ParticleSink {
  spawn(s: ParticleSpec): void
}

// 魔法陣：雙環 + 旋轉刻度 + 內圈花瓣紋，全部在 fragment shader 內畫
function magicRingMaterial() {
  return noOutline(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color() }, uA: { value: 0 }, uP: { value: 0 }, uT: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uA; uniform float uP; uniform float uT;
        varying vec2 vUv;
        float band(float r, float c, float w) { return smoothstep(w, 0.0, abs(r - c)); }
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float a = atan(p.y, p.x);
          float R = mix(0.25, 0.96, uP);
          float v = band(r, R, 0.018) + band(r, R * 0.86, 0.008) * 0.8;
          float ticks = step(0.75, fract((a + uT * 0.8) * 24.0 / 6.2832)) * step(R * 0.87, r) * step(r, R * 0.97);
          float petals = band(r, R * (0.55 + 0.08 * cos(a * 6.0 - uT)), 0.01) * 0.7;
          float glow = exp(-abs(r - R) * 14.0) * 0.35;
          float alpha = (v + ticks * 0.6 + petals + glow) * uA;
          if (alpha < 0.003) discard;
          gl_FragColor = vec4(uColor * alpha, alpha);
        }`,
    }),
  )
}

interface PooledRing {
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial
  life: number
  max: number
  follow: THREE.Vector3 | null
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

// 女精靈技能特效：飄落花瓣、金色音符、魔法陣、愛心。
// 粒子沿用 FxSystem 的環形緩衝（不產生新物件）；魔法陣用固定大小的物件池。
export class ElfMagicFx {
  private rings: PooledRing[] = []
  private scene: THREE.Scene
  private glow: ParticleSink
  private soft: ParticleSink
  private geo = new THREE.PlaneGeometry(2, 2)
  private acc = { petal: 0, note: 0, aura: 0 }
  private t = 0
  // 重複使用的 spec，避免熱路徑上每顆粒子都配置物件
  private spec: ParticleSpec = { x: 0, y: 0, z: 0 }

  constructor(scene: THREE.Scene, particles: { glow: ParticleSink; soft: ParticleSink }, poolSize = 10) {
    this.scene = scene
    this.glow = particles.glow
    this.soft = particles.soft
    for (let i = 0; i < poolSize; i++) {
      const mat = magicRingMaterial()
      const mesh = new THREE.Mesh(this.geo, mat)
      mesh.rotation.x = -Math.PI / 2
      mesh.renderOrder = 4
      mesh.visible = false
      mesh.frustumCulled = false
      scene.add(mesh)
      this.rings.push({ mesh, mat, life: 0, max: 1, follow: null })
    }
  }

  get poolSize() {
    return this.rings.length
  }

  get activeRings() {
    return this.rings.filter((r) => r.life > 0).length
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

  // 從池中取出最舊的魔法陣
  magicRing(pos: THREE.Vector3, radius: number, color: number, life = 1.2, follow = false) {
    let r = this.rings[0]
    for (const c of this.rings) if (c.life <= 0 || c.life < r.life) r = c
    r.life = r.max = life
    r.follow = follow ? pos : null
    r.mat.uniforms.uColor.value.setHex(color)
    r.mat.uniforms.uP.value = 0
    r.mat.uniforms.uA.value = 1
    r.mesh.scale.setScalar(radius)
    r.mesh.position.set(pos.x, 0.08, pos.z)
    r.mesh.visible = true
    return r
  }

  // Q：魔法凝視 — 柔和的愛心從眼睛飄出
  gaze(pos: THREE.Vector3, dir: THREE.Vector3) {
    for (let i = 0; i < 14; i++) {
      this.emit(this.soft, (s) => {
        const sp = rnd(1.2, 3.2)
        s.x = pos.x + dir.x * 0.35 + rnd(-0.15, 0.15)
        s.y = 1.6 + rnd(-0.1, 0.15)
        s.z = pos.z + dir.z * 0.35 + rnd(-0.15, 0.15)
        s.vx = dir.x * sp + rnd(-0.5, 0.5)
        s.vy = rnd(0.3, 1.2)
        s.vz = dir.z * sp + rnd(-0.5, 0.5)
        s.color = 0xff8cc6
        s.color2 = 0xffe0ef
        s.size = rnd(0.16, 0.3)
        s.life = rnd(0.9, 1.5)
        s.cell = CELL.heart
        s.drag = 1.6
        s.wobble = 0.5
        s.spin = rnd(-1.5, 1.5)
        s.fadeIn = 0.08
      })
    }
    this.magicRing(pos, 1.3, 0xff9ccc, 0.6)
  }

  // E：開始彈奏 — 金色魔法陣
  musicStart(pos: THREE.Vector3) {
    this.magicRing(pos, 2.2, 0xffe08a, 1.0, true)
  }

  // E：彈奏中每幀呼叫 — 金色音符往外擴散、週期性的吸引波紋
  musicTick(dt: number, pos: THREE.Vector3, radius: number) {
    this.acc.note += dt * 14
    while (this.acc.note >= 1) {
      this.acc.note -= 1
      this.emit(this.glow, (s) => {
        const a = Math.random() * Math.PI * 2
        const sp = rnd(1.5, 3.5)
        s.x = pos.x + Math.cos(a) * 0.4
        s.y = 1.1 + rnd(0, 0.6)
        s.z = pos.z + Math.sin(a) * 0.4
        s.vx = Math.cos(a) * sp
        s.vy = rnd(0.4, 1.1)
        s.vz = Math.sin(a) * sp
        s.color = 0xf2b640
        s.color2 = 0xffe9a8
        s.size = rnd(0.2, 0.3)
        s.alpha = 0.85
        s.life = rnd(1.2, 1.8)
        s.cell = Math.random() < 0.5 ? CELL.note : CELL.notes
        s.wobble = 0.6
        s.drag = 0.4
        s.fadeIn = 0.1
      })
    }
    const prev = this.t
    this.t += dt
    if (Math.floor(this.t / 0.8) !== Math.floor(prev / 0.8)) this.magicRing(pos, radius * 0.5, 0xfff0b8, 1.6)
  }

  // F：暈眩 — 輕微的魔法回饋
  stun(pos: THREE.Vector3) {
    for (let i = 0; i < 10; i++) {
      this.emit(this.glow, (s) => {
        const a = (i / 10) * Math.PI * 2
        s.x = pos.x + Math.cos(a) * 0.5
        s.y = 1.7
        s.z = pos.z + Math.sin(a) * 0.5
        s.vx = -Math.sin(a) * 1.4
        s.vz = Math.cos(a) * 1.4
        s.vy = rnd(-0.1, 0.2)
        s.color = 0xc8f0ff
        s.color2 = 0xffffff
        s.size = rnd(0.12, 0.2)
        s.life = 0.7
        s.cell = CELL.sparkle
        s.spin = 4
      })
    }
  }

  // R：捕獲 — 花瓣旋風 + 魔法陣
  capture(pos: THREE.Vector3) {
    this.magicRing(pos, 1.6, 0xd8ffe0, 0.9)
    for (let i = 0; i < 24; i++) {
      this.emit(this.soft, (s) => {
        const a = (i / 24) * Math.PI * 2
        s.x = pos.x + Math.cos(a) * 0.9
        s.y = rnd(0.2, 1.4)
        s.z = pos.z + Math.sin(a) * 0.9
        s.vx = -Math.sin(a) * 2.2 - Math.cos(a) * 0.6
        s.vz = Math.cos(a) * 2.2 - Math.sin(a) * 0.6
        s.vy = rnd(0.6, 1.5)
        s.color = Math.random() < 0.5 ? 0xffffff : 0xffd8e8
        s.size = rnd(0.16, 0.26)
        s.life = rnd(0.8, 1.2)
        s.cell = CELL.leaf
        s.spin = rnd(-5, 5)
        s.drag = 1.2
      })
    }
  }

  // 常駐：身邊緩緩飄落的白色花瓣與淡淡光點（移動時較多）
  ambient(dt: number, pos: THREE.Vector3, move: number) {
    this.acc.petal += dt * (1.2 + move * 3)
    while (this.acc.petal >= 1) {
      this.acc.petal -= 1
      this.emit(this.soft, (s) => {
        s.x = pos.x + rnd(-0.7, 0.7)
        s.y = rnd(1.4, 2.1)
        s.z = pos.z + rnd(-0.7, 0.7)
        s.vx = rnd(-0.2, 0.2)
        s.vy = rnd(-0.5, -0.25)
        s.vz = rnd(-0.2, 0.2)
        s.color = Math.random() < 0.7 ? 0xfffaf2 : 0xffdbe8
        s.size = rnd(0.1, 0.16)
        s.life = rnd(2.2, 3.2)
        s.cell = CELL.leaf
        s.wobble = 0.8
        s.spin = rnd(-2, 2)
        s.fadeIn = 0.15
        s.alpha = 0.9
      })
    }
  }

  update(dt: number) {
    for (const r of this.rings) {
      if (r.life <= 0) continue
      r.life -= dt
      const k = 1 - Math.max(0, r.life) / r.max
      r.mat.uniforms.uP.value = 1 - Math.pow(1 - k, 2.4)
      r.mat.uniforms.uA.value = (1 - k) * Math.min(1, k * 8)
      r.mat.uniforms.uT.value += dt
      if (r.follow) r.mesh.position.set(r.follow.x, 0.08, r.follow.z)
      if (r.life <= 0) {
        r.mesh.visible = false
        r.follow = null
      }
    }
  }

  dispose() {
    for (const r of this.rings) {
      this.scene.remove(r.mesh)
      r.mat.dispose()
    }
    this.geo.dispose()
    this.rings = []
  }
}
