import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import type { AnimFlags, CharacterModel, Pose } from '../models'
import { ElfAnimState } from './ElfAnimState'
import { disposeObject } from './dispose'
import { HARP_RIG, type ElfRig } from './rigs'
import { SPRINGS, SecondaryMotion } from './SecondaryMotion'
import { applyCelShading } from './celShading'
import { isTouchDevice } from '../../input/touch'
import { fetchModel } from './preload'
import { applyBlink, BlinkTimer } from './blink'

export type GltfLoad = (url: string) => Promise<Pick<GLTF, 'scene' | 'animations'>>

export interface ElfCharacterOptions {
  // 角色規格（預設豎琴精靈）；url / harpUrl 可再覆蓋其中的路徑
  rig?: ElfRig
  url?: string
  harpUrl?: string
  // 載入期間 / 載入失敗時顯示的程序化模型（現有的 createElf）
  fallback?: CharacterModel | null
  load?: GltfLoad
  lowEnd?: boolean
  autoLoad?: boolean
  // 高解析貼圖載入器（預設 THREE.TextureLoader）；傳 null 停用
  loadTexture?: ((url: string) => Promise<THREE.Texture>) | null
  // 眨眼（角色規格有量測眼睛位置時才有效，見 blink.ts）；目前只用在選角詳情頁
  blink?: boolean
}

export type ElfStatus = 'loading' | 'ready' | 'fallback' | 'disposed'

// 豎琴掛在 prop_harp 骨（左手）上的偏移；在 elf-preview.html 中調整
export const HARP_OFFSET = {
  position: new THREE.Vector3(-0.036, -0.059, -0.065),
  rotation: new THREE.Euler(0.138, 0.409, -0.054),
  scale: 0.95,
}

const LOD_FAR = 16
const LOD_NEAR = 13

// GLB 以 EXT_meshopt_compression 壓縮（約為未壓縮的 1/3），需要 MeshoptDecoder
export function createElfLoader() {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
}

// 預設載入：沿用選角畫面預先下載的位元組（見 preload.ts），再解析成這一局專用的場景
async function defaultLoad(url: string) {
  const data = await fetchModel(url)
  return createElfLoader().parseAsync(data, url.slice(0, url.lastIndexOf('/') + 1))
}

// 下載失敗時的重試次數與間隔（毫秒）：手機切到背景時下載會被中斷，回到前景再試
const RETRY_DELAYS = [1000, 3000]

function whenVisible() {
  if (typeof document === 'undefined' || !document.hidden) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const on = () => {
      if (document.hidden) return
      document.removeEventListener('visibilitychange', on)
      resolve()
    }
    document.addEventListener('visibilitychange', on)
  })
}

function defaultLoadTexture(url: string) {
  if (typeof document === 'undefined') return Promise.reject(new Error('no DOM'))
  return new THREE.TextureLoader().loadAsync(url)
}

export function isLowEndDevice() {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { deviceMemory?: number }
  return isTouchDevice() || (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4
}

// 精靈角色：載入綁骨 GLB，以 AnimationMixer 播放骨架動畫，疊加頭髮 / 裙擺 / 袖子的彈簧次級動畫，
// 並把豎琴道具掛在手骨上（紫晶精靈的小提琴 / 琴弓已內嵌在 GLB）。實作 CharacterModel，與遊戲端（Game / Elf）介面相容。
export class ElfCharacter implements CharacterModel {
  readonly root = new THREE.Group()
  status: ElfStatus = 'loading'
  readonly ready: Promise<void>
  readonly rig: ElfRig
  readonly anim: ElfAnimState
  mixer: THREE.AnimationMixer | null = null
  readonly actions = new Map<string, THREE.AnimationAction>()
  readonly springs = new SecondaryMotion()
  lodLevel = 0
  error: unknown = null
  readonly hiResLoaded = new Set<'map' | 'normalMap'>()

  private fallback: CharacterModel | null
  private model: THREE.Object3D | null = null
  private lods: THREE.Object3D[] = []
  private harp: THREE.Object3D | null = null
  private harpPivot = new THREE.Group()
  private harpOn = false
  private harpK = 0
  private active: THREE.AnimationAction | null = null
  private camera: THREE.Camera | null = null
  private forcedLod: number | null = null
  private readonly lowEnd: boolean
  // 以根節點的實際位移量測水平速度（玩家 / AI / 網路同步的速度都不同），讓步態播放速率對上地面
  private lastPos = new THREE.Vector3()
  private hasLast = false
  private groundSpeed = 0
  private readonly opts: ElfCharacterOptions
  // 隱身：1 = 正常、0~1 = 半透明（精靈玩家自己看）、0 = 完全看不見
  private opacity = 1
  private blinkU: { value: number } | null = null
  private blinkTimer: BlinkTimer | null = null
  // 停在目前動作的這一格（選角詳情頁：角色站定不晃動）；settled：頭髮 / 裙擺的彈簧已模擬到靜止
  private held = false
  private settled = false
  // holdProp 已套用的節點與原本的局部變換（解除 holdPose 時還原）
  private propShift: { node: THREE.Object3D; matrix: THREE.Matrix4 } | null = null

  constructor(opts: ElfCharacterOptions = {}) {
    this.opts = opts
    this.rig = opts.rig ?? HARP_RIG
    this.anim = new ElfAnimState(this.rig.anim)
    this.lowEnd = opts.lowEnd ?? isLowEndDevice()
    this.fallback = opts.fallback ?? null
    this.root.name = 'ElfCharacter'
    if (this.fallback) this.root.add(this.fallback.root)
    this.harpPivot.name = 'HarpPivot'
    this.harpPivot.position.copy(HARP_OFFSET.position)
    this.harpPivot.rotation.copy(HARP_OFFSET.rotation)
    this.harpPivot.scale.setScalar(0)
    this.harpPivot.visible = false
    this.ready = opts.autoLoad === false ? Promise.resolve() : this.load()
  }

  async load() {
    const load = this.opts.load ?? defaultLoad
    // 自訂的載入器（測試）只試一次；預設的網路下載失敗時重試
    const retries = this.opts.load ? [] : RETRY_DELAYS
    for (let attempt = 0; ; attempt++) {
      try {
        const propUrl = this.opts.harpUrl ?? this.rig.propUrl
        const [gltf, harp] = await Promise.all([
          load(this.opts.url ?? this.rig.url),
          propUrl ? load(propUrl).catch(() => null) : Promise.resolve(null),
        ])
        if (this.status === 'disposed') {
          disposeObject(gltf.scene)
          if (harp) disposeObject(harp.scene)
          return
        }
        this.install(gltf, harp)
        return
      } catch (e) {
        this.error = e
        if (this.status === 'disposed') return
        if (attempt < retries.length) {
          await new Promise((r) => setTimeout(r, retries[attempt]))
          await whenVisible()
          if ((this.status as ElfStatus) === 'disposed') return
          continue
        }
        this.status = 'fallback'
        console.warn('[ElfCharacter] GLB 載入失敗，改用程序化模型', e)
        return
      }
    }
  }

  private install(gltf: Pick<GLTF, 'scene' | 'animations'>, harp: Pick<GLTF, 'scene'> | null) {
    const scene = gltf.scene
    const rig = this.rig
    scene.name = 'ElfGLB'
    this.lods = rig.lod.map((n) => scene.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o)
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.castShadow = true
      m.receiveShadow = true
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        optimizeMaterial(mat as THREE.MeshStandardMaterial, rig.atlasMaterial)
        if (rig.cel && mat.name === rig.atlasMaterial && applyCelShading(mat as THREE.MeshStandardMaterial, rig.cel)) {
          // cel shading 的暗面已經提亮，自發光只留一點點，避免整體泛白
          ;(mat as THREE.MeshStandardMaterial).emissive.setHex(0x161412)
        }
        if (this.opts.blink && rig.blink && mat.name === rig.atlasMaterial) this.blinkU = applyBlink(mat as THREE.MeshStandardMaterial, rig.blink)
      }
    })
    if (this.blinkU) this.blinkTimer = new BlinkTimer()
    if ((rig.hiResMap || rig.hiResNormal) && !this.lowEnd) void this.loadHiRes(scene)

    // 動作
    this.mixer = new THREE.AnimationMixer(scene)
    for (const clip of gltf.animations) {
      const name = clip.name
      if (!rig.clips.includes(name)) continue
      // 次級動畫骨由程式驅動：移除動作中這些骨頭的軌道，避免 mixer 每幀蓋回 rest pose / 覆蓋彈簧結果
      clip.tracks = clip.tracks.filter((t) => !rig.stripTracks.test(t.name))
      const a = this.mixer.clipAction(clip)
      const spec = rig.anim.clips[name] ?? { loop: true, fade: 0.2 }
      a.setLoop(spec.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
      a.clampWhenFinished = !spec.loop
      this.actions.set(name, a)
    }
    this.active = this.actions.get('Idle') ?? null
    this.active?.play()

    // 次級動畫骨鏈與碰撞體
    const bone = (n: string) => scene.getObjectByName(n) as THREE.Bone | undefined
    for (const [kind, chains] of Object.entries(rig.springChains)) {
      const params = SPRINGS[kind as keyof typeof SPRINGS]
      if (!params) continue
      for (const chain of chains) {
        const bones = chain.map(bone).filter((b): b is THREE.Bone => !!b)
        if (bones.length) this.springs.addChain(bones, params)
      }
    }
    for (const c of rig.colliders) this.springs.addCollider(c, bone)

    // 豎琴
    const socket = rig.propSocket ? scene.getObjectByName(rig.propSocket) : undefined
    if (socket && harp) {
      this.harp = harp.scene
      this.harp.name = 'Harp'
      this.harp.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        m.castShadow = true
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) optimizeMaterial(mat as THREE.MeshStandardMaterial, rig.atlasMaterial)
      })
      this.harpPivot.add(this.harp)
      socket.add(this.harpPivot)
    }

    this.model = scene
    this.root.add(scene)
    if (this.fallback) {
      this.root.remove(this.fallback.root)
      // 程序化模型的材質來自 toon() 快取、與其他角色共用，只釋放幾何
      disposeObject(this.fallback.root, { materials: false })
      this.fallback = null
    }
    this.applyLod(this.lowEnd ? 1 : 0)
    this.status = 'ready'
    if (this.opacity < 1) this.applyOpacity()
  }

  // 高解析貼圖：模型先以 GLB 內的 2048² 貼圖顯示，載入完成後替換（各張獨立，失敗就維持原貼圖）
  private async loadHiRes(scene: THREE.Object3D) {
    const loader = this.opts.loadTexture === undefined ? defaultLoadTexture : this.opts.loadTexture
    if (!loader) return
    const mats = new Set<THREE.MeshStandardMaterial>()
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat.name === this.rig.atlasMaterial) mats.add(mat as THREE.MeshStandardMaterial)
    })
    const slots: ['map' | 'normalMap', string | undefined, THREE.ColorSpace][] = [
      ['map', this.rig.hiResMap, THREE.SRGBColorSpace],
      ['normalMap', this.rig.hiResNormal, THREE.NoColorSpace],
    ]
    await Promise.all(
      slots.map(async ([slot, url, colorSpace]) => {
        const old = [...mats][0]?.[slot]
        if (!url || !old) return
        let tex: THREE.Texture
        try {
          tex = await loader(url)
        } catch (e) {
          console.warn('[ElfCharacter] 高解析貼圖載入失敗，沿用 GLB 貼圖', url, e)
          return
        }
        if (this.status === 'disposed' || this.model !== scene) {
          tex.dispose()
          return
        }
        // 沿用 GLB 貼圖的取樣設定（glTF 貼圖不翻轉 Y）
        tex.flipY = old.flipY
        tex.wrapS = old.wrapS
        tex.wrapT = old.wrapT
        tex.channel = old.channel
        tex.colorSpace = colorSpace
        tex.anisotropy = slot === 'map' ? old.anisotropy : 4
        tex.needsUpdate = true
        for (const mat of mats) {
          if (mat[slot] === old) mat[slot] = tex
          if (slot === 'map' && mat.emissiveMap === old) mat.emissiveMap = tex
        }
        old.dispose()
        this.hiResLoaded.add(slot)
      }),
    )
  }

  // 隱身：0 = 看不見（哥布林視角）、0~1 = 半透明（精靈玩家自己看）、1 = 正常
  setOpacity(a: number) {
    if (a === this.opacity) return
    this.opacity = a
    this.applyOpacity()
  }

  get currentOpacity() {
    return this.opacity
  }

  private applyOpacity() {
    const a = this.opacity
    this.root.visible = a > 0
    // 程序化替身的材質與其他角色共用（toon 快取），只切換顯示
    const target = this.model
    if (!target || a <= 0) return
    const seen = new Set<THREE.Material>()
    target.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.castShadow = a >= 1
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (seen.has(mat)) continue
        seen.add(mat)
        const u = mat.userData
        if (u.ghostBase === undefined) u.ghostBase = { opacity: mat.opacity, transparent: mat.transparent, depthWrite: mat.depthWrite, outline: u.outlineParameters }
        const b = u.ghostBase as { opacity: number; transparent: boolean; depthWrite: boolean; outline: unknown }
        if (a >= 1) {
          mat.opacity = b.opacity
          mat.transparent = b.transparent
          mat.depthWrite = b.depthWrite
          u.outlineParameters = b.outline
        } else {
          // 半透明但仍寫入深度：只看得到最前面一層，像一道淡淡的殘影而不是看穿身體
          mat.opacity = b.opacity * a
          mat.transparent = true
          mat.depthWrite = b.depthWrite
          u.outlineParameters = { visible: false }
        }
        mat.needsUpdate = true
      }
    })
  }

  setCamera(camera: THREE.Camera | null) {
    this.camera = camera
  }

  // null = 依距離 / 裝置自動
  forceLod(level: number | null) {
    this.forcedLod = level
  }

  setHarp(on: boolean) {
    this.harpOn = on
    this.fallback?.setHarp?.(on)
  }

  setVictory(on: boolean) {
    this.anim.victory = on
  }

  // 停住動作（維持目前這一格的姿勢）；頭髮等次級動畫會自然靜止，眨眼照常
  holdPose(on: boolean) {
    this.held = on
    this.settled = false
    if (!on && this.propShift) {
      this.propShift.matrix.decompose(this.propShift.node.position, this.propShift.node.quaternion, this.propShift.node.scale)
      this.propShift = null
    }
  }

  // 站定展示：把道具的握把段對齊到手裡（rig.holdProp）。模型載入後、第一次停住姿勢時依當下姿勢計算一次：
  //  1. 手：取 LOD0 中手骨權重 > 0.6 的頂點（套用骨架後的世界座標），主成分 = 手的軸線（指尖 → 手腕）
  //  2. 握點：沿手軸的中段截面中心（手掌與手指厚度的正中間）
  //  3. 道具：握把段以最小旋轉轉到與手軸平行（頂端朝手腕），中點移到握點
  applyHoldProp() {
    const hp = this.rig.holdProp
    if (!hp || this.propShift || !this.model) return
    const node = this.model.getObjectByName(hp.node)
    const mesh = this.lods[0] ? findSkinned(this.lods[0]) : null
    if (!node || !node.parent || !mesh) return
    const hi = mesh.skeleton.bones.findIndex((b) => b.name === hp.hand)
    if (hi < 0) return
    this.root.updateMatrixWorld(true)
    const g = mesh.geometry
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < g.attributes.position.count; i++) {
      let w = 0
      for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === hi) w += sw.getComponent(i, k)
      if (w > 0.6) pts.push(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld))
    }
    if (pts.length < 20) return
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length)
    const axis = principalAxis(pts, c)
    // 手軸朝手腕（手骨原點）
    const wrist = mesh.skeleton.bones[hi].getWorldPosition(new THREE.Vector3())
    if (axis.dot(wrist.clone().sub(c)) < 0) axis.negate()
    const ts = pts.map((p) => p.clone().sub(c).dot(axis))
    const tMin = Math.min(...ts), tMax = Math.max(...ts)
    const mid = pts.filter((_, i) => ts[i] > tMin + (tMax - tMin) * 0.25 && ts[i] < tMin + (tMax - tMin) * 0.75)
    const grip = mid.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(mid.length)
    // 截面中心：去掉沿手軸的分量，放回手軸的中點
    grip.sub(axis.clone().multiplyScalar(grip.clone().sub(c).dot(axis))).add(axis.clone().multiplyScalar((tMin + tMax) / 2))

    node.updateMatrixWorld(true)
    const a = new THREE.Vector3(...hp.grip[0]).applyMatrix4(node.matrixWorld)
    const b = new THREE.Vector3(...hp.grip[1]).applyMatrix4(node.matrixWorld)
    const neckMid = a.clone().add(b).multiplyScalar(0.5)
    const q = new THREE.Quaternion().setFromUnitVectors(b.clone().sub(a).normalize(), axis)
    const world = new THREE.Matrix4()
      .makeTranslation(grip.x, grip.y, grip.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
      .multiply(new THREE.Matrix4().makeTranslation(-neckMid.x, -neckMid.y, -neckMid.z))
      .multiply(node.matrixWorld)
    const local = new THREE.Matrix4().copy(node.parent.matrixWorld).invert().multiply(world)
    this.propShift = { node, matrix: node.matrix.clone() }
    local.decompose(node.position, node.quaternion, node.scale)
    node.updateMatrixWorld(true)
  }

  get harpVisible() {
    return this.harpPivot.visible
  }

  animate(dt: number, moveSpeed01: number, pose: Pose, flags?: AnimFlags) {
    if (this.status === 'disposed') return
    if (!this.mixer) {
      this.fallback?.animate(dt, moveSpeed01, pose, flags)
      return
    }
    const p = this.root.position
    if (this.hasLast && dt > 0) {
      const v = Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z) / dt
      if (v < 30) this.groundSpeed += (v - this.groundSpeed) * Math.min(1, dt * 10) // 瞬移不算
    }
    this.lastPos.copy(p)
    this.hasLast = true
    // 原地動作（moveSpeed01 ≈ 0）不採用量測值；有移動量但位置沒變（預覽頁滑桿）時以移動量推估
    const speed = moveSpeed01 > 0.05 && this.groundSpeed > 0.2 ? this.groundSpeed : undefined
    const d = this.anim.update(pose, moveSpeed01, speed)
    const next = this.actions.get(d.clip)
    if (next && (d.changed || d.restart || next !== this.active)) {
      next.reset()
      next.setEffectiveWeight(1)
      next.play()
      if (this.active && this.active !== next) next.crossFadeFrom(this.active, d.fade, false)
      this.active = next
    }
    if (this.active) this.active.timeScale = this.held ? 0 : d.timeScale
    this.mixer.update(dt)
    if (this.blinkU && this.blinkTimer) this.blinkU.value = this.blinkTimer.update(dt)
    this.root.updateMatrixWorld(true)
    if (!this.held) this.springs.update(dt, this.root)
    else if (!this.settled) {
      this.applyHoldProp()
      // 姿勢停住後，彈簧仍會慢慢下垂、擺盪好幾秒（看起來像在抖）：一次模擬 4 秒讓它停下來，之後就不再更新
      for (let i = 0; i < 240; i++) this.springs.update(1 / 60, this.root)
      this.settled = true
    }

    // 豎琴：彈奏時從手上長出來（縮放）
    const target = this.harpOn || pose === 'play' ? 1 : 0
    this.harpK += (target - this.harpK) * Math.min(1, dt * 10)
    if (Math.abs(this.harpK - target) < 0.01) this.harpK = target
    this.harpPivot.visible = this.harpK > 0.01
    this.harpPivot.scale.setScalar(HARP_OFFSET.scale * easeOutBack(this.harpK))

    this.updateLod()
  }

  private updateLod() {
    if (this.lods.length < 2) return
    let level = this.forcedLod ?? (this.lowEnd ? 1 : this.lodLevel)
    if (this.forcedLod === null && !this.lowEnd && this.camera) {
      const d = this.camera.position.distanceTo(this.root.position)
      if (level === 0 && d > LOD_FAR) level = 1
      else if (level === 1 && d < LOD_NEAR) level = 0
    }
    if (level !== this.lodLevel) this.applyLod(level)
  }

  private applyLod(level: number) {
    this.lodLevel = Math.min(level, this.lods.length - 1)
    this.lods.forEach((o, i) => (o.visible = i === this.lodLevel))
  }

  dispose() {
    if (this.status === 'disposed') return
    this.status = 'disposed'
    if (this.mixer) {
      this.mixer.stopAllAction()
      if (this.model) this.mixer.uncacheRoot(this.model)
      this.mixer = null
    }
    this.actions.clear()
    if (this.model) disposeObject(this.model)
    if (this.harp) disposeObject(this.harp)
    if (this.fallback) disposeObject(this.fallback.root, { materials: false })
    this.root.clear()
    this.model = this.harp = this.fallback = null
  }
}

// 材質最佳化：sRGB 貼圖、各向異性、半透明紗只畫一次不寫深度、描邊參數
export function optimizeMaterial(mat: THREE.MeshStandardMaterial, atlas = 'M_Elf') {
  if (!mat || mat.userData.elfOptimized) return
  mat.userData.elfOptimized = true
  if (mat.map) {
    mat.map.colorSpace = THREE.SRGBColorSpace
    mat.map.anisotropy = 8 // 拉近 / 斜看時臉與布料花紋保持清晰（超過硬體上限時 three 會自動夾住）
  }
  const name = mat.name
  if (mat.transparent || name === 'M_Sheer') {
    mat.transparent = true
    mat.depthWrite = false
    mat.side = THREE.DoubleSide
    mat.opacity = Math.min(mat.opacity, 0.55)
    mat.userData.outlineParameters = { visible: false }
    return
  }
  if (/Hair|Leaf|Petal|String|Gem|Face|Bow/.test(name)) {
    mat.userData.outlineParameters = { visible: false }
  } else {
    mat.userData.outlineParameters = { thickness: 0.0022, color: [0.22, 0.15, 0.1], alpha: 1, visible: true }
  }
  if (name === atlas) {
    // Meshy 單張貼圖集（臉、頭髮、布料都在同一張）：以貼圖本身做微弱自發光，陰影中不發灰，維持插畫感
    mat.emissiveMap = mat.map
    mat.emissive = new THREE.Color(0x383430)
    mat.envMapIntensity = 0.8
    mat.side = THREE.DoubleSide // 裙擺 / 袖子是單層布片，背面也要畫
    mat.userData.outlineParameters = { thickness: 0.0016, color: [0.22, 0.15, 0.1], alpha: 1, visible: true }
    return
  }
  if (name === 'M_Hair' || name === 'M_Face' || name === 'M_Skin') {
    // 臉與頭髮用微弱自發光避免在陰影中發灰，維持插畫感
    mat.emissive = new THREE.Color(name === 'M_Hair' ? 0x2a1e08 : 0x2a1810)
  }
}

function findSkinned(o: THREE.Object3D) {
  let m: THREE.SkinnedMesh | null = null
  o.traverse((x) => {
    if (!m && (x as THREE.SkinnedMesh).isSkinnedMesh) m = x as THREE.SkinnedMesh
  })
  return m as THREE.SkinnedMesh | null
}

// 點雲的主軸（共變異矩陣最大特徵向量，冪次迭代）
function principalAxis(pts: THREE.Vector3[], c: THREE.Vector3) {
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  for (const p of pts) {
    const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z
  }
  const v = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < 32; i++) {
    v.set(xx * v.x + xy * v.y + xz * v.z, xy * v.x + yy * v.y + yz * v.z, xz * v.x + yz * v.y + zz * v.z).normalize()
  }
  return v
}

function easeOutBack(k: number) {
  const c1 = 1.70158, c3 = c1 + 1
  return k <= 0 ? 0 : k >= 1 ? 1 : 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2)
}
