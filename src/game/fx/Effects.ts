import * as THREE from 'three'
import { Particles } from './Particles'
import { CELL, glowSprite } from './atlas'
import { makeSprite } from '../toon'

interface Timed {
  obj: THREE.Object3D
  life: number
  max: number
  update?: (k: number, dt: number) => void
}

export interface FireSource {
  pos: THREE.Vector3
  scale: number
  smoke: boolean
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

function noOutline<T extends THREE.Material>(m: T): T {
  m.userData.outlineParameters = { visible: false }
  return m
}

// 擴散光環（地面）
function ringMaterial(color: number) {
  return noOutline(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(color) }, uP: { value: 0 }, uW: { value: 0.08 }, uA: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uP; uniform float uW; uniform float uA; varying vec2 vUv;
        void main(){
          float d = length(vUv - 0.5) * 2.0;
          float band = 1.0 - smoothstep(0.0, uW, abs(d - uP));
          float fill = d < uP ? 0.18 * (d / max(uP, 0.001)) : 0.0;
          float a = (band + fill) * uA;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor * a, a);
        }`,
    }),
  )
}

// 凝視光束：菲涅耳光暈 + 流動的能量脈衝
function beamMaterial(core: number, edge: number, len: number) {
  return noOutline(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      uniforms: { uCore: { value: new THREE.Color(core) }, uEdge: { value: new THREE.Color(edge) }, uT: { value: 0 }, uA: { value: 1 }, uLen: { value: len } },
      vertexShader: `varying vec3 vN; varying vec3 vV; varying vec2 vUv;
        void main(){ vUv = uv; vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform vec3 uCore; uniform vec3 uEdge; uniform float uT; uniform float uA; uniform float uLen;
        varying vec3 vN; varying vec3 vV; varying vec2 vUv;
        void main(){
          float f = abs(dot(normalize(vN), normalize(vV)));
          float core = pow(f, 3.0);
          float pulse = 0.65 + 0.35 * sin(vUv.y * uLen * 1.4 - uT * 30.0);
          float tip = smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
          vec3 col = mix(uEdge, uCore, core);
          float a = clamp((0.35 + core * 0.9) * pulse, 0.0, 1.0) * tip * uA;
          gl_FragColor = vec4(col, a);
        }`,
    }),
  )
}

// 環繞精靈的發光五線譜（參考設定圖中的音樂緞帶）
function staffMaterial() {
  return noOutline(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uT: { value: 0 }, uA: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform float uT; uniform float uA; varying vec2 vUv;
        void main(){
          float lines = 0.0;
          for (int i = 0; i < 5; i++) {
            float y = 0.1 + float(i) * 0.2;
            lines += 1.0 - smoothstep(0.0, 0.035, abs(vUv.y - y));
          }
          float ends = sin(3.14159 * clamp(vUv.x, 0.0, 1.0));
          float shimmer = 0.6 + 0.4 * sin(vUv.x * 40.0 - uT * 6.0);
          float glow = exp(-pow((vUv.y - 0.5) * 2.2, 2.0)) * 0.18;
          float a = (lines * shimmer + glow) * ends * uA;
          if (a < 0.003) discard;
          vec3 col = mix(vec3(1.0, 0.85, 0.45), vec3(0.75, 0.85, 1.0), vUv.x);
          gl_FragColor = vec4(col * a, a);
        }`,
    }),
  )
}

function helixPoint(s: number, out: THREE.Vector3) {
  const a = s * Math.PI * 4.2
  const r = 1.25 + Math.sin(s * 9) * 0.18
  return out.set(Math.cos(a) * r, 0.35 + s * 1.9, Math.sin(a) * r)
}

function staffGeometry() {
  const N = 140
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const p = new THREE.Vector3()
  for (let i = 0; i <= N; i++) {
    const s = i / N
    helixPoint(s, p)
    pos.push(p.x, p.y - 0.16, p.z, p.x, p.y + 0.16, p.z)
    uv.push(s, 0, s, 1)
    if (i < N) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

const powCache = new Map<string, THREE.CanvasTexture>()
function powTexture(text: string, fill: string) {
  const key = text + fill
  const hit = powCache.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const g = c.getContext('2d')!
  g.translate(128, 128)
  g.beginPath()
  for (let i = 0; i < 24; i++) {
    const r = i % 2 ? 70 : 118
    const a = (i / 24) * Math.PI * 2
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r * 0.85)
  }
  g.closePath()
  g.fillStyle = fill
  g.fill()
  g.lineWidth = 8
  g.strokeStyle = '#2a1206'
  g.stroke()
  g.rotate(-0.12)
  g.font = `900 ${text.length > 3 ? 50 : 62}px "Noto Sans TC", system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineWidth = 10
  g.strokeStyle = '#2a1206'
  g.strokeText(text, 0, 4)
  g.fillStyle = '#fff'
  g.fillText(text, 0, 4)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  powCache.set(key, t)
  return t
}

export class FxSystem {
  glow = new Particles(3500, true)
  soft = new Particles(2500, false)
  fires: FireSource[] = []
  caves: { center: THREE.Vector3; radius: number }[] = []
  private timed: Timed[] = []
  private acc = new Map<string, number>()
  private scene: THREE.Scene
  private time = 0

  constructor(scene: THREE.Scene) {
    this.scene = scene
    scene.add(this.glow.points, this.soft.points)
  }

  setViewport(h: number, fov: number) {
    this.glow.setScale(h, fov)
    this.soft.setScale(h, fov)
  }

  // 依速率累積，回傳本幀要產生幾個粒子
  rate(key: string, perSec: number, dt: number) {
    const v = (this.acc.get(key) ?? Math.random()) + perSec * dt
    const n = Math.floor(v)
    this.acc.set(key, v - n)
    return n
  }

  private add(obj: THREE.Object3D, life: number, update?: Timed['update']) {
    this.scene.add(obj)
    this.timed.push({ obj, life, max: life, update })
  }

  update(dt: number, focus: THREE.Vector3, inCave: boolean) {
    this.time += dt
    this.glow.update(dt)
    this.soft.update(dt)
    for (let i = this.timed.length - 1; i >= 0; i--) {
      const f = this.timed[i]
      f.life -= dt
      f.update?.(Math.min(1, 1 - f.life / f.max), dt)
      if (f.life <= 0) {
        this.scene.remove(f.obj)
        f.obj.traverse((o) => {
          const m = o as THREE.Mesh
          m.geometry?.dispose()
          const mat = m.material as (THREE.Material & { map?: THREE.Texture | null }) | undefined
          if (mat) {
            if (mat.map && !mat.map.userData.cached) mat.map.dispose()
            mat.dispose()
          }
        })
        this.timed.splice(i, 1)
      }
    }
    this.ambient(dt, focus, inCave)
  }

  private ambient(dt: number, focus: THREE.Vector3, inCave: boolean) {
    // 火焰、火星與煙
    this.fires.forEach((f, i) => {
      const dx = f.pos.x - focus.x, dz = f.pos.z - focus.z
      if (dx * dx + dz * dz > 75 * 75) return
      const s = f.scale
      const n = this.rate(`fire${i}`, 46 * s, dt)
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 0.32 * s
        this.glow.spawn({
          x: f.pos.x + Math.cos(a) * r, y: f.pos.y + 0.1, z: f.pos.z + Math.sin(a) * r,
          vx: -Math.cos(a) * r * 0.8, vy: rnd(1.3, 2.2) * Math.sqrt(s), vz: -Math.sin(a) * r * 0.8,
          color: 0xffe08a, color2: 0xff3a10, size: rnd(0.7, 1.1) * s, grow: 0.25, life: rnd(0.45, 0.75), cell: CELL.glow, alpha: 0.85, fadeIn: 0.05,
        })
      }
      for (let k = 0; k < this.rate(`ember${i}`, 6 * s, dt); k++)
        this.glow.spawn({
          x: f.pos.x + rnd(-0.3, 0.3) * s, y: f.pos.y + 0.4 * s, z: f.pos.z + rnd(-0.3, 0.3) * s,
          vx: rnd(-0.4, 0.4), vy: rnd(1.8, 3.2), vz: rnd(-0.4, 0.4),
          color: 0xffc060, color2: 0xff5020, size: rnd(0.08, 0.16), life: rnd(1, 2), cell: CELL.sparkle, wobble: 0.8, spin: 4,
        })
      if (f.smoke)
        for (let k = 0; k < this.rate(`smoke${i}`, 2.5, dt); k++)
          this.soft.spawn({
            x: f.pos.x + rnd(-0.2, 0.2), y: f.pos.y + 1.2, z: f.pos.z + rnd(-0.2, 0.2),
            vx: rnd(-0.2, 0.2), vy: rnd(0.8, 1.2), vz: rnd(-0.2, 0.2),
            color: 0x6a625a, size: 1.2, grow: 3.5, life: 3.2, cell: CELL.smoke, alpha: 0.28, fadeIn: 0.6, spin: 0.3, drag: 0.2,
          })
    })

    // 山洞裡的螢火蟲
    this.caves.forEach((c, i) => {
      const d = Math.hypot(c.center.x - focus.x, c.center.z - focus.z)
      if (d > 50) return
      for (let k = 0; k < this.rate(`ff${i}`, 4, dt); k++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * c.radius * 0.85
        this.glow.spawn({
          x: c.center.x + Math.cos(a) * r, y: rnd(0.4, 3.6), z: c.center.z + Math.sin(a) * r,
          vx: rnd(-0.2, 0.2), vy: rnd(-0.1, 0.15), vz: rnd(-0.2, 0.2),
          color: Math.random() < 0.6 ? 0xa8ffd0 : 0xfff3a0, size: rnd(0.14, 0.24), life: rnd(3, 5), cell: CELL.glow, wobble: 0.5, fadeIn: 1.2,
        })
      }
    })

    // 草原上飄落的花瓣與光點
    if (!inCave) {
      const petals = [0xffc8dc, 0xffffff, 0xfff1a8, 0xc8f0a0]
      for (let k = 0; k < this.rate('petal', 7, dt); k++) {
        const a = Math.random() * Math.PI * 2, r = rnd(5, 22)
        this.soft.spawn({
          x: focus.x + Math.cos(a) * r, y: rnd(3, 8), z: focus.z + Math.sin(a) * r,
          vx: rnd(0.4, 1.0), vy: rnd(-0.6, -0.3), vz: rnd(-0.2, 0.3),
          color: petals[Math.floor(Math.random() * petals.length)], size: rnd(0.14, 0.22), life: rnd(5, 8), cell: CELL.leaf,
          wobble: 1.1, spin: rnd(-3, 3), rot: Math.random() * 6, fadeIn: 0.8,
        })
      }
      for (let k = 0; k < this.rate('mote', 4, dt); k++) {
        const a = Math.random() * Math.PI * 2, r = rnd(2, 14)
        this.glow.spawn({
          x: focus.x + Math.cos(a) * r, y: rnd(0.3, 1.6), z: focus.z + Math.sin(a) * r,
          vy: rnd(0.05, 0.25), color: 0xfff6b0, size: rnd(0.07, 0.13), life: rnd(2, 3.5), cell: CELL.glow, wobble: 0.35, fadeIn: 0.8, alpha: 0.7,
        })
      }
    }
  }

  // ───────────────────────── 一次性特效 ─────────────────────────
  dust(x: number, z: number, n: number, strength = 1, color = 0xd8c49a) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = rnd(0.4, 1.4) * strength
      this.soft.spawn({
        x: x + Math.cos(a) * 0.2, y: 0.15, z: z + Math.sin(a) * 0.2,
        vx: Math.cos(a) * sp, vy: rnd(0.3, 0.9) * strength, vz: Math.sin(a) * sp,
        color, size: rnd(0.35, 0.55) * Math.sqrt(strength), grow: 2.4, life: rnd(0.5, 0.9), cell: CELL.smoke, alpha: 0.55, drag: 3, spin: rnd(-1, 1), fadeIn: 0.03,
      })
    }
  }

  sparkles(pos: THREE.Vector3, n: number, color: number, spread = 0.5, speed = 1.5, y = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = rnd(-0.5, 1.2)
      this.glow.spawn({
        x: pos.x + rnd(-spread, spread), y: pos.y + y + rnd(-spread, spread), z: pos.z + rnd(-spread, spread),
        vx: Math.cos(a) * speed * rnd(0.3, 1), vy: e * speed, vz: Math.sin(a) * speed * rnd(0.3, 1),
        color, color2: 0xffffff, size: rnd(0.15, 0.32), life: rnd(0.5, 1.0), cell: CELL.sparkle, spin: rnd(-6, 6), drag: 2, gravity: 0.6,
      })
    }
  }

  trail(pos: THREE.Vector3, color: number, y = 1) {
    this.glow.spawn({
      x: pos.x + rnd(-0.25, 0.25), y: pos.y + y + rnd(-0.4, 0.5), z: pos.z + rnd(-0.25, 0.25),
      vy: rnd(0.1, 0.5), color, color2: 0xffffff, size: rnd(0.1, 0.2), life: rnd(0.6, 1.1), cell: Math.random() < 0.5 ? CELL.sparkle : CELL.glow, spin: 3, wobble: 0.3,
    })
  }

  speedLines(pos: THREE.Vector3, vel: THREE.Vector3) {
    const sp = vel.length() || 1
    this.glow.spawn({
      x: pos.x + rnd(-0.35, 0.35), y: rnd(0.3, 1.1), z: pos.z + rnd(-0.35, 0.35),
      vx: -vel.x * 0.15, vz: -vel.z * 0.15, color: 0xdff8ff, size: rnd(0.25, 0.4) * Math.min(1.4, sp / 8), grow: 0.2, life: 0.35, cell: CELL.glow, alpha: 0.5,
    })
  }

  heartBurst(pos: THREE.Vector3, n = 10) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(-0.2, 0.2)
      this.soft.spawn({
        x: pos.x, y: pos.y + 1.2, z: pos.z,
        vx: Math.cos(a) * rnd(1.5, 2.8), vy: rnd(1.2, 3), vz: Math.sin(a) * rnd(1.5, 2.8),
        color: 0xff6fae, color2: 0xffb8d8, size: rnd(0.3, 0.45), grow: 0.6, life: rnd(0.8, 1.2), cell: CELL.heart, gravity: 3, drag: 1.5, spin: rnd(-2, 2),
      })
    }
    this.flash(pos.clone().setY(pos.y + 1.1), 0xff7fc0, 2.2, 0.3)
  }

  starBurst(pos: THREE.Vector3, color = 0xffe066) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      this.glow.spawn({
        x: pos.x, y: pos.y + 1.0, z: pos.z,
        vx: Math.cos(a) * rnd(3, 5), vy: rnd(0.5, 2.5), vz: Math.sin(a) * rnd(3, 5),
        color, color2: 0xffa020, size: rnd(0.3, 0.5), grow: 0.3, life: rnd(0.35, 0.55), cell: CELL.star, drag: 5, spin: rnd(-8, 8),
      })
    }
    this.flash(pos.clone().setY(pos.y + 1), 0xffffff, 3, 0.18)
    this.ring(pos, 2.6, 0xffe680, 0.35, 0.15)
  }

  flash(pos: THREE.Vector3, color: number, size: number, life: number) {
    const s = glowSprite(color, size, 1)
    s.position.copy(pos)
    s.renderOrder = 8
    const mat = s.material as THREE.SpriteMaterial
    this.add(s, life, (k) => {
      s.scale.setScalar(size * (0.6 + k * 0.8))
      mat.opacity = 1 - k
    })
  }

  ring(pos: THREE.Vector3, radius: number, color: number, life = 1.2, width = 0.06) {
    const mat = ringMaterial(color)
    mat.uniforms.uW.value = width
    const m = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), mat)
    m.rotation.x = -Math.PI / 2
    m.position.set(pos.x, 0.12, pos.z)
    m.renderOrder = 4
    this.add(m, life, (k) => {
      mat.uniforms.uP.value = 1 - Math.pow(1 - k, 2.2)
      mat.uniforms.uA.value = 1 - k
    })
  }

  shockwave(pos: THREE.Vector3) {
    this.ring(pos, 5, 0xbfffb0, 0.6, 0.12)
    this.ring(pos, 3, 0xffffff, 0.4, 0.2)
    this.flash(pos.clone().setY(1), 0xd8ffc8, 4, 0.25)
    // 繩子碎片
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2
      this.soft.spawn({
        x: pos.x, y: 0.8, z: pos.z,
        vx: Math.cos(a) * rnd(3, 6), vy: rnd(2, 5), vz: Math.sin(a) * rnd(3, 6),
        color: 0xa07a40, color2: 0x7a5a30, size: rnd(0.18, 0.3), life: rnd(0.7, 1.1), cell: CELL.leaf, gravity: 9, spin: rnd(-10, 10),
      })
    }
    this.dust(pos.x, pos.z, 12, 2.2)
  }

  pow(pos: THREE.Vector3, text: string, fill = '#ffd23f') {
    const mat = new THREE.SpriteMaterial({ map: powTexture(text, fill), transparent: true, depthTest: false })
    mat.map!.userData.cached = true
    const s = new THREE.Sprite(mat)
    s.position.set(pos.x, 2.3, pos.z)
    s.renderOrder = 12
    this.add(s, 0.9, (k) => {
      const pop = k < 0.2 ? (k / 0.2) * 1.35 : 1.35 - Math.min(0.25, (k - 0.2) * 1.2)
      s.scale.setScalar(1.6 * pop)
      mat.rotation = Math.sin(k * 12) * 0.08
      mat.opacity = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1
    })
  }

  floatText(text: string, pos: THREE.Vector3, color: string, scale = 0.75) {
    const s = makeSprite(text, scale, { fg: color, font: 60, w: 512, h: 128 })
    s.position.set(pos.x, 2.3, pos.z)
    const mat = s.material as THREE.SpriteMaterial
    const base = s.scale.clone()
    this.add(s, 1.2, (k, dt) => {
      s.position.y += dt * 0.9
      const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.55 : 1.15 - Math.min(0.15, (k - 0.12) * 0.8)
      s.scale.copy(base).multiplyScalar(pop)
      mat.opacity = 1 - k * k
    })
  }

  gazeBeam(origin: THREE.Vector3, dir: THREE.Vector3, len: number, hits: THREE.Vector3[], blocked: boolean) {
    const g = new THREE.Group()
    const coreMat = beamMaterial(0xffffff, 0xff4fa0, len)
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, len, 16, 1, true), coreMat)
    core.rotation.x = Math.PI / 2
    core.position.z = len / 2
    g.add(core)
    const glowMat = beamMaterial(0xff9ccc, 0xff3a8a, len)
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.9, len, 16, 1, true), glowMat)
    outer.rotation.x = Math.PI / 2
    outer.position.z = len / 2
    g.add(outer)
    g.position.set(origin.x, 1.55, origin.z)
    g.rotation.y = Math.atan2(dir.x, dir.z)
    this.add(g, 0.75, (k) => {
      const grow = Math.min(1, k * 8)
      g.scale.set(1 - k * 0.6, 1 - k * 0.6, grow)
      coreMat.uniforms.uT.value += 0.016
      glowMat.uniforms.uT.value += 0.016
      coreMat.uniforms.uA.value = 1 - k
      glowMat.uniforms.uA.value = (1 - k) * 0.6
    })
    // 眼神閃光
    this.flash(new THREE.Vector3(origin.x + dir.x * 0.3, 1.58, origin.z + dir.z * 0.3), 0xff8cc8, 1.8, 0.35)
    // 沿光束飛行的愛心
    for (let i = 0; i < Math.floor(len * 1.2); i++) {
      const t = Math.random() * len
      const sp = rnd(10, 16)
      this.soft.spawn({
        x: origin.x + dir.x * t * 0.3, y: 1.55 + rnd(-0.25, 0.25), z: origin.z + dir.z * t * 0.3,
        vx: dir.x * sp, vy: rnd(-0.2, 0.2), vz: dir.z * sp,
        color: 0xff5fa8, color2: 0xffc0dc, size: rnd(0.25, 0.42), life: Math.min(0.7, (len * 0.85) / sp), cell: CELL.heart, spin: rnd(-2, 2), fadeIn: 0.05,
      })
    }
    for (const h of hits) this.heartBurst(h, 12)
    if (blocked) this.sparkles(new THREE.Vector3(origin.x + dir.x * len, 0, origin.z + dir.z * len), 14, 0xff8cc8, 0.3, 2.5, 1.5)
  }

  // 彈奏時環繞的五線譜（常駐物件，由外部控制顯示）
  createStaff() {
    const mat = staffMaterial()
    const mesh = new THREE.Mesh(staffGeometry(), mat)
    mesh.renderOrder = 7
    const group = new THREE.Group()
    group.add(mesh)
    group.visible = false
    this.scene.add(group)
    let alpha = 0
    const p = new THREE.Vector3()
    return {
      group,
      update: (dt: number, active: boolean, at: THREE.Vector3) => {
        alpha += ((active ? 1 : 0) - alpha) * Math.min(1, dt * 5)
        group.visible = alpha > 0.01
        if (!group.visible) return
        group.position.copy(at)
        group.rotation.y += dt * 1.4
        mat.uniforms.uT.value += dt
        mat.uniforms.uA.value = alpha
        if (active) {
          for (let k = 0; k < this.rate('staffnote', 9, dt); k++) {
            helixPoint(Math.random(), p).applyAxisAngle(new THREE.Vector3(0, 1, 0), group.rotation.y).add(at)
            this.glow.spawn({
              x: p.x, y: p.y, z: p.z, vy: rnd(0.3, 0.8), vx: rnd(-0.3, 0.3), vz: rnd(-0.3, 0.3),
              color: Math.random() < 0.5 ? 0xffe6a0 : 0xc8dcff, color2: 0xffffff, size: rnd(0.32, 0.48), life: rnd(1, 1.6),
              cell: Math.random() < 0.5 ? CELL.note : CELL.notes, wobble: 0.4, fadeIn: 0.15,
            })
          }
          for (let k = 0; k < this.rate('staffsp', 14, dt); k++) this.trail(at, 0xffe6a0, rnd(0.3, 2.2))
        }
      },
      dispose: () => {
        this.scene.remove(group)
        mesh.geometry.dispose()
        mat.dispose()
      },
    }
  }

  dispose() {
    for (const f of this.timed) this.scene.remove(f.obj)
    this.timed = []
    this.glow.dispose()
    this.soft.dispose()
  }
}
