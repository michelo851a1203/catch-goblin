import * as THREE from 'three'
import { mesh, toon } from './toon'

const C = {
  goblinSkin: 0x9cc24a,
  earInner: 0xec9a72,
  nose: 0xe06b4c,
  bandana: 0xc63e2c,
  bandanaDark: 0x9e2e20,
  vest: 0xe8dec6,
  vestPatch: 0xc9b896,
  shorts: 0x5e5248,
  shoe: 0x77703a,
  wrap: 0xece4d0,
  eyeWhite: 0xfff6d8,
  iris: 0xe39a1c,
  pupil: 0x1a1208,
  hairDark: 0x3a2a20,
  mouth: 0x5a1e18,
  teeth: 0xfffbe8,

  elfSkin: 0xfde4d2,
  elfHair: 0xf6d98f,
  elfHair2: 0xe8c271,
  gown: 0xf8f4ea,
  gownGreen: 0x3c6b4b,
  gownGreen2: 0x2f5a3d,
  gold: 0xdcb54e,
  elfIris: 0x3b8f62,
  lash: 0x4a3420,
  lips: 0xe06a78,
  gem: 0x5cc8f0,
}

export type Pose = 'normal' | 'stunned' | 'rooted' | 'held' | 'cast' | 'play' | 'attack' | 'pack'

export interface AnimFlags {
  scared?: boolean
  dash?: boolean
}

export interface CharacterModel {
  root: THREE.Group
  animate(dt: number, moveSpeed01: number, pose: Pose, flags?: AnimFlags): void
  setHarp?(on: boolean): void
}

// ───────────────────────── 幾何工具 ─────────────────────────
function pivot(x: number, y: number, z: number, parent?: THREE.Object3D) {
  const g = new THREE.Group()
  g.position.set(x, y, z)
  parent?.add(g)
  return g
}

function capsule(r: number, len: number, mat: THREE.Material) {
  const m = mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat)
  m.position.y = -len / 2 - r * 0.3
  return m
}

let seedV = 7
function srand() {
  seedV = (seedV * 16807) % 2147483647
  return (seedV - 1) / 2147483646
}

// 下緣破爛的布料筒
function tatteredTube(rTop: number, rBot: number, h: number, seg: number, jag: number, open = true) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 3, open)
  const p = g.attributes.position
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i)
    if (Math.abs(y + h / 2) < 1e-4) {
      const idx = i % (seg + 1)
      const tear = idx % 2 === 0 ? jag * (0.4 + srand() * 0.8) : -jag * 0.2 * srand()
      p.setY(i, y - tear)
      const k = 1 + (srand() - 0.3) * 0.12
      p.setX(i, p.getX(i) * k)
      p.setZ(i, p.getZ(i) * k)
    } else {
      const k = 1 + (srand() - 0.5) * 0.04
      p.setX(i, p.getX(i) * k)
      p.setZ(i, p.getZ(i) * k)
    }
  }
  g.computeVertexNormals()
  return g
}

// 帶缺口的哥布林尖耳
function goblinEarGeo(len: number, w: number, notch: boolean) {
  const s = new THREE.Shape()
  s.moveTo(0, -w * 0.45)
  s.quadraticCurveTo(len * 0.5, -w * 0.5, len, -w * 0.02)
  s.quadraticCurveTo(len * 0.6, w * 0.42, len * 0.3, w * 0.58)
  if (notch) {
    s.lineTo(len * 0.25, w * 0.4)
    s.lineTo(len * 0.19, w * 0.6)
  }
  s.quadraticCurveTo(0.02, w * 0.62, 0, -w * 0.45)
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2, curveSegments: 10 })
  g.translate(0, 0, -0.01)
  return g
}

// 優雅的精靈耳
function elfEarGeo(len: number, w: number) {
  const s = new THREE.Shape()
  s.moveTo(0, -w * 0.5)
  s.quadraticCurveTo(len * 0.55, -w * 0.25, len, w * 0.15)
  s.quadraticCurveTo(len * 0.45, w * 0.45, 0, w * 0.5)
  s.quadraticCurveTo(-w * 0.15, 0, 0, -w * 0.5)
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2, curveSegments: 10 })
  g.translate(0, 0, -0.005)
  return g
}

function starGeo(r: number) {
  const s = new THREE.Shape()
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2
    if (i === 0) s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr)
    else s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr)
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: r * 0.3, bevelEnabled: true, bevelThickness: r * 0.12, bevelSize: r * 0.1, bevelSegments: 1 })
  g.center()
  return g
}

function heartGeo(r: number) {
  const s = new THREE.Shape()
  s.moveTo(0, -r)
  s.bezierCurveTo(-r * 1.4, -r * 0.1, -r * 0.8, r * 1.1, 0, r * 0.45)
  s.bezierCurveTo(r * 0.8, r * 1.1, r * 1.4, -r * 0.1, 0, -r)
  const g = new THREE.ExtrudeGeometry(s, { depth: r * 0.35, bevelEnabled: true, bevelThickness: r * 0.15, bevelSize: r * 0.12, bevelSegments: 2, curveSegments: 10 })
  g.center()
  return g
}

// 會飄動的緞帶 / 布條
class Ribbon {
  mesh: THREE.Mesh
  private base: Float32Array
  private len: number
  private phase = Math.random() * 10
  constructor(w: number, len: number, mat: THREE.Material, seg = 8, taper = 0.6) {
    const g = new THREE.PlaneGeometry(w, len, 1, seg)
    g.translate(0, -len / 2, 0)
    const p = g.attributes.position
    for (let i = 0; i < p.count; i++) {
      const v = -p.getY(i) / len
      p.setX(i, p.getX(i) * (1 - v * taper))
    }
    this.base = Float32Array.from(p.array as Float32Array)
    this.len = len
    this.mesh = new THREE.Mesh(g, mat)
    this.mesh.castShadow = true
  }
  update(dt: number, amp: number, back: number, freq = 5) {
    this.phase += dt * freq
    const p = this.mesh.geometry.attributes.position
    const b = this.base
    for (let i = 0; i < p.count; i++) {
      const y = b[i * 3 + 1]
      const v = -y / this.len
      const wave = Math.sin(this.phase - v * 4) * amp * v
      p.setXYZ(i, b[i * 3] + Math.sin(this.phase * 0.7 - v * 3) * amp * 0.3 * v, y + back * v * v * 0.3, b[i * 3 + 2] - back * v * v - wave)
    }
    p.needsUpdate = true
    this.mesh.geometry.computeVertexNormals()
  }
}

// 漸細且向後彎的髮束
function lockGeo(len: number, r: number, bend: number, wave = 0) {
  const pts: THREE.Vector2[] = []
  const n = 10
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const rad = r * Math.sin(Math.min(1, t * 3 + 0.25) * Math.PI * 0.5) * (1 - t * 0.82)
    pts.push(new THREE.Vector2(Math.max(0.002, rad), -t * len))
  }
  const g = new THREE.LatheGeometry(pts, 8)
  const p = g.attributes.position
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i)
    const t = -y / len
    p.setZ(i, p.getZ(i) - bend * t * t)
    p.setX(i, p.getX(i) + Math.sin(t * Math.PI * 2) * wave)
  }
  g.scale(1, 1, 0.6)
  g.computeVertexNormals()
  return g
}

function flower(scale: number, petal = 0xffffff, center = 0xffd84a) {
  const g = new THREE.Group()
  const pm = toon(petal, { emissive: 0x222222 })
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2
    const p = mesh(new THREE.SphereGeometry(0.03, 8, 6), pm)
    p.scale.set(1, 0.35, 0.6)
    p.position.set(Math.cos(a) * 0.03, 0, Math.sin(a) * 0.03)
    p.rotation.y = -a
    g.add(p)
  }
  const c = mesh(new THREE.SphereGeometry(0.016, 6, 5), toon(center, { emissive: 0x443300, outline: false }))
  c.position.y = 0.008
  g.add(c)
  g.scale.setScalar(scale)
  return g
}

// 狀態環繞物（暈眩星星 / 定身愛心）
function orbit(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, r: number) {
  const g = new THREE.Group()
  const items: THREE.Mesh[] = []
  for (let i = 0; i < n; i++) {
    const m = mesh(geo, mat, false)
    const a = (i / n) * Math.PI * 2
    m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r)
    g.add(m)
    items.push(m)
  }
  g.visible = false
  return { g, items }
}

// ───────────────────────── 哥布林 ─────────────────────────
export function createGoblin(tint = 0): CharacterModel {
  seedV = 11 + tint * 13
  const root = new THREE.Group()
  const body = pivot(0, 0, 0, root)
  const skinColor = new THREE.Color(C.goblinSkin).offsetHSL((tint % 3) * 0.012 - 0.012, 0, ((tint % 4) - 1.5) * 0.015)
  const skin = toon(skinColor.getHex())
  const rag = toon(C.bandana, { side: THREE.DoubleSide })
  const ragFlat = toon(C.bandana, { side: THREE.DoubleSide, outline: false })

  // 骨盆
  const hips = pivot(0, 0.5, 0, body)
  const shorts = mesh(tatteredTube(0.19, 0.25, 0.24, 14, 0.07, false), toon(C.shorts, { side: THREE.DoubleSide }))
  shorts.position.y = -0.04
  hips.add(shorts)
  const sash = mesh(new THREE.TorusGeometry(0.2, 0.035, 6, 18), rag)
  sash.rotation.x = Math.PI / 2
  sash.position.y = 0.07
  hips.add(sash)
  const sashTail = new Ribbon(0.09, 0.3, ragFlat, 6, 0.5)
  sashTail.mesh.position.set(0.17, 0.06, 0.08)
  sashTail.mesh.rotation.y = 0.9
  hips.add(sashTail.mesh)

  // 腿：大腿 → 膝蓋 → 小腿 → 腳踝
  const legs: { thigh: THREE.Group; knee: THREE.Group; ankle: THREE.Group }[] = []
  for (const s of [-1, 1]) {
    const thigh = pivot(0.11 * s, -0.06, 0, hips)
    thigh.add(capsule(0.068, 0.15, skin))
    const knee = pivot(0, -0.22, 0, thigh)
    knee.add(mesh(new THREE.SphereGeometry(0.065, 8, 6), skin))
    knee.add(capsule(0.058, 0.13, skin))
    for (let k = 0; k < 2; k++) {
      const wrap = mesh(new THREE.TorusGeometry(0.066 - k * 0.004, 0.022, 5, 12), toon(C.wrap))
      wrap.rotation.x = Math.PI / 2 + (k ? 0.2 : -0.1)
      wrap.position.y = -0.14 - k * 0.045
      knee.add(wrap)
    }
    const ankle = pivot(0, -0.23, 0, knee)
    const foot = mesh(new THREE.SphereGeometry(0.1, 10, 8), toon(C.shoe))
    foot.scale.set(0.85, 0.5, 1.4)
    foot.position.set(0, -0.02, 0.06)
    ankle.add(foot)
    for (let k = -1; k <= 1; k++) {
      const toe = mesh(new THREE.SphereGeometry(0.035, 6, 5), toon(C.shoe))
      toe.position.set(k * 0.035, -0.03, 0.19)
      ankle.add(toe)
    }
    legs.push({ thigh, knee, ankle })
  }

  // 上身（可前傾）
  const chest = pivot(0, 0.52, 0, body)
  const torso = mesh(new THREE.SphereGeometry(0.2, 14, 10), skin)
  torso.scale.set(1, 1.15, 0.85)
  torso.position.y = 0.16
  chest.add(torso)
  const belly = mesh(new THREE.SphereGeometry(0.15, 10, 8), skin)
  belly.position.set(0, 0.06, 0.06)
  chest.add(belly)
  const vest = mesh(tatteredTube(0.2, 0.235, 0.3, 16, 0.08), toon(C.vest, { side: THREE.DoubleSide }))
  vest.position.y = 0.17
  vest.scale.z = 0.9
  chest.add(vest)
  for (const [x, y, z, r] of [
    [0.12, 0.12, 0.17, 0.4],
    [-0.15, 0.22, -0.13, -0.3],
  ]) {
    const patch = mesh(new THREE.BoxGeometry(0.07, 0.07, 0.012), toon(C.vestPatch, { outline: false }))
    patch.position.set(x, y, z)
    patch.rotation.set(0, Math.atan2(x, z), r)
    chest.add(patch)
  }
  // 紅領巾
  const scarf = mesh(new THREE.TorusGeometry(0.12, 0.055, 8, 16), rag)
  scarf.rotation.x = Math.PI / 2
  scarf.position.y = 0.36
  scarf.scale.set(1, 1, 0.8)
  chest.add(scarf)
  const scarfFront = mesh(tatteredTube(0.001, 0.11, 0.18, 6, 0.04, false), rag)
  scarfFront.scale.z = 0.35
  scarfFront.position.set(0, 0.26, 0.13)
  scarfFront.rotation.x = 0.25
  chest.add(scarfFront)
  const scarfTail = new Ribbon(0.08, 0.26, ragFlat, 6, 0.6)
  scarfTail.mesh.position.set(-0.08, 0.36, -0.1)
  scarfTail.mesh.rotation.y = Math.PI + 0.4
  chest.add(scarfTail.mesh)

  // 手臂：肩 → 手肘 → 手腕，三指 + 拇指
  const arms: { sh: THREE.Group; elbow: THREE.Group; hand: THREE.Group }[] = []
  for (const s of [-1, 1]) {
    const sh = pivot(0.2 * s, 0.31, 0, chest)
    sh.add(mesh(new THREE.SphereGeometry(0.06, 8, 6), skin))
    sh.add(capsule(0.045, 0.13, skin))
    const elbow = pivot(0, -0.2, 0, sh)
    elbow.add(capsule(0.042, 0.12, skin))
    const hand = pivot(0, -0.19, 0, elbow)
    const palm = mesh(new THREE.SphereGeometry(0.055, 8, 6), skin)
    palm.scale.set(1, 0.8, 0.7)
    hand.add(palm)
    for (let k = -1; k <= 1; k++) {
      const f = mesh(new THREE.CapsuleGeometry(0.014, 0.06, 2, 5), skin)
      f.position.set(k * 0.028, -0.07, 0.01)
      f.rotation.set(0.3, 0, k * 0.15)
      hand.add(f)
      const claw = mesh(new THREE.ConeGeometry(0.012, 0.025, 4), toon(0xd8d0a0, { outline: false }))
      claw.position.set(k * 0.03, -0.115, 0.025)
      claw.rotation.x = Math.PI + 0.4
      hand.add(claw)
    }
    const thumb = mesh(new THREE.CapsuleGeometry(0.014, 0.04, 2, 5), skin)
    thumb.position.set(-0.04 * s, -0.03, 0.04)
    thumb.rotation.set(0.8, 0, 0.6 * s)
    hand.add(thumb)
    arms.push({ sh, elbow, hand })
  }

  // 頭
  const head = pivot(0, 0.5, 0.03, chest)
  const skullGeo = new THREE.SphereGeometry(0.27, 20, 14)
  {
    const p = skullGeo.attributes.position
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      // 臉頰鼓起、下巴收窄
      const cheek = y < 0 ? 1 + 0.12 * Math.max(0, z / 0.27) * (1 - Math.abs(y) / 0.27) : 1
      const chin = y < -0.12 ? 1 - (-y - 0.12) * 0.9 : 1
      p.setXYZ(i, x * 1.08 * cheek * chin, y * 0.95, z * cheek)
    }
    skullGeo.computeVertexNormals()
  }
  head.add(mesh(skullGeo, skin))

  // 眼睛（眼白、虹膜、瞳孔、高光、眼皮）
  const lids: THREE.Mesh[] = []
  const pupils: THREE.Mesh[] = []
  const heartPupils: THREE.Mesh[] = []
  const brows: THREE.Mesh[] = []
  const heartPupilGeo = heartGeo(0.03)
  const heartPupilMat = toon(0xff4f9a, { emissive: 0x991a50, outline: false })
  for (const s of [-1, 1]) {
    const eye = pivot(0.105 * s, 0.045, 0.205, head)
    const white = mesh(new THREE.SphereGeometry(0.088, 14, 10), toon(C.eyeWhite))
    white.scale.set(1, 1.08, 0.75)
    eye.add(white)
    const iris = mesh(new THREE.SphereGeometry(0.052, 12, 8), toon(C.iris, { outline: false }))
    iris.scale.set(1, 1, 0.4)
    iris.position.set(0.006 * s, -0.004, 0.058)
    eye.add(iris)
    const pupil = mesh(new THREE.SphereGeometry(0.028, 8, 6), toon(C.pupil, { outline: false }))
    pupil.scale.set(1, 1, 0.4)
    pupil.position.set(0.006 * s, -0.004, 0.072)
    eye.add(pupil)
    pupils.push(pupil)
    const hp = mesh(heartPupilGeo, heartPupilMat, false)
    hp.position.set(0.006 * s, -0.004, 0.072)
    hp.visible = false
    eye.add(hp)
    heartPupils.push(hp)
    const hi = mesh(new THREE.SphereGeometry(0.012, 6, 4), toon(0xffffff, { outline: false, emissive: 0xffffff }))
    hi.position.set(-0.016 + 0.01 * s, 0.022, 0.08)
    eye.add(hi)
    const lid = mesh(new THREE.SphereGeometry(0.095, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), skin)
    lid.scale.set(1, 1.08, 0.8)
    eye.add(lid)
    lids.push(lid)
    const brow = mesh(new THREE.CapsuleGeometry(0.018, 0.08, 3, 6), toon(C.hairDark, { outline: false }))
    brow.rotation.z = Math.PI / 2
    brow.position.set(0.105 * s, 0.155, 0.225)
    head.add(brow)
    brows.push(brow)
  }

  // 鼻子、嘴巴、牙齒
  const nose = mesh(new THREE.SphereGeometry(0.085, 12, 10), toon(C.nose))
  nose.scale.set(1.05, 0.82, 0.95)
  nose.position.set(0, -0.055, 0.285)
  head.add(nose)
  const noseTip = mesh(new THREE.SphereGeometry(0.03, 6, 5), toon(0xf08a6a, { outline: false }))
  noseTip.position.set(-0.025, -0.03, 0.35)
  head.add(noseTip)
  const mouthPivot = pivot(0, -0.135, 0.235, head)
  const mouth = mesh(new THREE.SphereGeometry(0.1, 12, 6, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5), toon(C.mouth, { outline: false }))
  mouth.scale.set(1.35, 0.55, 0.6)
  mouth.rotation.z = 0.08
  mouthPivot.add(mouth)
  const teethMat = toon(C.teeth, { outline: false })
  for (const x of [-0.055, -0.02, 0.05]) {
    const t = mesh(new THREE.ConeGeometry(0.014, 0.035, 4), teethMat)
    t.rotation.x = Math.PI
    t.position.set(x, -0.008, 0.045)
    mouthPivot.add(t)
  }
  const lowerFang = mesh(new THREE.ConeGeometry(0.012, 0.03, 4), teethMat)
  lowerFang.position.set(0.035, -0.035, 0.045)
  mouthPivot.add(lowerFang)

  // 耳朵（可彈動）
  const ears: THREE.Group[] = []
  const earGeo = goblinEarGeo(0.5, 0.22, true)
  const earGeoR = goblinEarGeo(0.5, 0.22, tint % 2 === 0)
  const innerGeo = goblinEarGeo(0.34, 0.13, false)
  for (const s of [-1, 1]) {
    const ep = pivot(0.235 * s, 0.05, -0.03, head)
    ep.scale.x = s
    const tilt = pivot(0, 0, 0, ep)
    tilt.rotation.set(0, -0.35, 0.3)
    tilt.add(mesh(s > 0 ? earGeoR : earGeo, skin))
    const inner = mesh(innerGeo, toon(C.earInner, { outline: false }))
    inner.position.set(0.05, 0.0, 0.022)
    tilt.add(inner)
    ears.push(tilt)
  }

  // 頭巾 + 瀏海 + 結 + 飄帶
  const bandGeo = new THREE.SphereGeometry(0.29, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.48)
  {
    const p = bandGeo.attributes.position
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      const w = 1 + Math.sin(x * 40 + z * 25) * 0.025 + Math.sin(y * 50) * 0.015
      p.setXYZ(i, x * w, y * w, z * w)
    }
    bandGeo.computeVertexNormals()
  }
  const bandana = mesh(bandGeo, rag)
  bandana.position.set(0, 0.1, -0.03)
  bandana.scale.set(1.06, 0.85, 1.04)
  bandana.rotation.x = -0.32
  head.add(bandana)
  const rim = mesh(new THREE.TorusGeometry(0.285, 0.022, 6, 28), toon(C.bandanaDark))
  rim.position.set(0, 0.115, -0.03)
  rim.rotation.x = Math.PI / 2 - 0.32
  rim.scale.set(1.08, 1.05, 1)
  head.add(rim)
  for (let k = 0; k < 5; k++) {
    const tuft = mesh(new THREE.ConeGeometry(0.03, 0.09, 4), toon(C.hairDark, { outline: false }))
    tuft.position.set(-0.12 + k * 0.06, 0.19 - Math.abs(k - 2) * 0.012, 0.215 - Math.abs(k - 2) * 0.02)
    tuft.rotation.set(Math.PI + 0.5, 0, (k - 2) * 0.2)
    head.add(tuft)
  }
  const knot = mesh(new THREE.SphereGeometry(0.065, 8, 6), rag)
  knot.position.set(0.06, 0.12, -0.27)
  head.add(knot)
  const tails: Ribbon[] = []
  for (const s of [-1, 1]) {
    const r = new Ribbon(0.09, 0.32, ragFlat, 7, 0.55)
    r.mesh.position.set(0.06 + 0.04 * s, 0.12, -0.3)
    r.mesh.rotation.set(-0.5, Math.PI + 0.3 * s, 0.3 * s)
    head.add(r.mesh)
    tails.push(r)
  }

  // 狀態環繞
  const stars = orbit(starGeo(0.06), toon(0xffe04a, { emissive: 0x806010 }), 4, 0.32)
  stars.g.position.y = 1.5
  root.add(stars.g)
  const hearts = orbit(heartGeo(0.06), toon(0xff5fa8, { emissive: 0x80204a }), 3, 0.35)
  hearts.g.position.y = 1.5
  root.add(hearts.g)

  // 麻袋（被打包時套住身體，頭露在外面）
  const sackPts = [
    [0.05, 0], [0.32, 0.04], [0.42, 0.25], [0.44, 0.5], [0.38, 0.75], [0.22, 0.9], [0.16, 0.96],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  const sack = mesh(new THREE.LatheGeometry(sackPts, 16), toon(0xb68f58, { side: THREE.DoubleSide }))
  sack.visible = false
  root.add(sack)
  const rope = mesh(new THREE.TorusGeometry(0.18, 0.035, 6, 14), toon(0x7a5a30))
  rope.rotation.x = Math.PI / 2
  rope.position.y = 0.9
  sack.add(rope)
  const ropes: THREE.Mesh[] = []
  for (let k = 0; k < 3; k++) {
    const band = mesh(new THREE.TorusGeometry(0.43 - Math.abs(k - 1) * 0.02, 0.025, 5, 20), toon(0x7a5a30))
    band.rotation.x = Math.PI / 2
    band.position.y = 0.3 + k * 0.2
    sack.add(band)
    ropes.push(band)
  }
  const patch = mesh(new THREE.BoxGeometry(0.16, 0.14, 0.02), toon(0x8f6a3c, { outline: false }))
  patch.position.set(0.25, 0.45, 0.33)
  patch.rotation.y = 0.6
  sack.add(patch)

  let phase = Math.random() * 10
  let t = Math.random() * 10
  let sackGrow = 0
  let blinkT = 1 + Math.random() * 3
  let blink = 0
  let lookT = 0
  let lookYaw = 0
  const earVel = [0, 0]
  const earAng = [0, 0]
  let lastBob = 0
  let scaredK = 0

  return {
    root,
    animate(dt, m, pose, flags = {}) {
      t += dt
      phase += dt * (5 + 9 * Math.min(m, 1.4))
      const still = pose === 'stunned' || pose === 'rooted' || pose === 'held'
      const run = still ? 0 : m
      const dash = !!flags.dash && !still
      scaredK += ((flags.scared && !still ? 1 : 0) - scaredK) * Math.min(1, dt * 6)
      const sw = Math.sin(phase)
      const cw = Math.cos(phase)

      // 腿：鬼鬼祟祟的小碎步
      const crouch = 0.15 + run * 0.15
      for (let i = 0; i < 2; i++) {
        const sgn = i === 0 ? 1 : -1
        const ph = sw * sgn
        const L = legs[i]
        L.thigh.rotation.x = -crouch - ph * 0.85 * run
        L.knee.rotation.x = crouch * 1.8 + Math.max(0, cw * sgn) * 1.2 * run
        L.ankle.rotation.x = -crouch * 0.6 + ph * 0.3 * run
      }
      const bob = Math.abs(sw) * 0.07 * run
      const accel = (bob - lastBob) * 40 + (dash ? 0.4 : 0)
      lastBob = bob
      body.position.y = bob - crouch * 0.12
      body.rotation.x = 0.12 + run * 0.22 + (dash ? 0.25 : 0)
      body.rotation.z = sw * 0.06 * run
      chest.rotation.y = -sw * 0.18 * run
      hips.rotation.y = sw * 0.12 * run
      chest.scale.set(1, 1 + Math.sin(t * 2.4) * 0.015, 1) // 呼吸

      // 手臂
      for (let i = 0; i < 2; i++) {
        const out = i === 0 ? -1 : 1 // 往外張開的方向
        const sgn = i === 0 ? 1 : -1
        const A = arms[i]
        if (pose === 'stunned') {
          A.sh.rotation.set(0.2, 0, out * (0.6 + Math.sin(t * 3 + i) * 0.1))
          A.elbow.rotation.x = -0.2
        } else if (pose === 'rooted') {
          // 被迷住：雙手捧臉
          A.sh.rotation.set(-1.9, 0, -out * 0.5)
          A.elbow.rotation.x = -1.9
        } else if (scaredK > 0.05 && run < 0.3) {
          // 害怕：雙手縮在胸前（像設定圖）
          A.sh.rotation.set(-1.0 * scaredK, 0, out * 0.35)
          A.elbow.rotation.x = -2.0 * scaredK
        } else if (dash) {
          // 衝刺：雙手往後甩
          A.sh.rotation.set(0.9 + Math.sin(phase * 2) * 0.1, 0, out * 0.4)
          A.elbow.rotation.x = -0.3
        } else {
          A.sh.rotation.set(sw * sgn * 0.9 * run - 0.25 * run, 0, out * (0.35 + run * 0.15))
          A.elbow.rotation.x = -0.5 - run * 0.7
        }
        A.hand.rotation.x = -0.3 - run * 0.3
      }

      // 頭：東張西望、被抓時驚慌
      lookT -= dt
      if (lookT <= 0) {
        lookT = 1.5 + Math.random() * 3
        lookYaw = run > 0.3 ? 0 : (Math.random() - 0.5) * 1.2
      }
      const panic = scaredK > 0.3 || pose === 'held'
      head.rotation.y += ((panic ? Math.sin(t * 9) * 0.5 : lookYaw) - head.rotation.y) * Math.min(1, dt * 5)
      head.rotation.x = -0.12 - run * 0.15 + (pose === 'rooted' ? -0.25 : 0)
      head.rotation.z = pose === 'stunned' ? Math.sin(t * 4) * 0.3 : pose === 'rooted' ? Math.sin(t * 3) * 0.12 : 0
      head.position.y = 0.5 + Math.sin(phase * 2) * 0.012 * run

      // 表情：眨眼、眉毛、嘴巴、心形瞳孔
      blinkT -= dt
      if (blinkT <= 0) {
        blink = 1
        blinkT = 2 + Math.random() * 4
      }
      blink = Math.max(0, blink - dt * 7)
      let lidOpen = -1.15 + (panic ? -0.2 : 0)
      if (pose === 'stunned') lidOpen = 0.35
      const lidRot = lidOpen + (pose === 'stunned' ? 0 : Math.sin(blink * Math.PI) * 2.1)
      lids.forEach((l) => (l.rotation.x = lidRot))
      const love = pose === 'rooted'
      pupils.forEach((p) => (p.visible = !love))
      heartPupils.forEach((h, i) => {
        h.visible = love
        h.scale.setScalar(1 + Math.sin(t * 10 + i) * 0.2)
      })
      brows.forEach((b, i) => {
        const sgn = i === 0 ? -1 : 1
        const worried = panic ? 1 : 0
        b.rotation.z = Math.PI / 2 + sgn * (worried ? 0.45 : -0.25)
        b.position.y = 0.155 + worried * 0.025 + (pose === 'stunned' ? -0.02 : 0)
      })
      const open = panic ? 0.9 + Math.sin(t * 14) * 0.15 : pose === 'stunned' ? 0.6 : love ? 0.4 : 0.35 + run * 0.25
      mouthPivot.scale.set(panic ? 0.85 : 1, open * 2, 1)

      // 耳朵彈動（彈簧）
      for (let i = 0; i < 2; i++) {
        const target = (panic ? -0.35 : 0) + (pose === 'stunned' ? -0.5 : 0) + run * 0.1 + (dash ? 0.35 : 0)
        earVel[i] += ((target - earAng[i]) * 90 - earVel[i] * 9 - accel * 6) * dt
        earAng[i] += earVel[i] * dt
        ears[i].rotation.z = 0.3 + earAng[i]
        ears[i].rotation.y = -0.35 - (dash ? 0.5 : 0) - run * 0.15
      }

      // 布料飄動
      const wind = run * 0.25 + (dash ? 0.25 : 0)
      for (const tl of tails) tl.update(dt, 0.05 + wind * 0.15, 0.1 + wind, 6 + run * 6)
      scarfTail.update(dt, 0.04 + wind * 0.1, wind * 0.8, 6)
      sashTail.update(dt, 0.03 + run * 0.06, run * 0.3, 5)

      // 星星 / 愛心環繞
      stars.g.visible = pose === 'stunned'
      if (stars.g.visible) {
        stars.g.rotation.y += dt * 4
        stars.items.forEach((s, i) => {
          s.rotation.y = t * 6 + i
          s.position.y = Math.sin(t * 5 + i * 1.6) * 0.04
        })
      }
      hearts.g.visible = love
      if (love) {
        hearts.g.rotation.y += dt * 2.5
        hearts.items.forEach((h, i) => {
          h.rotation.y = -hearts.g.rotation.y
          h.position.y = Math.sin(t * 4 + i * 2) * 0.06
          h.scale.setScalar(1 + Math.sin(t * 8 + i) * 0.15)
        })
      }

      // 麻袋：身體縮進去，只露出頭和耳朵
      const sackTarget = pose === 'held' ? 1 : 0
      sackGrow += (sackTarget - sackGrow) * Math.min(1, dt * 6)
      sack.visible = sackGrow > 0.03
      if (sack.visible) {
        const wob = pose === 'held' ? Math.sin(t * 13) * 0.04 : 0
        sack.scale.set(sackGrow * (1 + wob), sackGrow, sackGrow * (1 - wob))
        sack.rotation.z = Math.sin(t * 9) * 0.05 * sackGrow
        ropes.forEach((r, i) => (r.visible = sackGrow > 0.5 + i * 0.12))
      }
      hips.visible = sackGrow < 0.6
      arms.forEach((a) => (a.sh.visible = sackGrow < 0.6))
      body.position.y += sackGrow * 0.12
    },
  }
}

// ───────────────────────── 女精靈 ─────────────────────────
export function createElf(): CharacterModel {
  seedV = 99
  const root = new THREE.Group()
  const body = pivot(0, 0, 0, root)
  const skin = toon(C.elfSkin)
  const hairA = toon(C.elfHair, { emissive: 0x3a2c0c })
  // 細髮束不描邊，避免變成黑色線條
  const lockA = toon(C.elfHair, { emissive: 0x3a2c0c, outline: false })
  const lockB = toon(C.elfHair2, { emissive: 0x30240a, outline: false })
  const gold = toon(C.gold, { emissive: 0x2a1f00 })
  const gemMat = toon(C.gem, { emissive: 0x1a6a98 })

  // 裙擺：內層綠色荷葉邊、外層白紗前開衩、金色滾邊
  const skirt = pivot(0, 0.98, 0, body)
  const ruffle = (rMul: number, len: number, waves: number, amp: number, phiStart = 0, phiLen = Math.PI * 2) => {
    const prof = [
      [0.15, 0],
      [0.19, -0.15],
      [0.27, -0.45],
      [0.38, -0.78],
      [0.46, -0.98],
    ]
    const pts = prof.map(([x, y]) => new THREE.Vector2(x * rMul, y * len))
    const g = new THREE.LatheGeometry(pts, 40, phiStart, phiLen)
    const p = g.attributes.position
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      const tt = -y / len
      const a = Math.atan2(x, z)
      const k = 1 + Math.sin(a * waves) * amp * tt * tt
      p.setXYZ(i, x * k, y + Math.cos(a * waves) * 0.02 * tt * tt, z * k)
    }
    g.computeVertexNormals()
    return g
  }
  skirt.add(mesh(ruffle(0.96, 0.98, 9, 0.07), toon(C.gownGreen, { side: THREE.DoubleSide })))
  skirt.add(mesh(ruffle(0.9, 1.0, 14, 0.05), toon(C.gown, { side: THREE.DoubleSide })))
  skirt.add(mesh(ruffle(1.05, 0.96, 7, 0.09, 0.5, Math.PI * 2 - 1.0), toon(C.gown, { side: THREE.DoubleSide, transparent: true, opacity: 0.88 })))
  // 金色滾邊
  const hemCurve = new THREE.CatmullRomCurve3(
    Array.from({ length: 41 }, (_, i) => {
      const a = 0.5 + (i / 40) * (Math.PI * 2 - 1.0)
      const r = 0.46 * 1.05 * (1 + Math.sin(a * 7) * 0.09)
      return new THREE.Vector3(Math.sin(a) * r, -0.94 + Math.cos(a * 7) * 0.02, Math.cos(a) * r)
    }),
  )
  skirt.add(mesh(new THREE.TubeGeometry(hemCurve, 80, 0.012, 5, false), gold))
  // 裙上的金色藤蔓紋
  for (let k = 0; k < 6; k++) {
    const a = 0.8 + k * 0.9
    const vine = new THREE.CatmullRomCurve3(
      Array.from({ length: 6 }, (_, i) => {
        const tt = i / 5
        const r = 0.19 + tt * 0.27
        const aa = a + Math.sin(tt * 6 + k) * 0.08
        return new THREE.Vector3(Math.sin(aa) * r * 1.07, -0.15 - tt * 0.78, Math.cos(aa) * r * 1.07)
      }),
    )
    skirt.add(mesh(new THREE.TubeGeometry(vine, 16, 0.006, 3, false), gold, false))
  }
  const feet: THREE.Mesh[] = []
  for (const s of [-1, 1]) {
    const f = mesh(new THREE.SphereGeometry(0.06, 8, 6), gold)
    f.scale.set(0.8, 0.5, 1.6)
    f.position.set(0.09 * s, 0.03, 0.05)
    body.add(f)
    feet.push(f)
  }

  // 腰帶 + 背後緞帶
  const waist = pivot(0, 0.98, 0, body)
  const belt = mesh(new THREE.TorusGeometry(0.145, 0.022, 6, 20), gold)
  belt.rotation.x = Math.PI / 2
  waist.add(belt)
  const beltGem = mesh(new THREE.OctahedronGeometry(0.03), gemMat)
  beltGem.position.set(0, 0, 0.15)
  waist.add(beltGem)
  const sashMat = toon(C.gownGreen2, { side: THREE.DoubleSide, outline: false })
  const sashes: Ribbon[] = []
  for (const s of [-1, 1]) {
    const r = new Ribbon(0.08, 0.75, sashMat, 12, 0.3)
    r.mesh.position.set(0.06 * s, -0.02, -0.15)
    r.mesh.rotation.set(0, Math.PI + 0.15 * s, 0.05 * s)
    waist.add(r.mesh)
    sashes.push(r)
  }
  const sheer = new Ribbon(0.3, 0.7, toon(0xffffff, { side: THREE.DoubleSide, transparent: true, opacity: 0.45, outline: false }), 10, 0.1)
  sheer.mesh.position.set(0, -0.05, -0.17)
  sheer.mesh.rotation.y = Math.PI
  waist.add(sheer.mesh)

  // 上身
  const chest = pivot(0, 0.98, 0, body)
  const bodicePts = [
    [0.13, 0], [0.12, 0.08], [0.14, 0.2], [0.155, 0.28], [0.145, 0.34], [0.09, 0.38], [0.04, 0.4],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  const bodice = mesh(new THREE.LatheGeometry(bodicePts, 18), toon(C.gown))
  bodice.scale.z = 0.82
  chest.add(bodice)
  const corsetPts = [[0.133, 0.0], [0.124, 0.08], [0.143, 0.2]].map(([x, y]) => new THREE.Vector2(x, y))
  const corset = mesh(new THREE.LatheGeometry(corsetPts, 12, -0.7, 1.4), toon(C.gownGreen, { side: THREE.DoubleSide }))
  corset.scale.z = 0.84
  chest.add(corset)
  for (let k = 0; k < 4; k++) {
    const lace = mesh(new THREE.TorusGeometry(0.012, 0.004, 3, 8), gold, false)
    lace.position.set(0, 0.03 + k * 0.045, 0.114 + k * 0.004)
    chest.add(lace)
  }
  // 胸前的金色裝飾與寶石墜飾
  const collarCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.1, 0.36, 0.02),
    new THREE.Vector3(-0.05, 0.3, 0.09),
    new THREE.Vector3(0, 0.27, 0.105),
    new THREE.Vector3(0.05, 0.3, 0.09),
    new THREE.Vector3(0.1, 0.36, 0.02),
  ])
  chest.add(mesh(new THREE.TubeGeometry(collarCurve, 20, 0.007, 4, false), gold, false))
  const pendant = mesh(new THREE.OctahedronGeometry(0.022), gemMat)
  pendant.position.set(0, 0.255, 0.11)
  pendant.scale.y = 1.4
  chest.add(pendant)
  const neck = mesh(new THREE.CylinderGeometry(0.04, 0.048, 0.12, 8), skin)
  neck.position.y = 0.43
  chest.add(neck)
  for (const s of [-1, 1]) {
    const sh = mesh(new THREE.SphereGeometry(0.05, 8, 6), skin)
    sh.position.set(0.13 * s, 0.35, 0)
    chest.add(sh)
  }

  // 手臂與紗袖
  const arms: { sh: THREE.Group; elbow: THREE.Group; hand: THREE.Group; sleeve: Ribbon }[] = []
  const sleeveMat = toon(0xffffff, { side: THREE.DoubleSide, transparent: true, opacity: 0.55, outline: false })
  for (const s of [-1, 1]) {
    const sh = pivot(0.165 * s, 0.34, 0, chest)
    sh.add(capsule(0.032, 0.2, skin))
    const elbow = pivot(0, -0.25, 0, sh)
    elbow.add(capsule(0.028, 0.18, skin))
    const armlet = mesh(new THREE.TorusGeometry(0.036, 0.008, 4, 12), gold, false)
    armlet.rotation.x = Math.PI / 2
    armlet.position.y = -0.06
    sh.add(armlet)
    const bracelet = mesh(new THREE.TorusGeometry(0.031, 0.008, 4, 12), gold, false)
    bracelet.rotation.x = Math.PI / 2
    bracelet.position.y = -0.19
    elbow.add(bracelet)
    const hand = pivot(0, -0.23, 0, elbow)
    const palm = mesh(new THREE.SphereGeometry(0.035, 8, 6), skin)
    palm.scale.set(0.8, 1.2, 0.5)
    palm.position.y = -0.03
    hand.add(palm)
    const fingers = mesh(new THREE.CapsuleGeometry(0.022, 0.04, 2, 6), skin)
    fingers.scale.z = 0.5
    fingers.position.y = -0.08
    hand.add(fingers)
    const sleeve = new Ribbon(0.2, 0.55, sleeveMat, 8, -0.4)
    sleeve.mesh.position.set(0, -0.02, -0.03)
    sleeve.mesh.rotation.y = Math.PI / 2
    sh.add(sleeve.mesh)
    arms.push({ sh, elbow, hand, sleeve })
  }

  // 頭
  const head = pivot(0, 0.56, 0.01, chest)
  head.scale.setScalar(1.12)
  const faceGeo = new THREE.SphereGeometry(0.125, 20, 16)
  {
    const p = faceGeo.attributes.position
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      const chin = y < 0 ? 1 - (-y / 0.125) * 0.28 : 1 // 尖下巴
      p.setXYZ(i, x * 0.92 * chin, y * 1.08, z * 0.96 * (y < 0 ? 1 - (-y / 0.125) * 0.1 : 1))
    }
    faceGeo.computeVertexNormals()
  }
  head.add(mesh(faceGeo, skin))
  const lids: THREE.Mesh[] = []
  for (const s of [-1, 1]) {
    const eye = pivot(0.044 * s, 0.002, 0.103, head)
    eye.rotation.y = 0.18 * s
    const white = mesh(new THREE.SphereGeometry(0.026, 12, 8), toon(0xffffff, { outline: false }))
    white.scale.set(1.25, 0.95, 0.45)
    eye.add(white)
    const iris = mesh(new THREE.SphereGeometry(0.018, 12, 8), toon(C.elfIris, { outline: false, emissive: 0x0a2a1a }))
    iris.scale.set(1, 1.15, 0.35)
    iris.position.z = 0.009
    eye.add(iris)
    const pupil = mesh(new THREE.SphereGeometry(0.009, 8, 6), toon(0x112018, { outline: false }))
    pupil.scale.set(1, 1.2, 0.3)
    pupil.position.z = 0.014
    eye.add(pupil)
    const hi = mesh(new THREE.SphereGeometry(0.005, 6, 4), toon(0xffffff, { outline: false, emissive: 0xffffff }))
    hi.position.set(-0.006, 0.007, 0.017)
    eye.add(hi)
    const lid = mesh(new THREE.SphereGeometry(0.029, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), skin)
    lid.scale.set(1.25, 1, 0.55)
    eye.add(lid)
    lids.push(lid)
    const lash = mesh(new THREE.TorusGeometry(0.03, 0.0045, 3, 12, Math.PI), toon(C.lash, { outline: false }))
    lash.position.set(0, 0.002, 0.008)
    lash.scale.set(1.15, 0.85, 1)
    eye.add(lash)
    const wing = mesh(new THREE.ConeGeometry(0.004, 0.02, 3), toon(C.lash, { outline: false }))
    wing.position.set(0.036 * s, 0.006, 0.006)
    wing.rotation.z = -1.1 * s
    eye.add(wing)
    const brow = mesh(new THREE.TorusGeometry(0.03, 0.0035, 3, 10, Math.PI * 0.7), toon(0xc9a060, { outline: false }))
    brow.position.set(0.046 * s, 0.048, 0.108)
    brow.rotation.z = Math.PI * 0.15 + (s > 0 ? -0.15 : 0.15)
    head.add(brow)
    const blush = mesh(new THREE.SphereGeometry(0.02, 6, 4), toon(0xf7a5ad, { outline: false, transparent: true, opacity: 0.55 }))
    blush.position.set(0.065 * s, -0.035, 0.09)
    blush.scale.set(1.4, 0.6, 0.3)
    head.add(blush)
    // 精靈耳
    const ep = pivot(0.106 * s, -0.012, -0.005, head)
    ep.scale.x = s
    ep.rotation.set(0, -0.75, 0.22)
    ep.add(mesh(elfEarGeo(0.17, 0.06), skin))
    const earInner = mesh(elfEarGeo(0.12, 0.035), toon(0xf4b8b0, { outline: false }))
    earInner.position.set(0.015, 0, 0.012)
    ep.add(earInner)
    const earring = mesh(new THREE.OctahedronGeometry(0.012), gemMat, false)
    earring.position.set(0.01, -0.04, 0.01)
    ep.add(earring)
  }
  const noseM = mesh(new THREE.SphereGeometry(0.012, 6, 5), skin)
  noseM.position.set(0, -0.025, 0.122)
  noseM.scale.set(0.8, 1, 1)
  head.add(noseM)
  const mouthG = pivot(0, -0.062, 0.108, head)
  for (const y of [0.004, -0.005]) {
    const lip = mesh(new THREE.SphereGeometry(0.016, 8, 6), toon(C.lips, { outline: false }))
    lip.scale.set(1.5, 0.45, 0.45)
    lip.position.y = y
    mouthG.add(lip)
  }

  // 頭髮
  const hairRoot = pivot(0, 0, 0, head)
  const cap = mesh(new THREE.SphereGeometry(0.138, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), hairA)
  cap.position.set(0, 0.012, -0.012)
  cap.rotation.x = -0.35
  cap.scale.set(1.04, 1, 1.05)
  hairRoot.add(cap)
  const backCap = mesh(new THREE.SphereGeometry(0.14, 16, 10), hairA)
  backCap.position.set(0, -0.01, -0.035)
  backCap.scale.set(1.03, 1.02, 0.92)
  hairRoot.add(backCap)
  // 瀏海
  for (let k = 0; k < 6; k++) {
    const side = k < 3 ? -1 : 1
    const kk = k % 3
    const lp = pivot(side * (0.02 + kk * 0.035), 0.11 - kk * 0.012, 0.085 - kk * 0.012, hairRoot)
    lp.rotation.set(-0.5, 0, side * (0.12 + kk * 0.22))
    lp.add(mesh(lockGeo(0.11 + kk * 0.025, 0.038, -0.05, 0.008), kk % 2 ? lockB : lockA))
  }
  // 臉側髮束
  const sideLocks: THREE.Group[] = []
  for (const s of [-1, 1]) {
    const lp = pivot(0.105 * s, 0.03, 0.035, hairRoot)
    lp.add(mesh(lockGeo(0.55, 0.04, -0.04, 0.02), lockA))
    lp.rotation.z = 0.08 * s
    sideLocks.push(lp)
  }
  // 背後長髮（每束都有彈簧擺動）
  const backLocks: { g: THREE.Group; base: number; vel: number; ang: number; side: number }[] = []
  for (let k = 0; k < 9; k++) {
    const a = ((k - 4) / 4) * 1.15
    const lp = pivot(Math.sin(a) * 0.11, 0.02 - Math.abs(k - 4) * 0.008, -0.05 - Math.cos(a) * 0.07, hairRoot)
    const len = 0.78 - Math.abs(k - 4) * 0.045
    lp.add(mesh(lockGeo(len, 0.065, 0.12 + srand() * 0.05, 0.03), k % 2 ? lockB : lockA))
    lp.rotation.set(0.12, a * 0.3, Math.sin(a) * 0.12)
    backLocks.push({ g: lp, base: 0.12 + Math.abs(k - 4) * 0.02, vel: 0, ang: 0, side: Math.sin(a) })
  }
  // 頭冠與花
  const tiaraCurve = new THREE.CatmullRomCurve3(
    Array.from({ length: 9 }, (_, i) => {
      const a = (-0.5 + i / 8) * Math.PI * 0.95
      return new THREE.Vector3(Math.sin(a) * 0.142, 0.075 + Math.cos(a) * 0.02, Math.cos(a) * 0.135 - 0.01)
    }),
  )
  hairRoot.add(mesh(new THREE.TubeGeometry(tiaraCurve, 30, 0.007, 4, false), gold, false))
  for (let i = 0; i < 7; i++) {
    const a = (-0.5 + i / 6) * Math.PI * 0.9
    const leaf = mesh(new THREE.ConeGeometry(0.012, 0.045 - Math.abs(i - 3) * 0.006, 4), gold, false)
    leaf.position.set(Math.sin(a) * 0.145, 0.1 + Math.cos(a) * 0.02, Math.cos(a) * 0.138 - 0.01)
    leaf.rotation.set(-0.4 * Math.cos(a), 0, -a * 0.4)
    hairRoot.add(leaf)
  }
  const crown = mesh(new THREE.OctahedronGeometry(0.018), gemMat)
  crown.position.set(0, 0.105, 0.135)
  crown.scale.y = 1.5
  hairRoot.add(crown)
  for (const [x, y, z, sc] of [
    [0.12, 0.06, 0.02, 1.3],
    [0.135, 0.0, -0.04, 1.0],
    [0.1, 0.1, -0.03, 0.9],
    [-0.13, 0.05, 0.0, 1.1],
  ]) {
    const f = flower(sc)
    f.position.set(x, y, z)
    f.rotation.set(0, 0, Math.sign(x) * -1.2)
    hairRoot.add(f)
  }

  // 豎琴（彈奏技能時出現）
  const harp = new THREE.Group()
  harp.visible = false
  chest.add(harp)
  harp.position.set(-0.12, -0.05, 0.28)
  harp.rotation.set(0, 0.6, 0.12)
  const neckCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.55, 0),
    new THREE.Vector3(0.12, 0.6, 0),
    new THREE.Vector3(0.22, 0.5, 0),
    new THREE.Vector3(0.3, 0.42, 0),
    new THREE.Vector3(0.36, 0.48, 0),
  ])
  harp.add(mesh(new THREE.TubeGeometry(neckCurve, 24, 0.022, 6, false), gold))
  const pillarCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.55, 0),
    new THREE.Vector3(-0.03, 0.3, 0),
    new THREE.Vector3(0.0, 0.05, 0),
    new THREE.Vector3(0.05, -0.12, 0),
  ])
  harp.add(mesh(new THREE.TubeGeometry(pillarCurve, 20, 0.026, 6, false), gold))
  const boxCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.05, -0.12, 0),
    new THREE.Vector3(0.22, 0.1, 0),
    new THREE.Vector3(0.36, 0.42, 0),
  ])
  harp.add(mesh(new THREE.TubeGeometry(boxCurve, 20, 0.04, 6, false), toon(0xb08840)))
  const stringMat = new THREE.MeshBasicMaterial({ color: 0xfff6c8 })
  stringMat.userData.outlineParameters = { visible: false }
  const strings: THREE.Mesh[] = []
  for (let i = 1; i < 9; i++) {
    const tt = i / 9
    const top = neckCurve.getPoint(tt)
    const bot = boxCurve.getPoint(tt)
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, top.distanceTo(bot), 3), stringMat)
    st.position.copy(top).add(bot).multiplyScalar(0.5)
    st.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(bot).normalize())
    harp.add(st)
    strings.push(st)
  }
  for (let i = 0; i < 4; i++) {
    const f = flower(0.9)
    f.position.copy(pillarCurve.getPoint(0.15 + i * 0.22)).add(new THREE.Vector3(0.02, 0, 0.02))
    f.rotation.x = Math.PI / 2
    harp.add(f)
  }

  let phase = 0
  let t = 0
  let castT = 0
  let blinkT = 2
  let blink = 0
  let prevM = 0

  return {
    root,
    setHarp(on) {
      harp.visible = on
    },
    animate(dt, m, pose) {
      t += dt
      phase += dt * (4 + 7 * Math.min(m, 1.3))
      const still = pose === 'play' || pose === 'pack' || pose === 'stunned'
      const run = still ? 0 : m
      const sw = Math.sin(phase)
      const acc = (m - prevM) / Math.max(dt, 1e-3)
      prevM = m

      body.position.y = Math.abs(sw) * 0.035 * run + Math.sin(t * 2) * 0.004
      body.rotation.y = sw * 0.06 * run
      body.rotation.x = 0.04 * run
      skirt.rotation.z = sw * 0.05 * run
      skirt.rotation.x = 0.08 * run + Math.sin(t * 1.3) * 0.01
      skirt.scale.set(1 + run * 0.04, 1, 1 + run * 0.06)
      feet[0].position.z = 0.05 + sw * 0.17 * run
      feet[1].position.z = 0.05 - sw * 0.17 * run
      chest.rotation.y = -sw * 0.08 * run
      chest.scale.set(1, 1 + Math.sin(t * 2) * 0.012, 1)

      // 頭髮彈簧
      for (const L of backLocks) {
        const target = L.base + run * 0.45 + Math.sin(t * 1.5 + L.side * 2) * 0.03
        L.vel += ((target - L.ang) * 40 - L.vel * 6 - acc * 0.04) * dt
        L.ang += L.vel * dt
        L.g.rotation.x = L.ang
        L.g.rotation.z = L.side * 0.12 + Math.sin(phase * 0.5) * 0.04 * run
      }
      sideLocks.forEach((l, i) => (l.rotation.x = 0.05 + run * 0.15 + Math.sin(t * 2 + i) * 0.02))

      // 姿勢（arms[0] 在左側，rotation.z 為正時往身體內側收）
      const [L, R] = arms
      L.hand.rotation.set(0, 0, 0)
      R.hand.rotation.set(0, 0, 0)
      if (pose === 'play') {
        L.sh.rotation.set(-0.9, 0.2, 0.35)
        L.elbow.rotation.x = -1.1
        R.sh.rotation.set(-0.95 + Math.sin(t * 9) * 0.08, -0.3, -0.45)
        R.elbow.rotation.x = -1.0 + Math.cos(t * 9) * 0.15
        R.hand.rotation.z = Math.sin(t * 18) * 0.3
        head.rotation.set(0.2, -0.25, Math.sin(t * 2) * 0.08)
        strings.forEach((s, i) => (s.scale.x = 1 + Math.abs(Math.sin(t * 30 + i)) * 0.8))
      } else if (pose === 'cast') {
        // 凝視：雙手在臉前比愛心
        castT += dt
        L.sh.rotation.set(-1.25, 0, 0.55)
        R.sh.rotation.set(-1.25, 0, -0.55)
        L.elbow.rotation.x = R.elbow.rotation.x = -1.85
        L.hand.rotation.z = -0.5
        R.hand.rotation.z = 0.5
        head.rotation.set(-0.05, 0, 0.12)
      } else if (pose === 'attack') {
        castT += dt
        R.sh.rotation.set(-1.55, 0, -0.1)
        R.elbow.rotation.x = -0.1
        R.hand.rotation.x = -1.2
        L.sh.rotation.set(0.5, 0, -0.3)
        L.elbow.rotation.x = -0.4
        head.rotation.set(0.15, 0.1, 0)
        body.rotation.y = -0.25
      } else if (pose === 'pack') {
        castT += dt
        const k = Math.sin(castT * 12)
        L.sh.rotation.set(-1.1 + k * 0.3, 0, 0.25)
        R.sh.rotation.set(-1.1 - k * 0.3, 0, -0.25)
        L.elbow.rotation.x = -0.9 - k * 0.2
        R.elbow.rotation.x = -0.9 + k * 0.2
        head.rotation.set(0.35, 0, 0)
        body.rotation.x = 0.18
      } else if (pose === 'stunned') {
        L.sh.rotation.set(-0.3, 0, -0.9)
        R.sh.rotation.set(-0.3, 0, 0.9)
        L.elbow.rotation.x = R.elbow.rotation.x = -0.5
        head.rotation.set(0.1, 0, Math.sin(t * 6) * 0.25)
      } else {
        castT = 0
        L.sh.rotation.set(-sw * 0.45 * run + 0.05, 0, -0.18 - run * 0.08)
        R.sh.rotation.set(sw * 0.45 * run + 0.05, 0, 0.18 + run * 0.08)
        L.elbow.rotation.x = R.elbow.rotation.x = -0.25 - run * 0.35
        L.hand.rotation.z = -0.15
        R.hand.rotation.z = 0.15
        head.rotation.set(-0.03 + Math.sin(t * 0.7) * 0.03, Math.sin(t * 0.4) * 0.12 * (1 - run), 0)
      }
      // 紗袖與緞帶
      for (const a of arms) a.sleeve.update(dt, 0.04 + run * 0.08, 0.05 + run * 0.35, 4)
      for (const s of sashes) s.update(dt, 0.04 + run * 0.1, 0.1 + run * 0.6, 4 + run * 3)
      sheer.update(dt, 0.03 + run * 0.06, 0.05 + run * 0.4, 3)

      // 眨眼與表情
      blinkT -= dt
      if (blinkT <= 0) {
        blink = 1
        blinkT = 2.5 + Math.random() * 3
      }
      blink = Math.max(0, blink - dt * 8)
      const closed = pose === 'play' ? 1.1 : pose === 'cast' ? -0.2 : pose === 'stunned' ? 0.9 : -0.9
      lids.forEach((l) => (l.rotation.x = closed + Math.sin(blink * Math.PI) * 2.0))
      mouthG.scale.set(1, pose === 'play' ? 1.6 + Math.sin(t * 3) * 0.3 : pose === 'stunned' ? 2 : 1, 1)
    },
  }
}
