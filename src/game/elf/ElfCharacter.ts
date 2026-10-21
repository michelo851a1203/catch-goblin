import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import type { AnimFlags, CharacterModel, Pose } from '../models'
import { CLIP_SPECS, ElfAnimState } from './ElfAnimState'
import { ELF_ASSETS, ELF_CLIPS, ELF_NODES, ELF_SPRING_CHAINS, type ElfClip } from './assets'
import { disposeObject } from './dispose'
import { SPRINGS, SecondaryMotion } from './SecondaryMotion'

export type GltfLoad = (url: string) => Promise<Pick<GLTF, 'scene' | 'animations'>>

export interface ElfCharacterOptions {
  url?: string
  harpUrl?: string
  // 載入期間 / 載入失敗時顯示的程序化模型（現有的 createElf）
  fallback?: CharacterModel | null
  load?: GltfLoad
  lowEnd?: boolean
  autoLoad?: boolean
}

export type ElfStatus = 'loading' | 'ready' | 'fallback' | 'disposed'

// 豎琴掛在 prop_harp 骨（左手）上的偏移；在 elf-preview.html 中調整
export const HARP_OFFSET = {
  position: new THREE.Vector3(-0.005, 0.085, -0.032),
  rotation: new THREE.Euler(0.138, 0.409, -0.054),
  scale: 0.95,
}

const LOD_FAR = 16
const LOD_NEAR = 13

// GLB 以 EXT_meshopt_compression 壓縮（約為未壓縮的 1/3），需要 MeshoptDecoder
export function createElfLoader() {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
}

function defaultLoad(url: string) {
  return createElfLoader().loadAsync(url)
}

export function isLowEndDevice() {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { deviceMemory?: number }
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  return coarse || (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4
}

// 女精靈角色：載入綁骨 GLB，以 AnimationMixer 播放骨架動畫，疊加頭髮 / 裙擺 / 袖子的彈簧次級動畫，
// 並把豎琴道具掛在手骨上。實作 CharacterModel，與遊戲端（Game / Elf）介面相容。
export class ElfCharacter implements CharacterModel {
  readonly root = new THREE.Group()
  status: ElfStatus = 'loading'
  readonly ready: Promise<void>
  readonly anim = new ElfAnimState()
  mixer: THREE.AnimationMixer | null = null
  readonly actions = new Map<ElfClip, THREE.AnimationAction>()
  readonly springs = new SecondaryMotion()
  lodLevel = 0
  error: unknown = null

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
  private readonly opts: ElfCharacterOptions

  constructor(opts: ElfCharacterOptions = {}) {
    this.opts = opts
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
    try {
      const [gltf, harp] = await Promise.all([
        load(this.opts.url ?? ELF_ASSETS.character),
        load(this.opts.harpUrl ?? ELF_ASSETS.harp).catch(() => null),
      ])
      if (this.status === 'disposed') {
        disposeObject(gltf.scene)
        if (harp) disposeObject(harp.scene)
        return
      }
      this.install(gltf, harp)
    } catch (e) {
      this.error = e
      if (this.status !== 'disposed') this.status = 'fallback'
      console.warn('[ElfCharacter] GLB 載入失敗，改用程序化模型', e)
    }
  }

  private install(gltf: Pick<GLTF, 'scene' | 'animations'>, harp: Pick<GLTF, 'scene'> | null) {
    const scene = gltf.scene
    scene.name = 'ElfGLB'
    this.lods = ELF_NODES.lod.map((n) => scene.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o)
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.castShadow = true
      m.receiveShadow = true
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) optimizeMaterial(mat as THREE.MeshStandardMaterial)
    })

    // 動作
    this.mixer = new THREE.AnimationMixer(scene)
    for (const clip of gltf.animations) {
      const name = clip.name as ElfClip
      if (!ELF_CLIPS.includes(name)) continue
      // 次級動畫骨由程式驅動：移除動作中這些骨頭的軌道，避免 mixer 每幀蓋回 rest pose
      clip.tracks = clip.tracks.filter((t) => !/^(hair_|skirt_|sleeve|prop_)/.test(t.name))
      const a = this.mixer.clipAction(clip)
      const spec = CLIP_SPECS[name]
      a.setLoop(spec.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
      a.clampWhenFinished = !spec.loop
      this.actions.set(name, a)
    }
    this.active = this.actions.get('Idle') ?? null
    this.active?.play()

    // 次級動畫骨鏈
    const bone = (n: string) => scene.getObjectByName(n) as THREE.Bone | undefined
    for (const [kind, chains] of Object.entries(ELF_SPRING_CHAINS) as [keyof typeof ELF_SPRING_CHAINS, readonly (readonly string[])[]][]) {
      for (const chain of chains) {
        const bones = chain.map(bone).filter((b): b is THREE.Bone => !!b)
        if (bones.length) this.springs.addChain(bones, SPRINGS[kind])
      }
    }

    // 豎琴
    const socket = scene.getObjectByName(ELF_NODES.harpSocket)
    if (socket && harp) {
      this.harp = harp.scene
      this.harp.name = 'Harp'
      this.harp.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        m.castShadow = true
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) optimizeMaterial(mat as THREE.MeshStandardMaterial)
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

  get harpVisible() {
    return this.harpPivot.visible
  }

  animate(dt: number, moveSpeed01: number, pose: Pose, flags?: AnimFlags) {
    if (this.status === 'disposed') return
    if (!this.mixer) {
      this.fallback?.animate(dt, moveSpeed01, pose, flags)
      return
    }
    const d = this.anim.update(pose, moveSpeed01)
    const next = this.actions.get(d.clip)
    if (next && (d.changed || d.restart || next !== this.active)) {
      next.reset()
      next.setEffectiveWeight(1)
      next.play()
      if (this.active && this.active !== next) next.crossFadeFrom(this.active, d.fade, false)
      this.active = next
    }
    if (this.active) this.active.timeScale = d.timeScale
    this.mixer.update(dt)
    this.root.updateMatrixWorld(true)
    this.springs.update(dt, this.root)

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
export function optimizeMaterial(mat: THREE.MeshStandardMaterial) {
  if (!mat || mat.userData.elfOptimized) return
  mat.userData.elfOptimized = true
  if (mat.map) {
    mat.map.colorSpace = THREE.SRGBColorSpace
    mat.map.anisotropy = 4
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
  if (/Hair|Leaf|Petal|String|Gem|Face/.test(name)) {
    mat.userData.outlineParameters = { visible: false }
  } else {
    mat.userData.outlineParameters = { thickness: 0.0022, color: [0.22, 0.15, 0.1], alpha: 1, visible: true }
  }
  if (name === 'M_Hair' || name === 'M_Face' || name === 'M_Skin') {
    // 臉與頭髮用微弱自發光避免在陰影中發灰，維持插畫感
    mat.emissive = new THREE.Color(name === 'M_Hair' ? 0x2a1e08 : 0x2a1810)
  }
}

function easeOutBack(k: number) {
  const c1 = 1.70158, c3 = c1 + 1
  return k <= 0 ? 0 : k >= 1 ? 1 : 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2)
}
