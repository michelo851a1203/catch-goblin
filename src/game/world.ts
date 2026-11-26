import * as THREE from 'three'
import { CONFIG, type MapId } from './config'
import { mesh, noOutline, toon } from './toon'
import { glowSprite } from './fx/atlas'
import type { FireSource } from './fx/Effects'
import { buildMushroomWorld } from './mushroomWorld'

export interface Collider {
  x: number
  z: number
  r: number
  blocksSight: boolean
}

export interface CaveGap {
  angle: number
  inner: THREE.Vector3
  outer: THREE.Vector3
}

// 哥布林的據點：山洞（有兩個洞口的圓頂）或上層台地（只能經由傳送門 / 彈跳蘑菇進出）。
// AI 的群聚、搬家、逃跑、精靈巡邏與哥布林雷達都以據點為單位（zoneOf）
export interface Cave {
  id: number
  name: string
  center: THREE.Vector3
  radius: number
  gaps: CaveGap[]
  dome: THREE.Mesh[]
  kind: 'cave' | 'plateau'
}

// 上層台地：圓形的高台，邊緣是擋路也擋視線的崖壁。region＝區域編號（地面是 0）
export interface Plateau {
  region: number
  center: THREE.Vector3
  radius: number
  height: number
}

// 傳送：站進 from 的範圍（radius）就被送到 to（落點在對面傳送門的範圍外，不會立刻又被傳回來）。
// portal＝雙向傳送門的其中一端（pair＝另一端）；bounce＝彈跳蘑菇（單向，從台地彈到地面）
export interface Warp {
  id: number
  kind: 'portal' | 'bounce'
  from: THREE.Vector3
  region: number
  radius: number
  to: THREE.Vector3
  toRegion: number
  pair: number
  color: number
}

// 孢子噴泉：每 period 秒噴出一團孢子霧，持續 duration 秒，期間霧裡擋住視線（不擋路）
export interface SporeVent {
  pos: THREE.Vector3
  radius: number
  period: number
  duration: number
  phase: number
}

// 地圖的光線與霧（由 Game 套用）
export interface Theme {
  fog: number
  fogNear: number
  fogFar: number
  hemiSky: number
  hemiGround: number
  hemi: number
  hemiCave: number
  sun: number
  sunColor: number
  sunCave: number
  // 環境特效：草原飄花瓣 / 蘑菇林飄孢子
  ambient: 'petals' | 'spores'
}

const MEADOW_THEME: Theme = {
  fog: 0xd6eefa, fogNear: 90, fogFar: 300, hemiSky: 0xdff0ff, hemiGround: 0x5a7a32, hemi: 1.6, hemiCave: 1.0,
  sun: 2.4, sunColor: 0xfff0d0, sunCave: 1.5, ambient: 'petals',
}

export const GAP_HALF = 0.22

// 山洞的配色；extra：地圖額外的洞口裝飾（水晶、提燈等）
export interface CaveStyle {
  rock: number
  moss: number
  boulder: number
  floor: number
  pillar: number
  shroom: number
  shroomGlow: number
  halo: number
  extra?: (world: World, center: THREE.Vector3, radius: number, gapAngles: number[]) => void
}
const MEADOW_CAVE: CaveStyle = {
  rock: 0x8c7f6e, moss: 0x6d8a3e, boulder: 0x7a6e60, floor: 0x4a3f36, pillar: 0x6b6053, shroom: 0x5fd6c8, shroomGlow: 0x1f8a80, halo: 0x5fe6d8,
}

// 簡易 3D value noise（以座標決定，讓接縫頂點位移一致）
function hash(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return s - Math.floor(s)
}
export function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const xf = x - xi, yf = y - yi, zf = z - zi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf)
  let r = 0
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++) {
        const wt = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w)
        r += wt * hash(xi + dx, yi + dy, zi + dz)
      }
  return r
}

let seed = 1337
export function rand() {
  seed = (seed * 16807) % 2147483647
  return (seed - 1) / 2147483646
}

export class World {
  readonly map: MapId
  colliders: Collider[] = []
  caves: Cave[] = []
  plateaus: Plateau[] = []
  warps: Warp[] = []
  vents: SporeVent[] = []
  // 撒樹木、石頭時要避開的範圍（傳送門、落點、機關）
  keepOut: { x: number; z: number; r: number }[] = []
  theme: Theme = MEADOW_THEME
  cagePos = new THREE.Vector3(0, 0, 0)
  occluders: THREE.Object3D[] = []
  fires: FireSource[] = []
  fireLights: THREE.PointLight[] = []
  // 對局時間（由 Game 每一步更新）：孢子霧依這個時間決定開關，房主與加入者、無頭模擬都一致
  simTime = 0
  // 每幀的畫面更新（傳送門漩渦、孢子霧等，由地圖註冊）
  animators: ((dt: number, t: number) => void)[] = []
  // 彈跳蘑菇被踩到時的畫面效果（由地圖註冊）
  onBounce: ((warp: number) => void) | null = null
  time = { value: 0 }
  scene: THREE.Scene

  constructor(scene: THREE.Scene, map: MapId = 'meadow') {
    this.scene = scene
    this.map = map
    seed = 1337
    if (map === 'mushroom') {
      buildMushroomWorld(this)
      return
    }
    this.buildSky()
    this.buildGround()
    const caveDefs = [
      { name: '北岩洞', x: 8, z: -62, rot: 0.3 },
      { name: '東苔洞', x: 62, z: -8, rot: 1.6 },
      { name: '南根洞', x: -10, z: 62, rot: 0.1 },
      { name: '西骨洞', x: -60, z: 6, rot: 1.4 },
      { name: '老哥布林窟', x: 48, z: 52, rot: 0.8 },
    ]
    // 短局（CrazyGames 版）的地圖較小：山洞往中央靠攏（mapScale = 1 時與原本完全相同）
    const k = CONFIG.mapScale
    caveDefs.forEach((d, i) => this.buildCave(i, d.name, d.x * k, d.z * k, d.rot))
    this.buildCage()
    this.scatterNature()
    this.buildMountains()
  }

  zoneOf(p: THREE.Vector3): number {
    for (const c of this.caves) {
      const dx = p.x - c.center.x, dz = p.z - c.center.z
      if (dx * dx + dz * dz < (c.radius - 1.3) ** 2) return c.id
    }
    return -1
  }

  // 所在區域：0＝地面，其餘為台地（只能經由傳送門 / 彈跳蘑菇往來）
  regionOf(p: { x: number; z: number }): number {
    for (const pl of this.plateaus) {
      const dx = p.x - pl.center.x, dz = p.z - pl.center.z
      if (dx * dx + dz * dz < pl.radius * pl.radius) return pl.region
    }
    return 0
  }

  // 畫面上的地面高度（遊戲邏輯一律在 y = 0 計算，見 ground.ts）
  heightAt = (x: number, z: number): number => {
    for (const pl of this.plateaus) {
      const dx = x - pl.center.x, dz = z - pl.center.z
      if (dx * dx + dz * dz < pl.radius * pl.radius) return pl.height
    }
    return 0
  }

  // 從 pos（區域 from）前往 target（區域 to）要先走進哪個傳送點：在傳送點組成的圖上找最短路徑，回傳第一個。
  // avoid：要避開的位置（逃離精靈時，離精靈近的傳送點代價較高）
  route(pos: THREE.Vector3, from: number, target: THREE.Vector3, to: number, avoid?: THREE.Vector3): Warp | null {
    const W = this.warps
    const cost = new Array<number>(W.length).fill(Infinity)
    const first = new Array<number>(W.length).fill(-1)
    const done = new Array<boolean>(W.length).fill(false)
    for (const w of W) {
      if (w.region !== from) continue
      let c = Math.hypot(pos.x - w.from.x, pos.z - w.from.z)
      if (avoid) c += Math.max(0, 16 - Math.hypot(avoid.x - w.from.x, avoid.z - w.from.z)) * 4
      cost[w.id] = c
      first[w.id] = w.id
    }
    let best: Warp | null = null
    let bestCost = Infinity
    for (;;) {
      let u = -1
      for (let i = 0; i < W.length; i++) if (!done[i] && cost[i] < Infinity && (u < 0 || cost[i] < cost[u])) u = i
      if (u < 0 || cost[u] >= bestCost) break
      done[u] = true
      const w = W[u]
      if (w.toRegion === to) {
        const c = cost[u] + Math.hypot(w.to.x - target.x, w.to.z - target.z)
        if (c < bestCost) {
          bestCost = c
          best = W[first[u]]
        }
        continue
      }
      for (const n of W) {
        if (n.region !== w.toRegion || done[n.id]) continue
        const c = cost[u] + Math.hypot(w.to.x - n.from.x, w.to.z - n.from.z)
        if (c < cost[n.id]) {
          cost[n.id] = c
          first[n.id] = first[u]
        }
      }
    }
    return best
  }

  // 正在噴霧的孢子噴泉
  activeVents() {
    return this.vents.filter((v) => (this.simTime + v.phase) % v.period < v.duration)
  }

  private buildSky() {
    const geo = new THREE.SphereGeometry(400, 32, 16)
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { top: { value: new THREE.Color(0x4f9ee8) }, bottom: { value: new THREE.Color(0xd6eefa) } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vP;
        void main(){ float h = clamp(normalize(vP).y*1.6+0.1,0.,1.); gl_FragColor = vec4(mix(bottom, top, h),1.); }`,
    })
    noOutline(mat)
    const sky = new THREE.Mesh(geo, mat)
    this.scene.add(sky)

    // 雲
    const cloudMat = toon(0xffffff, { outline: false, emissive: 0x777777 })
    for (let i = 0; i < 22; i++) {
      const g = new THREE.Group()
      const n = 3 + Math.floor(rand() * 4)
      for (let j = 0; j < n; j++) {
        const s = new THREE.Mesh(new THREE.IcosahedronGeometry(6 + rand() * 6, 1), cloudMat)
        s.position.set(j * 7 - n * 3.5, rand() * 3, rand() * 5)
        s.scale.y = 0.55
        g.add(s)
      }
      const a = rand() * Math.PI * 2, r = 160 + rand() * 120
      g.position.set(Math.cos(a) * r, 70 + rand() * 40, Math.sin(a) * r)
      g.rotation.y = rand() * 3
      this.scene.add(g)
    }
  }

  private buildGround() {
    const size = 340
    const geo = new THREE.PlaneGeometry(size, size, 90, 90)
    geo.rotateX(-Math.PI / 2)
    const colors: number[] = []
    const pos = geo.attributes.position
    const c = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i)
      const n = noise3(x * 0.05, 0, z * 0.05)
      const n2 = noise3(x * 0.2, 3, z * 0.2)
      c.setHSL(0.24 + n * 0.05, 0.55, 0.38 + n2 * 0.08)
      const d = Math.hypot(x, z)
      if (d > CONFIG.worldRadius + 6) {
        // 邊界外微微隆起
        pos.setY(i, (d - CONFIG.worldRadius - 6) * 0.25 * n)
      }
      colors.push(c.r, c.g, c.b)
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geo.computeVertexNormals()
    const mat = toon(0xffffff, { vertexColors: true, outline: false })
    const ground = mesh(geo, mat)
    ground.castShadow = false
    this.scene.add(ground)

    // 小徑
    const pathMat = toon(0xc8b27a, { outline: false })
    for (let i = 0; i < 160; i++) {
      const t = i / 160
      const a = t * Math.PI * 2
      const r = (34 + Math.sin(a * 3) * 6) * CONFIG.mapScale
      const s = mesh(new THREE.CircleGeometry(1.6 + rand() * 0.8, 7), pathMat, false)
      s.rotation.x = -Math.PI / 2
      s.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r)
      s.receiveShadow = true
      this.scene.add(s)
    }
  }

  buildCave(id: number, name: string, cx: number, cz: number, rot: number, style: CaveStyle = MEADOW_CAVE) {
    const R = 15
    const center = new THREE.Vector3(cx, 0, cz)
    const gapAngles = [rot, rot + Math.PI]
    const rockMat = toon(style.rock, { side: THREE.DoubleSide })
    const mossMat = toon(style.moss, { side: THREE.DoubleSide })
    const thetaSplit = 1.12
    const flatten = 0.62
    const dome: THREE.Mesh[] = []

    const displace = (geo: THREE.BufferGeometry) => {
      const p = geo.attributes.position
      const v = new THREE.Vector3()
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i)
        const n = noise3(v.x * 0.25 + cx, v.y * 0.25, v.z * 0.25 + cz)
        const k = 1 + (n - 0.5) * 0.12
        v.multiplyScalar(k)
        v.y *= flatten
        p.setXYZ(i, v.x, Math.max(v.y, 0), v.z)
      }
      geo.computeVertexNormals()
    }

    const cap = new THREE.SphereGeometry(R, 36, 8, 0, Math.PI * 2, 0, thetaSplit)
    displace(cap)
    const capMesh = mesh(cap, mossMat)
    capMesh.position.copy(center)
    this.scene.add(capMesh)
    dome.push(capMesh)

    // 洞壁（留下兩個洞口）
    const segs: [number, number][] = [
      [gapAngles[0] + GAP_HALF, gapAngles[1] - GAP_HALF],
      [gapAngles[1] + GAP_HALF, gapAngles[0] + Math.PI * 2 - GAP_HALF],
    ]
    for (const [a1, a2] of segs) {
      const phiStart = Math.PI - a2
      const len = a2 - a1
      const g = new THREE.SphereGeometry(R, Math.ceil(len * 12), 6, phiStart, len, thetaSplit, Math.PI / 2 - thetaSplit)
      displace(g)
      const m = mesh(g, rockMat)
      m.position.copy(center)
      this.scene.add(m)
      dome.push(m)
    }
    this.occluders.push(...dome)

    // 洞壁碰撞（沿圓周放碰撞圓）
    const step = 1.1
    const n = Math.floor((Math.PI * 2 * R) / step)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const inGap = gapAngles.some((g) => Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) < GAP_HALF + 0.03)
      if (inGap) continue
      this.colliders.push({ x: cx + Math.cos(a) * R, z: cz + Math.sin(a) * R, r: 0.95, blocksSight: true })
    }

    const gaps: CaveGap[] = gapAngles.map((a) => ({
      angle: a,
      inner: new THREE.Vector3(cx + Math.cos(a) * (R - 3.2), 0, cz + Math.sin(a) * (R - 3.2)),
      outer: new THREE.Vector3(cx + Math.cos(a) * (R + 3.5), 0, cz + Math.sin(a) * (R + 3.5)),
    }))

    // 洞口兩側巨石 + 洞口上方的拱石
    const boulderMat = toon(style.boulder, {})
    for (const a of gapAngles) {
      for (const s of [-1, 1]) {
        const aa = a + s * (GAP_HALF + 0.08)
        const b = mesh(new THREE.DodecahedronGeometry(1.9 + rand() * 0.6, 0), boulderMat)
        b.position.set(cx + Math.cos(aa) * (R + 0.6), 1.2, cz + Math.sin(aa) * (R + 0.6))
        b.rotation.set(rand() * 3, rand() * 3, rand() * 3)
        this.scene.add(b)
        this.colliders.push({ x: b.position.x, z: b.position.z, r: 1.6, blocksSight: true })
      }
      const lintel = mesh(new THREE.BoxGeometry(2.2, 1.4, 7.6), boulderMat)
      lintel.position.set(cx + Math.cos(a) * (R + 0.2), 4.6, cz + Math.sin(a) * (R + 0.2))
      lintel.rotation.y = -a
      this.scene.add(lintel)
      // 洞口骨頭與火把
      const torchPos = new THREE.Vector3(cx + Math.cos(a + GAP_HALF + 0.2) * (R + 2.2), 0, cz + Math.sin(a + GAP_HALF + 0.2) * (R + 2.2))
      this.addTorch(torchPos, false)
    }

    // 洞內：深色地面、營火、雜物
    const floor = mesh(new THREE.CircleGeometry(R - 0.2, 28), toon(style.floor, { outline: false }), false)
    floor.rotation.x = -Math.PI / 2
    floor.position.set(cx, 0.03, cz)
    floor.receiveShadow = true
    this.scene.add(floor)

    this.addCampfire(center)
    const inside = (r: number, a: number) => new THREE.Vector3(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r)
    // 石柱（可躲在後面）
    for (let k = 0; k < 3; k++) {
      const a = rot + Math.PI / 2 + (k - 1) * 0.9 + (k === 1 ? Math.PI : 0)
      const p = inside(8 + rand() * 2, a)
      const pillar = mesh(new THREE.CylinderGeometry(0.9, 1.4, 7, 7), toon(style.pillar, {}))
      pillar.position.set(p.x, 3.5, p.z)
      this.scene.add(pillar)
      this.colliders.push({ x: p.x, z: p.z, r: 1.3, blocksSight: true })
    }
    // 稻草床、木箱、發光蘑菇
    const strawMat = toon(0xd8b860, { outline: false })
    for (let k = 0; k < 6; k++) {
      const p = inside(5 + rand() * 6, rand() * Math.PI * 2)
      const bed = mesh(new THREE.CylinderGeometry(0.9, 1.0, 0.2, 9), strawMat)
      bed.position.set(p.x, 0.1, p.z)
      bed.scale.z = 0.6
      bed.rotation.y = rand() * 3
      this.scene.add(bed)
    }
    const crateMat = toon(0x8a5a32)
    for (let k = 0; k < 3; k++) {
      const p = inside(10.5 + rand(), rot + Math.PI / 2 + k * 0.4 - 0.4 + (k % 2) * Math.PI)
      const crate = mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), crateMat)
      crate.position.set(p.x, 0.55, p.z)
      crate.rotation.y = rand() * 3
      this.scene.add(crate)
      this.colliders.push({ x: p.x, z: p.z, r: 0.75, blocksSight: false })
    }
    const shroomCap = toon(style.shroom, { emissive: style.shroomGlow, outline: false })
    const shroomStem = toon(0xe8e0c8, { outline: false })
    for (let k = 0; k < 14; k++) {
      const p = inside(R - 2 - rand() * 2, rand() * Math.PI * 2)
      const g = new THREE.Group()
      const stem = mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.4, 6), shroomStem, false)
      stem.position.y = 0.2
      const capm = mesh(new THREE.SphereGeometry(0.22, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), shroomCap, false)
      capm.position.y = 0.38
      g.add(stem, capm)
      if (k % 2 === 0) {
        const halo = glowSprite(style.halo, 1.1, 0.55)
        halo.position.y = 0.42
        g.add(halo)
      }
      g.position.copy(p)
      g.scale.setScalar(0.7 + rand() * 1.2)
      this.scene.add(g)
    }

    style.extra?.(this, center, R, gapAngles)
    this.caves.push({ id, name, center, radius: R, gaps, dome, kind: 'cave' })
  }

  addCampfire(p: THREE.Vector3) {
    const g = new THREE.Group()
    g.position.copy(p)
    const stoneMat = toon(0x777068, {})
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const s = mesh(new THREE.DodecahedronGeometry(0.28, 0), stoneMat)
      s.position.set(Math.cos(a) * 0.9, 0.15, Math.sin(a) * 0.9)
      g.add(s)
    }
    const logMat = toon(0x6a4326)
    for (let i = 0; i < 3; i++) {
      const l = mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.3, 6), logMat)
      l.rotation.set(Math.PI / 2, 0, (i / 3) * Math.PI)
      l.position.y = 0.15
      g.add(l)
    }
    const core = glowSprite(0xffa040, 2.6, 0.9)
    core.position.y = 0.6
    g.add(core)
    this.fires.push({ pos: new THREE.Vector3(p.x, 0.2, p.z), scale: 1, smoke: true })
    const light = new THREE.PointLight(0xffa850, 22, 24, 1.2)
    light.position.y = 1.6
    g.add(light)
    this.fireLights.push(light)
    this.scene.add(g)
    this.colliders.push({ x: p.x, z: p.z, r: 1.2, blocksSight: false })
  }

  addTorch(p: THREE.Vector3, light: boolean) {
    const pole = mesh(new THREE.CylinderGeometry(0.07, 0.09, 2, 6), toon(0x5a3a22))
    pole.position.set(p.x, 1, p.z)
    this.scene.add(pole)
    const bowl = mesh(new THREE.CylinderGeometry(0.2, 0.12, 0.18, 7), toon(0x4a3a2a))
    bowl.position.set(p.x, 2.05, p.z)
    this.scene.add(bowl)
    const glow = glowSprite(0xffa040, 1.4, 0.85)
    glow.position.set(p.x, 2.35, p.z)
    this.scene.add(glow)
    this.fires.push({ pos: new THREE.Vector3(p.x, 2.12, p.z), scale: 0.38, smoke: false })
    if (light) {
      const l = new THREE.PointLight(0xff9a40, 10, 10)
      l.position.set(p.x, 2.4, p.z)
      this.scene.add(l)
    }
  }

  buildCage(roofColor = 0x4f7a3a) {
    const g = new THREE.Group()
    g.position.copy(this.cagePos)
    const wood = toon(0x7a4f2a)
    const R = 2.6
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      const bar = mesh(new THREE.CylinderGeometry(0.08, 0.08, 3, 5), wood)
      bar.position.set(Math.cos(a) * R, 1.5, Math.sin(a) * R)
      g.add(bar)
    }
    for (const y of [0.15, 3]) {
      const ring = mesh(new THREE.TorusGeometry(R, 0.12, 5, 24), wood)
      ring.rotation.x = Math.PI / 2
      ring.position.y = y
      g.add(ring)
    }
    const roof = mesh(new THREE.ConeGeometry(R + 0.6, 1.6, 12), toon(roofColor))
    roof.position.y = 3.8
    g.add(roof)
    const flag = mesh(new THREE.BoxGeometry(0.8, 0.5, 0.04), toon(0xf0e0ff))
    flag.position.set(0.4, 5.2, 0)
    g.add(flag)
    const flagPole = mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 4), toon(0xd9b24c))
    flagPole.position.set(0, 4.9, 0)
    g.add(flagPole)
    this.scene.add(g)
    this.colliders.push({ x: this.cagePos.x, z: this.cagePos.z, r: R + 0.3, blocksSight: false })
  }

  freeSpot(minClear: number) {
    for (let tries = 0; tries < 60; tries++) {
      const a = rand() * Math.PI * 2
      const r = 10 + Math.sqrt(rand()) * (CONFIG.worldRadius - 12)
      const x = Math.cos(a) * r, z = Math.sin(a) * r
      let ok = true
      for (const c of this.caves) {
        if (Math.hypot(x - c.center.x, z - c.center.z) < c.radius + 7) ok = false
      }
      if (Math.hypot(x, z) < 9) ok = false
      for (const k of this.keepOut) if (Math.hypot(x - k.x, z - k.z) < k.r + minClear) ok = false
      for (const col of this.colliders) if (Math.hypot(x - col.x, z - col.z) < col.r + minClear) ok = false
      if (ok) return new THREE.Vector3(x, 0, z)
    }
    return null
  }

  private scatterNature() {
    const trunkMat = toon(0x7a5232)
    const leafMats = [toon(0x4f9a3a, {}), toon(0x6bb04a, {}), toon(0x3d7f3a, {})]
    for (let i = 0; i < 70; i++) {
      const p = this.freeSpot(3)
      if (!p) continue
      const t = new THREE.Group()
      const h = 3 + rand() * 2.5
      const trunk = mesh(new THREE.CylinderGeometry(0.25, 0.4, h, 7), trunkMat)
      trunk.position.y = h / 2
      t.add(trunk)
      const lm = leafMats[i % 3]
      const pine = rand() < 0.35
      if (pine) {
        for (let k = 0; k < 3; k++) {
          const cone = mesh(new THREE.ConeGeometry(2.2 - k * 0.5, 2.4, 8), lm)
          cone.position.y = h + k * 1.3 - 0.3
          t.add(cone)
        }
      } else {
        for (let k = 0; k < 4; k++) {
          const blob = mesh(new THREE.IcosahedronGeometry(1.4 + rand() * 0.8, 0), lm)
          blob.position.set((rand() - 0.5) * 2, h + rand() * 1.2, (rand() - 0.5) * 2)
          t.add(blob)
        }
      }
      t.position.copy(p)
      t.rotation.y = rand() * 6
      this.scene.add(t)
      this.colliders.push({ x: p.x, z: p.z, r: 0.7, blocksSight: true })
    }
    const rockMat = toon(0x9a958a, {})
    for (let i = 0; i < 40; i++) {
      const p = this.freeSpot(2)
      if (!p) continue
      const s = 0.6 + rand() * 1.4
      const r = mesh(new THREE.DodecahedronGeometry(s, 0), rockMat)
      r.position.set(p.x, s * 0.5, p.z)
      r.rotation.set(rand() * 3, rand() * 3, rand() * 3)
      this.scene.add(r)
      this.colliders.push({ x: p.x, z: p.z, r: s * 0.9, blocksSight: s > 1.2 })
    }
    // 灌木（不擋路但擋視線不算）
    const bushMat = toon(0x5a9a3c, {})
    for (let i = 0; i < 50; i++) {
      const p = this.freeSpot(1)
      if (!p) continue
      const b = mesh(new THREE.IcosahedronGeometry(0.8 + rand() * 0.5, 0), bushMat)
      b.position.set(p.x, 0.5, p.z)
      b.scale.y = 0.7
      this.scene.add(b)
    }

    // 草叢 InstancedMesh
    const blade = new THREE.ConeGeometry(0.07, 0.6, 3)
    blade.translate(0, 0.3, 0)
    const gm = new THREE.MeshLambertMaterial({ color: 0xffffff })
    noOutline(gm)
    gm.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.time
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vec4 wp = instanceMatrix * vec4(0.,0.,0.,1.);
         float sway = sin(uTime*2.0 + wp.x*0.3 + wp.z*0.2) * 0.12 * position.y;
         transformed.x += sway; transformed.z += sway*0.5;`,
      )
    }
    const count = 9000
    const grass = new THREE.InstancedMesh(blade, gm, count)
    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const col = new THREE.Color()
    let placed = 0
    for (let i = 0; i < count * 2 && placed < count; i++) {
      const a = rand() * Math.PI * 2
      const r = Math.sqrt(rand()) * (CONFIG.worldRadius + 5)
      const x = Math.cos(a) * r, z = Math.sin(a) * r
      if (this.caves.some((c) => Math.hypot(x - c.center.x, z - c.center.z) < c.radius + 1)) continue
      if (Math.hypot(x, z) < 3.2) continue
      const s = 0.6 + rand() * 0.9
      q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.4, rand() * 6, (rand() - 0.5) * 0.4))
      m4.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s))
      grass.setMatrixAt(placed, m4)
      col.setHSL(0.22 + rand() * 0.07, 0.6, 0.35 + rand() * 0.15)
      grass.setColorAt(placed, col)
      placed++
    }
    grass.count = placed
    grass.receiveShadow = true
    this.scene.add(grass)

    // 花
    const flowerColors = [0xffffff, 0xffe066, 0xff8fb0, 0xb48cff]
    for (const fc of flowerColors) {
      const fgeo = new THREE.IcosahedronGeometry(0.12, 0)
      const fl = new THREE.InstancedMesh(fgeo, toon(fc, { outline: false, emissive: 0x222222 }), 220)
      for (let i = 0; i < 220; i++) {
        const p = this.freeSpot(0) ?? new THREE.Vector3(999, -5, 0)
        m4.makeTranslation(p.x, 0.4, p.z)
        fl.setMatrixAt(i, m4)
      }
      this.scene.add(fl)
    }
  }

  private buildMountains() {
    const mats = [toon(0x6f8fa8, { outline: false }), toon(0x8aa6b8, { outline: false })]
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2 + rand() * 0.1
      const r = 175 + rand() * 40
      const h = 30 + rand() * 45
      const m = new THREE.Mesh(new THREE.ConeGeometry(25 + rand() * 20, h, 6), mats[i % 2])
      m.position.set(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r)
      this.scene.add(m)
      const snow = new THREE.Mesh(new THREE.ConeGeometry(8, h * 0.25, 6), toon(0xffffff, { outline: false }))
      snow.position.set(m.position.x, h - h * 0.125 - 2.2, m.position.z)
      snow.scale.setScalar(1)
      this.scene.add(snow)
    }
    // 邊界樹籬
    const hedge = toon(0x3d6f34, {})
    for (let i = 0; i < 90; i++) {
      const a = (i / 90) * Math.PI * 2
      const r = CONFIG.worldRadius + 4 + rand() * 3
      const b = mesh(new THREE.IcosahedronGeometry(3 + rand() * 1.5, 0), hedge, false)
      b.position.set(Math.cos(a) * r, 1.5, Math.sin(a) * r)
      this.scene.add(b)
    }
  }

  update(dt: number) {
    this.time.value += dt
    const t = this.time.value
    this.fireLights.forEach((l, i) => (l.intensity = 22 + Math.sin(t * 9 + i) * 3 + Math.sin(t * 23 + i * 3) * 2))
    for (const a of this.animators) a(dt, t)
  }

  bounce(warp: number) {
    this.onBounce?.(warp)
  }

  // 孢子霧擋視線：線段離正在噴霧的噴泉中心比霧的半徑近
  private ventBlocks(a: THREE.Vector3, b: THREE.Vector3) {
    if (!this.vents.length) return false
    const dx = b.x - a.x, dz = b.z - a.z
    const len2 = dx * dx + dz * dz
    for (const v of this.activeVents()) {
      const t = Math.max(0, Math.min(1, ((v.pos.x - a.x) * dx + (v.pos.z - a.z) * dz) / (len2 || 1)))
      const px = a.x + dx * t - v.pos.x, pz = a.z + dz * t - v.pos.z
      if (px * px + pz * pz < v.radius * v.radius) return true
    }
    return false
  }

  // 線段是否被阻擋視線
  lineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const dx = b.x - a.x, dz = b.z - a.z
    const len2 = dx * dx + dz * dz
    for (const c of this.colliders) {
      if (!c.blocksSight) continue
      const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.z - a.z) * dz) / (len2 || 1)))
      const px = a.x + dx * t - c.x, pz = a.z + dz * t - c.z
      if (px * px + pz * pz < c.r * c.r * 0.8) return false
    }
    return !this.ventBlocks(a, b)
  }

  // 射線最先碰到阻擋物的距離
  rayDistance(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    let best = maxDist
    for (const c of this.colliders) {
      if (!c.blocksSight) continue
      const ox = c.x - origin.x, oz = c.z - origin.z
      const t = ox * dir.x + oz * dir.z
      if (t < 0 || t > best) continue
      const d2 = ox * ox + oz * oz - t * t
      const r2 = c.r * c.r * 0.8
      if (d2 > r2) continue
      const hit = t - Math.sqrt(r2 - d2)
      if (hit > 0.3 && hit < best) best = hit
    }
    // 孢子霧：光束射進霧裡就停住
    for (const v of this.vents.length ? this.activeVents() : []) {
      const ox = v.pos.x - origin.x, oz = v.pos.z - origin.z
      const t = ox * dir.x + oz * dir.z
      const d2 = ox * ox + oz * oz - t * t
      const r2 = v.radius * v.radius
      if (d2 > r2) continue
      const hit = Math.max(0.3, t - Math.sqrt(r2 - d2))
      if (t + Math.sqrt(r2 - d2) > 0 && hit < best) best = hit
    }
    return best
  }

  // 圓形碰撞推出
  resolve(p: THREE.Vector3, r: number) {
    for (const c of this.colliders) {
      const dx = p.x - c.x, dz = p.z - c.z
      const min = c.r + r
      const d2 = dx * dx + dz * dz
      if (d2 < min * min) {
        const d = Math.sqrt(d2) || 0.0001
        p.x = c.x + (dx / d) * min
        p.z = c.z + (dz / d) * min
      }
    }
    const d = Math.hypot(p.x, p.z)
    if (d > CONFIG.worldRadius) {
      p.x *= CONFIG.worldRadius / d
      p.z *= CONFIG.worldRadius / d
    }
  }

  blockedAt(x: number, z: number, r: number) {
    for (const c of this.colliders) {
      const dx = x - c.x, dz = z - c.z
      if (dx * dx + dz * dz < (c.r + r) ** 2) return true
    }
    return Math.hypot(x, z) > CONFIG.worldRadius
  }
}
