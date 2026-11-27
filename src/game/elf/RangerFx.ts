import * as THREE from 'three'
import { groundAt } from '../ground'
import { CELL, glowSprite } from '../fx/atlas'
import type { ParticleSpec } from '../fx/Particles'
import { noOutline, toon } from '../toon'
import type { Trap, TrapChain } from '../ranger'
import type { ElfMagicFx, ParticleSink } from './ElfMagicFx'

const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]
// 遊俠的配色：嫩葉綠、象牙白、金
const LEAF = [0x9be36a, 0xc8f5a0, 0x6fcf5a, 0xe8ffc8]
const LIGHT = [0xd8ffb0, 0xfff6c8, 0xb6ff8a]
const VINE = 0x3f8a3a
const ARROW_Y = 1.3
const ROPE_SEG = 20
// 笛子吹口相對角色的位置（往前、離地高度）：音符、箭矢、繩索從這裡出來
const FLUTE = { fwd: 0.32, y: 1.47 }
const v1 = new THREE.Vector3()

interface TrapView {
  group: THREE.Group
  glow: THREE.Sprite
  age: number
  show: number
}

// 藤蔓連鎖：連線是一條貼地的藤蔓（兩股交纏），面是一片淡綠色的光
interface LinkView {
  group: THREE.Group
  show: number
}
interface FaceView {
  mesh: THREE.Mesh
  show: number
}

interface ArrowView {
  group: THREE.Group
  o: THREE.Vector3
  dir: THREE.Vector3
  len: number
  speed: number
  done: number
}

// 遊俠精靈的技能特效：笛聲的綠色音符與葉片、地上的藤蔓陷阱、吹笛召喚的光箭、收網的藤蔓繩索。
// 粒子沿用 FxSystem 的環形緩衝；魔法陣借用 ElfMagicFx 的物件池；陷阱與箭矢是少量的常駐網格
export class RangerFx {
  private scene: THREE.Scene
  private glow: ParticleSink
  private soft: ParticleSink
  private rings: ElfMagicFx
  private spec: ParticleSpec = { x: 0, y: 0, z: 0 }
  private traps = new Map<number, TrapView>()
  private arrows = new Map<number, ArrowView>()
  private links = new Map<string, LinkView>()
  private faces = new Map<string, FaceView>()
  private acc = { amb: 0, draw: 0, rope: 0 }
  private t = 0
  // 網格資源（陷阱、箭矢、繩索）第一次用到才建立：three 建立物件時會以 Math.random 產生 UUID，
  // 其他精靈的對局不該因為這個類別而多消耗亂數（對局模擬以固定種子比對）
  private res: ReturnType<RangerFx['build']> | null = null

  constructor(scene: THREE.Scene, particles: { glow: ParticleSink; soft: ParticleSink }, rings: ElfMagicFx) {
    this.scene = scene
    this.glow = particles.glow
    this.soft = particles.soft
    this.rings = rings
  }

  private get r() {
    return (this.res ??= this.build())
  }

  private build() {
    const geo = {
      vine: new THREE.TorusGeometry(0.72, 0.06, 6, 22),
      vine2: new THREE.TorusGeometry(0.5, 0.045, 5, 18),
      thorn: new THREE.ConeGeometry(0.055, 0.24, 5),
      leaf: new THREE.SphereGeometry(0.11, 6, 4),
      petal: new THREE.SphereGeometry(0.07, 6, 4),
      shaft: new THREE.CylinderGeometry(0.022, 0.022, 0.9, 6),
      head: new THREE.ConeGeometry(0.07, 0.24, 6),
      lasso: new THREE.TorusGeometry(0.75, 0.035, 5, 24),
      // 連線用的單位長度藤蔓（沿 +Z，長 1，之後依兩個陷阱的距離縮放）
      strand: new THREE.CylinderGeometry(0.045, 0.045, 1, 5).rotateX(Math.PI / 2).translate(0, 0, 0.5),
    }
    const mat = {
      vine: toon(VINE),
      leaf: toon(0x6fcf5a),
      petal: toon(0xfffbe8),
      light: noOutline(new THREE.MeshBasicMaterial({ color: 0xe8ffc0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })),
      rope: noOutline(new THREE.MeshBasicMaterial({ color: 0xc8ff9a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })),
      face: noOutline(new THREE.MeshBasicMaterial({ color: 0x9be36a, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })),
    }
    // 繩索：水平與垂直兩條帶子交叉，任何角度都看得到
    const ropeGeo = new THREE.BufferGeometry()
    const ropePos = new Float32Array((ROPE_SEG + 1) * 4 * 3)
    const idx: number[] = []
    for (let s = 0; s < 2; s++)
      for (let i = 0; i < ROPE_SEG; i++) {
        const a = (s * (ROPE_SEG + 1) + i) * 2
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    ropeGeo.setAttribute('position', new THREE.BufferAttribute(ropePos, 3))
    ropeGeo.setIndex(idx)
    const ropeMesh = new THREE.Mesh(ropeGeo, mat.rope)
    ropeMesh.frustumCulled = false
    ropeMesh.renderOrder = 6
    ropeMesh.visible = false
    const lasso = new THREE.Mesh(geo.lasso, mat.light)
    lasso.rotation.x = Math.PI / 2
    lasso.visible = false
    this.scene.add(ropeMesh, lasso)
    return { geo, mat, ropeGeo, ropePos, ropeMesh, lasso }
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

  private leaves(x: number, y: number, z: number, n: number, speed: number, up = 1) {
    for (let i = 0; i < n; i++)
      this.emit(this.soft, (s) => {
        const a = Math.random() * Math.PI * 2
        const sp = rnd(0.4, 1) * speed
        s.x = x + Math.cos(a) * 0.15
        s.y = y + rnd(-0.1, 0.2)
        s.z = z + Math.sin(a) * 0.15
        s.vx = Math.cos(a) * sp
        s.vy = rnd(0.3, 1.2) * up
        s.vz = Math.sin(a) * sp
        s.color = pick(LEAF)
        s.size = rnd(0.16, 0.28)
        s.life = rnd(0.7, 1.3)
        s.cell = CELL.leaf
        s.spin = rnd(-5, 5)
        s.gravity = 1.4
        s.drag = 1.6
        s.wobble = 0.5
      })
  }

  private notes(x: number, y: number, z: number, n: number, dx = 0, dz = 0) {
    for (let i = 0; i < n; i++)
      this.emit(this.glow, (s) => {
        s.x = x + rnd(-0.12, 0.12)
        s.y = y + rnd(-0.08, 0.15)
        s.z = z + rnd(-0.12, 0.12)
        s.vx = dx * rnd(0.6, 1.6) + rnd(-0.3, 0.3)
        s.vy = rnd(0.4, 1.1)
        s.vz = dz * rnd(0.6, 1.6) + rnd(-0.3, 0.3)
        s.color = pick(LIGHT)
        s.color2 = 0xffffff
        s.size = rnd(0.2, 0.3)
        s.life = rnd(0.9, 1.4)
        s.cell = Math.random() < 0.5 ? CELL.note : CELL.notes
        s.wobble = 0.6
        s.drag = 0.8
        s.fadeIn = 0.1
      })
  }

  private sparks(x: number, y: number, z: number, n: number, speed: number) {
    for (let i = 0; i < n; i++)
      this.emit(this.glow, (s) => {
        const a = Math.random() * Math.PI * 2
        const sp = rnd(0.4, 1) * speed
        s.x = x
        s.y = y
        s.z = z
        s.vx = Math.cos(a) * sp
        s.vy = rnd(-0.3, 1) * speed * 0.6
        s.vz = Math.sin(a) * sp
        s.color = pick(LIGHT)
        s.color2 = 0x9be36a
        s.size = rnd(0.1, 0.22)
        s.life = rnd(0.4, 0.9)
        s.cell = Math.random() < 0.5 ? CELL.sparkle : CELL.star
        s.spin = rnd(-6, 6)
        s.drag = 2
      })
  }

  // 模型載入後由遊戲提供笛子喇叭口的實際位置（世界座標）；沒有時以角色位置推估
  tip: ((out: THREE.Vector3) => boolean) | null = null

  // 笛子喇叭口的位置（遊戲邏輯座標，y 以地面為 0）
  private flute(pos: THREE.Vector3, yaw: number, out = v1) {
    if (this.tip?.(out)) {
      out.y -= groundAt(out.x, out.z)
      return out
    }
    return out.set(pos.x + Math.sin(yaw) * FLUTE.fwd, FLUTE.y, pos.z + Math.cos(yaw) * FLUTE.fwd)
  }

  // ── 常駐 ──
  // 腳邊偶爾飄起的葉片與光點
  ambient(dt: number, pos: THREE.Vector3, move: number) {
    this.acc.amb += dt * (1.2 + move * 5)
    while (this.acc.amb >= 1) {
      this.acc.amb -= 1
      this.leaves(pos.x + rnd(-0.4, 0.4), 0.2, pos.z + rnd(-0.4, 0.4), 1, 0.5, 0.8)
    }
  }

  // ── 藤蔓陷阱 ──
  // 開始吹笛：音符往面前的地上飄
  plantStart(pos: THREE.Vector3, yaw: number) {
    const f = this.flute(pos, yaw)
    this.notes(f.x, f.y, f.z, 3, Math.sin(yaw), Math.cos(yaw))
    this.rings.magicRing(v1.set(pos.x + Math.sin(yaw) * 1.3, 0, pos.z + Math.cos(yaw) * 1.3), 1.1, 0x9be36a, 0.7)
  }

  trapSprout(p: THREE.Vector3) {
    this.leaves(p.x, 0.15, p.z, 10, 1.6)
    this.sparks(p.x, 0.3, p.z, 8, 1.4)
  }

  // 陷阱枯萎消失（時間到、被拆掉）
  trapWither(p: THREE.Vector3) {
    this.leaves(p.x, 0.2, p.z, 8, 1.2, 0.6)
    for (let i = 0; i < 5; i++)
      this.emit(this.soft, (s) => {
        s.x = p.x + rnd(-0.4, 0.4)
        s.y = 0.2
        s.z = p.z + rnd(-0.4, 0.4)
        s.vy = rnd(0.3, 0.8)
        s.color = 0xb8c890
        s.size = rnd(0.4, 0.6)
        s.grow = 2
        s.life = rnd(0.5, 0.8)
        s.cell = CELL.smoke
        s.alpha = 0.45
        s.drag = 2
      })
  }

  private buildTrap(): TrapView {
    const { geo, mat } = this.r
    const group = new THREE.Group()
    const ring = new THREE.Mesh(geo.vine, mat.vine)
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.07
    const inner = new THREE.Mesh(geo.vine2, mat.vine)
    inner.rotation.set(Math.PI / 2, 0, 0.6)
    inner.position.y = 0.1
    group.add(ring, inner)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const th = new THREE.Mesh(geo.thorn, mat.vine)
      th.position.set(Math.cos(a) * 0.72, 0.16, Math.sin(a) * 0.72)
      th.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5)
      group.add(th)
      if (i % 2 === 0) {
        const lf = new THREE.Mesh(geo.leaf, mat.leaf)
        lf.scale.set(1.3, 0.3, 0.7)
        lf.position.set(Math.cos(a + 0.4) * 0.6, 0.14, Math.sin(a + 0.4) * 0.6)
        lf.rotation.y = -a
        group.add(lf)
      } else if (i % 4 === 1) {
        const fl = new THREE.Mesh(geo.petal, mat.petal)
        fl.scale.set(1.2, 0.5, 1.2)
        fl.position.set(Math.cos(a + 0.3) * 0.5, 0.16, Math.sin(a + 0.3) * 0.5)
        group.add(fl)
      }
    }
    group.traverse((o) => {
      o.castShadow = false
    })
    const glow = glowSprite(0x9be36a, 1.6, 0.5)
    glow.position.y = 0.2
    group.add(glow)
    this.scene.add(group)
    return { group, glow, age: 0, show: 0 }
  }

  // 每幀：依陷阱清單建立 / 移除網格。viewer＝哥布林觀看者的位置（只看得到 radius 內的）；null＝精靈玩家（全部看得到）
  syncTraps(list: readonly Trap[], viewer: THREE.Vector3 | null, radius: number) {
    for (const [id, v] of this.traps) {
      if (list.some((t) => t.id === id)) continue
      this.scene.remove(v.group)
      ;(v.glow.material as THREE.Material).dispose()
      this.traps.delete(id)
    }
    for (const t of list) {
      let v = this.traps.get(t.id)
      if (!v) {
        v = this.buildTrap()
        this.traps.set(t.id, v)
        v.group.position.set(t.pos.x, groundAt(t.pos.x, t.pos.z), t.pos.z)
      }
      const seen = !viewer || Math.hypot(viewer.x - t.pos.x, viewer.z - t.pos.z) < radius
      v.show += ((seen ? 1 : 0) - v.show) * 0.25
      v.group.visible = v.show > 0.03
      const armed = t.arm <= 0
      // 還沒生效：小小的嫩芽；生效後長成完整的藤圈並微微發光
      const grow = armed ? 1 : 0.45
      const s = v.group.scale.x + (grow * v.show - v.group.scale.x) * 0.2
      v.group.scale.setScalar(Math.max(0.001, s))
      v.group.rotation.y = this.t * 0.25 + t.id
      ;(v.glow.material as THREE.SpriteMaterial).opacity = armed ? 0.3 + Math.sin(this.t * 4 + t.id) * 0.12 : 0.1
    }
  }

  // 每幀：依目前的連鎖建立 / 移除連線與面的網格。seen＝目前的觀看者看不看得到這條連鎖
  syncChains(chains: readonly TrapChain[], seen: (ch: TrapChain) => boolean) {
    const want = new Map<string, { a: Trap; b: Trap; vis: boolean }>()
    const wantF = new Map<string, { t: [Trap, Trap, Trap]; vis: boolean }>()
    for (const ch of chains) {
      const vis = seen(ch)
      for (const [a, b] of ch.links) want.set(`${a.id}-${b.id}`, { a, b, vis })
      for (const f of ch.faces) wantF.set(`${f[0].id}-${f[1].id}-${f[2].id}`, { t: f, vis })
    }
    for (const [k, v] of this.links)
      if (!want.has(k)) {
        this.scene.remove(v.group)
        this.links.delete(k)
      }
    for (const [k, v] of this.faces)
      if (!wantF.has(k)) {
        this.dropFace(v)
        this.faces.delete(k)
      }
    for (const [k, w] of want) {
      let v = this.links.get(k)
      if (!v) {
        v = this.buildLink(w.a.pos, w.b.pos)
        this.links.set(k, v)
      }
      v.show += ((w.vis ? 1 : 0) - v.show) * 0.25
      v.group.visible = v.show > 0.03
      v.group.scale.x = v.group.scale.y = Math.max(0.001, v.show)
    }
    for (const [k, w] of wantF) {
      let v = this.faces.get(k)
      if (!v) {
        v = this.buildFace(w.t)
        this.faces.set(k, v)
      }
      v.show += ((w.vis ? 1 : 0) - v.show) * 0.25
      v.mesh.visible = v.show > 0.03
      ;(v.mesh.material as THREE.MeshBasicMaterial).opacity = (0.14 + Math.sin(this.t * 3) * 0.05) * v.show
    }
  }

  private buildLink(a: THREE.Vector3, b: THREE.Vector3): LinkView {
    const { geo, mat } = this.r
    const ya = groundAt(a.x, a.z) + 0.08
    const yb = groundAt(b.x, b.z) + 0.08
    const len = Math.hypot(b.x - a.x, yb - ya, b.z - a.z)
    const group = new THREE.Group()
    group.position.set(a.x, ya, a.z)
    group.lookAt(b.x, yb, b.z)
    // 兩股藤蔓微微錯開，中間點綴幾片葉子
    for (const off of [-0.05, 0.05]) {
      const st = new THREE.Mesh(geo.strand, mat.vine)
      st.scale.set(1, 1, len)
      st.position.x = off
      group.add(st)
    }
    const n = Math.max(1, Math.floor(len / 1.4))
    for (let i = 1; i <= n; i++) {
      const lf = new THREE.Mesh(geo.leaf, mat.leaf)
      lf.scale.set(1.2, 0.3, 0.6)
      lf.position.set((i % 2 ? 1 : -1) * 0.1, 0.03, (i / (n + 1)) * len)
      lf.rotation.y = i % 2 ? 0.6 : -0.6
      group.add(lf)
    }
    group.traverse((o) => {
      o.castShadow = false
    })
    this.scene.add(group)
    return { group, show: 0 }
  }

  private dropFace(v: FaceView) {
    this.scene.remove(v.mesh)
    v.mesh.geometry.dispose()
    ;(v.mesh.material as THREE.Material).dispose()
  }

  private buildFace(t: [Trap, Trap, Trap]): FaceView {
    const pos = new Float32Array(9)
    t.forEach((tr, i) => {
      pos[i * 3] = tr.pos.x
      pos[i * 3 + 1] = groundAt(tr.pos.x, tr.pos.z) + 0.05
      pos[i * 3 + 2] = tr.pos.z
    })
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const mesh = new THREE.Mesh(g, this.r.mat.face.clone())
    mesh.renderOrder = 4
    mesh.frustumCulled = false
    this.scene.add(mesh)
    return { mesh, show: 0 }
  }

  // ── 受困 / 標記 ──
  // 藤蔓纏上哥布林的瞬間
  snareBurst(p: THREE.Vector3) {
    this.leaves(p.x, 0.5, p.z, 14, 2.2)
    this.sparks(p.x, 0.9, p.z, 10, 2)
    this.rings.magicRing(p, 1.3, 0x9be36a, 0.8)
  }

  // 受困中（依頻率呼叫）：藤葉繞著哥布林打轉
  snareLeaf(p: THREE.Vector3) {
    this.emit(this.soft, (s) => {
      const a = this.t * 5 + Math.random() * Math.PI * 2
      s.x = p.x + Math.cos(a) * 0.55
      s.y = rnd(0.15, 1.3)
      s.z = p.z + Math.sin(a) * 0.55
      s.vx = -Math.sin(a) * 1.8
      s.vz = Math.cos(a) * 1.8
      s.vy = rnd(0.1, 0.5)
      s.color = pick(LEAF)
      s.size = rnd(0.16, 0.24)
      s.life = rnd(0.4, 0.7)
      s.cell = CELL.leaf
      s.spin = rnd(-6, 6)
      s.drag = 1.2
    })
  }

  // 被標記（依頻率呼叫）：頭上一圈往下收的光點
  markMote(p: THREE.Vector3) {
    this.emit(this.glow, (s) => {
      const a = Math.random() * Math.PI * 2
      s.x = p.x + Math.cos(a) * 0.5
      s.y = 1.9 + rnd(0, 0.3)
      s.z = p.z + Math.sin(a) * 0.5
      s.vx = -Math.cos(a) * 0.9
      s.vz = -Math.sin(a) * 0.9
      s.vy = -0.5
      s.color = 0xd8ff9a
      s.color2 = 0xffffff
      s.size = rnd(0.12, 0.2)
      s.life = 0.5
      s.cell = CELL.sparkle
      s.spin = 4
    })
  }

  // ── 召喚箭矢 ──
  // 吹奏中（每幀）：k＝吹奏進度。音符從笛子飄出，光點往面前聚成箭
  drawTick(dt: number, pos: THREE.Vector3, yaw: number, k: number) {
    this.acc.draw += dt * (16 + k * 30)
    const sx = Math.sin(yaw), cz = Math.cos(yaw)
    const f = this.flute(pos, yaw)
    while (this.acc.draw >= 1) {
      this.acc.draw -= 1
      if (Math.random() < 0.3) this.notes(f.x, f.y, f.z, 1, sx, cz)
      this.emit(this.glow, (s) => {
        const a = Math.random() * Math.PI * 2
        const r = rnd(0.3, 0.7) * (1.2 - k)
        const tx = pos.x + sx * 0.9, tz = pos.z + cz * 0.9
        s.x = tx + Math.cos(a) * r * cz
        s.y = ARROW_Y + Math.sin(a) * r
        s.z = tz - Math.cos(a) * r * sx
        s.vx = (tx - s.x) * 5
        s.vy = (ARROW_Y - s.y) * 5
        s.vz = (tz - s.z) * 5
        s.color = pick(LIGHT)
        s.size = rnd(0.1, 0.18)
        s.life = 0.2
        s.cell = CELL.sparkle
      })
    }
  }

  arrowSpawn(id: number, o: THREE.Vector3, dir: THREE.Vector3, len: number, speed: number) {
    const { geo, mat } = this.r
    const group = new THREE.Group()
    const shaft = new THREE.Mesh(geo.shaft, mat.light)
    shaft.rotation.x = Math.PI / 2
    const head = new THREE.Mesh(geo.head, mat.light)
    head.rotation.x = Math.PI / 2
    head.position.z = 0.55
    const glow = glowSprite(0xb6ff8a, 1.1, 0.9)
    glow.position.z = 0.4
    group.add(shaft, head, glow)
    group.rotation.y = Math.atan2(dir.x, dir.z)
    this.scene.add(group)
    const a: ArrowView = { group, o: o.clone(), dir: dir.clone(), len, speed, done: 0.9 }
    this.arrows.set(id, a)
    this.placeArrow(a)
    this.sparks(o.x + dir.x * 0.9, ARROW_Y, o.z + dir.z * 0.9, 8, 2.2)
    this.notes(o.x + dir.x * 0.3, FLUTE.y, o.z + dir.z * 0.3, 2, dir.x, dir.z)
  }

  private placeArrow(a: ArrowView) {
    const x = a.o.x + a.dir.x * a.done, z = a.o.z + a.dir.z * a.done
    a.group.position.set(x, ARROW_Y + groundAt(x, z), z)
  }

  private dropArrow(id: number) {
    const a = this.arrows.get(id)
    if (!a) return
    this.scene.remove(a.group)
    a.group.traverse((o) => {
      const s = o as THREE.Sprite
      if (s.isSprite) s.material.dispose()
    })
    this.arrows.delete(id)
  }

  // 箭命中哥布林或飛到盡頭
  arrowEnd(id: number, p: THREE.Vector3, hit: boolean) {
    this.dropArrow(id)
    this.sparks(p.x, hit ? 1 : ARROW_Y, p.z, hit ? 14 : 6, hit ? 2.6 : 1.4)
    if (hit) this.leaves(p.x, 0.9, p.z, 6, 1.6)
  }

  // ── 後躍 ──
  leap(o: THREE.Vector3, dir: THREE.Vector3) {
    this.leaves(o.x, 0.2, o.z, 12, 2)
    for (let i = 0; i < 8; i++)
      this.emit(this.glow, (s) => {
        const k = i / 8
        s.x = o.x + dir.x * k * 2.5 + rnd(-0.2, 0.2)
        s.y = 0.5 + Math.sin(k * Math.PI) * 0.6
        s.z = o.z + dir.z * k * 2.5 + rnd(-0.2, 0.2)
        s.vx = dir.x * 2
        s.vz = dir.z * 2
        s.color = pick(LIGHT)
        s.size = rnd(0.14, 0.24)
        s.life = rnd(0.4, 0.7)
        s.cell = CELL.glow
        s.drag = 2
      })
  }

  // ── 收網 ──
  reelStart(from: THREE.Vector3, to: THREE.Vector3) {
    this.notes(from.x, FLUTE.y, from.z, 4, (to.x - from.x) * 0.1, (to.z - from.z) * 0.1)
    this.snareBurst(to)
  }

  // 收網中（每幀）：藤蔓繩索從笛子連到哥布林，k＝進度（越收越緊、套索越縮越小）
  rope(dt: number, pos: THREE.Vector3, yaw: number, to: THREE.Vector3, k: number) {
    const { ropePos: P, ropeGeo, ropeMesh, lasso } = this.r
    const f = this.flute(pos, yaw).clone()
    f.y += groundAt(pos.x, pos.z)
    const ty = 0.75 + groundAt(to.x, to.z)
    const dx = to.x - f.x, dz = to.z - f.z
    const len = Math.hypot(dx, dz) || 1
    const sx = -dz / len, sz = dx / len
    const sag = (1 - k) * Math.min(1.2, len * 0.12)
    const w = 0.045 + Math.sin(this.t * 14) * 0.012
    for (let i = 0; i <= ROPE_SEG; i++) {
      const u = i / ROPE_SEG
      const x = f.x + dx * u, z = f.z + dz * u
      // 笛聲讓繩索帶一點波動
      const wave = Math.sin(u * 14 - this.t * 12) * 0.05 * Math.sin(u * Math.PI)
      const y = f.y + (ty - f.y) * u - Math.sin(u * Math.PI) * sag + wave
      const h = i * 6
      P[h] = x + sx * w
      P[h + 1] = y
      P[h + 2] = z + sz * w
      P[h + 3] = x - sx * w
      P[h + 4] = y
      P[h + 5] = z - sz * w
      const q = (ROPE_SEG + 1) * 6 + i * 6
      P[q] = x
      P[q + 1] = y + w
      P[q + 2] = z
      P[q + 3] = x
      P[q + 4] = y - w
      P[q + 5] = z
    }
    ropeGeo.attributes.position.needsUpdate = true
    ropeMesh.visible = true
    lasso.visible = true
    lasso.position.set(to.x, ty, to.z)
    lasso.scale.setScalar(1 - k * 0.45 + Math.sin(this.t * 10) * 0.03)
    lasso.rotation.z = this.t * 2
    // 音符沿著繩索飄向哥布林
    this.acc.rope += dt * 9
    while (this.acc.rope >= 1) {
      this.acc.rope -= 1
      const u = Math.random()
      this.notes(f.x + dx * u, f.y - groundAt(f.x + dx * u, f.z + dz * u) + (ty - f.y) * u - Math.sin(u * Math.PI) * sag, f.z + dz * u, 1, (dx / len) * 1.5, (dz / len) * 1.5)
    }
  }

  ropeOff() {
    if (!this.res) return
    this.res.ropeMesh.visible = false
    this.res.lasso.visible = false
  }

  update(dt: number) {
    this.t += dt
    for (const [id, a] of this.arrows) {
      a.done += a.speed * dt
      // 房主的命中事件還沒到之前，最多飛到射程盡頭後再等一下
      if (a.done > a.len + a.speed * 0.25) {
        this.dropArrow(id)
        continue
      }
      a.done = Math.min(a.done, a.len)
      this.placeArrow(a)
      const p = a.group.position
      this.emit(this.glow, (s) => {
        s.x = p.x - a.dir.x * 0.4 + rnd(-0.05, 0.05)
        s.y = ARROW_Y + rnd(-0.05, 0.05)
        s.z = p.z - a.dir.z * 0.4 + rnd(-0.05, 0.05)
        s.color = pick(LIGHT)
        s.size = rnd(0.14, 0.24)
        s.life = rnd(0.25, 0.45)
        s.cell = Math.random() < 0.7 ? CELL.glow : CELL.leaf
        s.spin = 4
      })
    }
  }

  dispose() {
    for (const id of [...this.arrows.keys()]) this.dropArrow(id)
    for (const v of this.traps.values()) {
      this.scene.remove(v.group)
      ;(v.glow.material as THREE.Material).dispose()
    }
    this.traps.clear()
    for (const v of this.links.values()) this.scene.remove(v.group)
    this.links.clear()
    for (const v of this.faces.values()) this.dropFace(v)
    this.faces.clear()
    const r = this.res
    if (!r) return
    this.scene.remove(r.ropeMesh, r.lasso)
    r.ropeGeo.dispose()
    for (const g of Object.values(r.geo)) g.dispose()
    for (const m of Object.values(r.mat)) m.dispose()
    this.res = null
  }
}
