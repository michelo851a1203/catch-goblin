import * as THREE from 'three'
import { noOutline } from '../toon'

// 星空風絲帶：沿著移動軌跡留下的發光緞帶。每條緞帶保存最近 N 個錨點，每幀重建三角帶；
// shader 裡依年齡淡出、邊緣柔化，並以雜湊在緞帶上點綴閃爍的星點，顏色由紫 → 粉 → 星藍漸變
const VERT = /* glsl */ `
  attribute float aAge;
  attribute float aSide;
  attribute float aLen;
  varying float vAge;
  varying float vSide;
  varying float vLen;
  void main() {
    vAge = aAge; vSide = aSide; vLen = aLen;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uA;
  uniform vec3 uB;
  uniform vec3 uC;
  uniform float uAlpha;
  varying float vAge;
  varying float vSide;
  varying float vLen;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    float edge = 1.0 - abs(vSide);
    float soft = smoothstep(0.0, 0.55, edge);
    float fade = pow(clamp(1.0 - vAge, 0.0, 1.0), 1.6);
    // 緞帶本身：中央較亮的絲光 + 沿長度流動的波紋
    float silk = 0.55 + 0.45 * sin(vLen * 5.0 - uTime * 9.0 + vSide * 2.0);
    vec3 col = mix(uA, uB, smoothstep(0.0, 0.6, vAge));
    col = mix(col, uC, smoothstep(0.55, 1.0, vAge));
    col *= 0.7 + 0.5 * silk * edge;
    // 星點：格子雜湊，閃爍
    vec2 cell = vec2(floor(vLen * 9.0), floor((vSide + 1.0) * 3.0));
    float h = hash(cell);
    vec2 f = fract(vec2(vLen * 9.0, (vSide + 1.0) * 3.0)) - 0.5;
    float star = step(0.82, h) * smoothstep(0.22, 0.0, length(f)) * (0.6 + 0.4 * sin(uTime * 12.0 + h * 40.0));
    col = mix(col, vec3(1.0, 0.97, 1.0), clamp(star, 0.0, 1.0));
    float a = (soft * (0.45 + 0.4 * silk) + star) * fade * uAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, min(1.0, a));
  }`

interface Anchor {
  p: THREE.Vector3
  side: THREE.Vector3 // 緞帶寬度方向（世界）
  t: number // 產生時間
}

export class Ribbon {
  readonly mesh: THREE.Mesh
  private geo = new THREE.BufferGeometry()
  private mat: THREE.ShaderMaterial
  private anchors: Anchor[] = []
  private pos: Float32Array
  private age: Float32Array
  private side: Float32Array
  private len: Float32Array
  private time = 0
  private max: number
  private life: number // 錨點存在的秒數
  private width: number
  constructor(max = 48, life = 0.55, width = 0.35, colors: [number, number, number] = [0xb48cff, 0xff8fd8, 0x8fd8ff]) {
    this.max = max
    this.life = life
    this.width = width
    this.pos = new Float32Array(max * 2 * 3)
    this.age = new Float32Array(max * 2)
    this.side = new Float32Array(max * 2)
    this.len = new Float32Array(max * 2)
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('aLen', new THREE.BufferAttribute(this.len, 1).setUsage(THREE.DynamicDrawUsage))
    const idx: number[] = []
    for (let i = 0; i < max - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3
      idx.push(a, b, c, b, d, c)
    }
    this.geo.setIndex(idx)
    this.mat = noOutline(
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
        uniforms: {
          uTime: { value: 0 },
          uA: { value: new THREE.Color(colors[0]) },
          uB: { value: new THREE.Color(colors[1]) },
          uC: { value: new THREE.Color(colors[2]) },
          uAlpha: { value: 1 },
        },
      }),
    )
    this.mesh = new THREE.Mesh(this.geo, this.mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 6
    this.mesh.visible = false
  }

  get active() {
    return this.anchors.length > 1
  }

  // 新增錨點：p 為緞帶中心、side 為寬度方向
  push(p: THREE.Vector3, side: THREE.Vector3) {
    const last = this.anchors[this.anchors.length - 1]
    if (last && last.p.distanceToSquared(p) < 0.0004) return
    if (this.anchors.length >= this.max) this.anchors.shift()
    this.anchors.push({ p: p.clone(), side: side.clone().normalize(), t: this.time })
  }

  clear() {
    this.anchors.length = 0
    this.mesh.visible = false
  }

  update(dt: number) {
    this.time += dt
    this.mat.uniforms.uTime.value = this.time
    const A = this.anchors
    while (A.length && this.time - A[0].t > this.life) A.shift()
    const n = A.length
    this.mesh.visible = n > 1
    if (n < 2) return
    let L = 0
    for (let i = 0; i < n; i++) {
      const a = A[i]
      if (i > 0) L += a.p.distanceTo(A[i - 1].p)
      const age = Math.min(1, (this.time - a.t) / this.life)
      // 頭尾收細：新的一端從細到寬（像被風拉出來），舊的一端漸細消失
      const k = i / (n - 1)
      const w = this.width * Math.sin(Math.min(1, k * 1.15) * Math.PI * 0.5) * (1 - age * 0.6)
      for (let s = 0; s < 2; s++) {
        const j = i * 2 + s
        const sg = s === 0 ? -1 : 1
        this.pos[j * 3] = a.p.x + a.side.x * w * sg
        this.pos[j * 3 + 1] = a.p.y + a.side.y * w * sg
        this.pos[j * 3 + 2] = a.p.z + a.side.z * w * sg
        this.age[j] = age
        this.side[j] = sg
        this.len[j] = L
      }
    }
    // 沒用到的頂點收到最後一個錨點（退化三角形）
    for (let j = n * 2; j < this.max * 2; j++) {
      this.pos[j * 3] = this.pos[(n * 2 - 1) * 3]
      this.pos[j * 3 + 1] = this.pos[(n * 2 - 1) * 3 + 1]
      this.pos[j * 3 + 2] = this.pos[(n * 2 - 1) * 3 + 2]
      this.age[j] = 1
    }
    for (const k of ['position', 'aAge', 'aSide', 'aLen']) this.geo.attributes[k].needsUpdate = true
    this.geo.setDrawRange(0, (n - 1) * 6)
  }

  dispose() {
    this.geo.dispose()
    this.mat.dispose()
  }
}
