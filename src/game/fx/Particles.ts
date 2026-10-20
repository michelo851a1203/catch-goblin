import * as THREE from 'three'
import { particleAtlas } from './atlas'

export interface ParticleSpec {
  x: number
  y: number
  z: number
  vx?: number
  vy?: number
  vz?: number
  color?: number | THREE.Color
  color2?: number | THREE.Color // 生命結束時的顏色
  size?: number
  grow?: number // 生命結束時的尺寸倍率
  life?: number
  cell?: number
  gravity?: number
  drag?: number
  spin?: number
  rot?: number
  alpha?: number
  fadeIn?: number
  wobble?: number
}

const tmpA = new THREE.Color()
const tmpB = new THREE.Color()

// 以 CPU 更新、單一 draw call 的點粒子系統
export class Particles {
  points: THREE.Points
  private max: number
  private next = 0
  private pos: Float32Array
  private col: Float32Array
  private size: Float32Array
  private alpha: Float32Array
  private cell: Float32Array
  private rot: Float32Array
  private vel: Float32Array
  private c1: Float32Array
  private c2: Float32Array
  private life: Float32Array
  private maxLife: Float32Array
  private baseSize: Float32Array
  private grow: Float32Array
  private gravity: Float32Array
  private drag: Float32Array
  private spin: Float32Array
  private baseAlpha: Float32Array
  private fadeIn: Float32Array
  private wobble: Float32Array
  private seed: Float32Array
  private geo: THREE.BufferGeometry
  private mat: THREE.ShaderMaterial
  private time = 0

  constructor(max: number, additive: boolean) {
    this.max = max
    const f = (n: number) => new Float32Array(max * n)
    this.pos = f(3)
    this.col = f(3)
    this.size = f(1)
    this.alpha = f(1)
    this.cell = f(1)
    this.rot = f(1)
    this.vel = f(3)
    this.c1 = f(3)
    this.c2 = f(3)
    this.life = f(1)
    this.maxLife = f(1)
    this.baseSize = f(1)
    this.grow = f(1)
    this.gravity = f(1)
    this.drag = f(1)
    this.spin = f(1)
    this.baseAlpha = f(1)
    this.fadeIn = f(1)
    this.wobble = f(1)
    this.seed = f(1)
    for (let i = 0; i < max; i++) this.seed[i] = Math.random() * 100

    const geo = new THREE.BufferGeometry()
    const attr = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', attr(this.pos, 3))
    geo.setAttribute('color', attr(this.col, 3))
    geo.setAttribute('size', attr(this.size, 1))
    geo.setAttribute('alpha', attr(this.alpha, 1))
    geo.setAttribute('cell', attr(this.cell, 1))
    geo.setAttribute('rot', attr(this.rot, 1))
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5)
    this.geo = geo

    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: particleAtlas() }, scale: { value: 400 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float size; attribute float alpha; attribute float cell; attribute float rot;
        attribute vec3 color;
        uniform float scale;
        varying vec3 vColor; varying float vAlpha; varying float vCell; varying float vRot;
        void main() {
          vColor = color; vAlpha = alpha; vCell = cell; vRot = rot;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec3 vColor; varying float vAlpha; varying float vCell; varying float vRot;
        void main() {
          if (vAlpha <= 0.001) discard;
          vec2 p = gl_PointCoord - 0.5;
          float c = cos(vRot), s = sin(vRot);
          p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
          if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) discard;
          float col = mod(vCell, 4.0), row = floor(vCell / 4.0);
          vec2 uv = vec2((col + p.x) / 4.0, 1.0 - (row + p.y) / 2.0);
          vec4 t = texture2D(map, uv);
          gl_FragColor = vec4(t.rgb * vColor, t.a * vAlpha);
        }`,
    })
    this.mat.userData.outlineParameters = { visible: false }
    this.points = new THREE.Points(geo, this.mat)
    this.points.frustumCulled = false
    this.points.renderOrder = additive ? 6 : 5
  }

  setScale(viewportHeight: number, fov: number) {
    this.mat.uniforms.scale.value = viewportHeight / (2 * Math.tan((fov * Math.PI) / 360))
  }

  spawn(s: ParticleSpec) {
    const i = this.next
    this.next = (this.next + 1) % this.max
    const i3 = i * 3
    this.pos[i3] = s.x
    this.pos[i3 + 1] = s.y
    this.pos[i3 + 2] = s.z
    this.vel[i3] = s.vx ?? 0
    this.vel[i3 + 1] = s.vy ?? 0
    this.vel[i3 + 2] = s.vz ?? 0
    tmpA.set(s.color ?? 0xffffff)
    tmpB.set(s.color2 ?? s.color ?? 0xffffff)
    this.c1[i3] = tmpA.r
    this.c1[i3 + 1] = tmpA.g
    this.c1[i3 + 2] = tmpA.b
    this.c2[i3] = tmpB.r
    this.c2[i3 + 1] = tmpB.g
    this.c2[i3 + 2] = tmpB.b
    const life = s.life ?? 1
    this.life[i] = life
    this.maxLife[i] = life
    this.baseSize[i] = s.size ?? 0.3
    this.grow[i] = s.grow ?? 1
    this.gravity[i] = s.gravity ?? 0
    this.drag[i] = s.drag ?? 0
    this.spin[i] = s.spin ?? 0
    this.rot[i] = s.rot ?? 0
    this.cell[i] = s.cell ?? 0
    this.baseAlpha[i] = s.alpha ?? 1
    this.fadeIn[i] = s.fadeIn ?? 0.08
    this.wobble[i] = s.wobble ?? 0
  }

  update(dt: number) {
    this.time += dt
    const t = this.time
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) {
          this.alpha[i] = 0
          this.size[i] = 0
        }
        continue
      }
      this.life[i] -= dt
      const i3 = i * 3
      const k = 1 - Math.max(0, this.life[i]) / this.maxLife[i] // 0 → 1
      const dr = Math.max(0, 1 - this.drag[i] * dt)
      this.vel[i3] *= dr
      this.vel[i3 + 1] = this.vel[i3 + 1] * dr - this.gravity[i] * dt
      this.vel[i3 + 2] *= dr
      const w = this.wobble[i]
      const sd = this.seed[i]
      this.pos[i3] += (this.vel[i3] + (w ? Math.sin(t * 2.3 + sd) * w : 0)) * dt
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt
      this.pos[i3 + 2] += (this.vel[i3 + 2] + (w ? Math.cos(t * 1.9 + sd) * w : 0)) * dt
      this.rot[i] += this.spin[i] * dt
      this.size[i] = this.baseSize[i] * (1 + (this.grow[i] - 1) * k)
      const fi = this.fadeIn[i] > 0 ? Math.min(1, (k * this.maxLife[i]) / this.fadeIn[i]) : 1
      this.alpha[i] = this.baseAlpha[i] * fi * (1 - k * k)
      this.col[i3] = this.c1[i3] + (this.c2[i3] - this.c1[i3]) * k
      this.col[i3 + 1] = this.c1[i3 + 1] + (this.c2[i3 + 1] - this.c1[i3 + 1]) * k
      this.col[i3 + 2] = this.c1[i3 + 2] + (this.c2[i3 + 2] - this.c1[i3 + 2]) * k
    }
    const a = this.geo.attributes
    a.position.needsUpdate = true
    a.color.needsUpdate = true
    a.size.needsUpdate = true
    a.alpha.needsUpdate = true
    a.rot.needsUpdate = true
    a.cell.needsUpdate = true
  }

  dispose() {
    this.geo.dispose()
    this.mat.dispose()
  }
}
