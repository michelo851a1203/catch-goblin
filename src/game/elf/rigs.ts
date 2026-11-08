// 兩種精靈角色的資源規格：同一套 ElfCharacter 載入器依此載入不同的 GLB、動作與道具
import type { ElfKind } from '../config'
import { ELF_ASSETS, ELF_CLIPS, ELF_COLLIDERS, ELF_NODES, ELF_SPRING_CHAINS } from './assets'
import { HARP_ANIM, type AnimSpec } from './ElfAnimState'
import type { ColliderDef } from './SecondaryMotion'

const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/')

export interface ElfRig {
  kind: ElfKind
  url: string
  // 另外載入、掛在 propSocket 骨上的道具（豎琴）；道具已內嵌在角色 GLB 時省略
  propUrl?: string
  propSocket?: string
  clips: readonly string[]
  anim: AnimSpec
  lod: readonly string[]
  springChains: Record<string, readonly (readonly string[])[]>
  colliders: readonly ColliderDef[]
  // 由程式驅動的骨頭：從動作中移除這些軌道
  stripTracks: RegExp
  // 單張貼圖集材質（臉 / 頭髮 / 布料同一張），以貼圖做微弱自發光維持插畫感
  atlasMaterial: string
}

export const HARP_RIG: ElfRig = {
  kind: 'harp',
  url: ELF_ASSETS.character,
  propUrl: ELF_ASSETS.harp,
  propSocket: ELF_NODES.harpSocket,
  clips: ELF_CLIPS,
  anim: HARP_ANIM,
  lod: ELF_NODES.lod,
  springChains: ELF_SPRING_CHAINS,
  colliders: ELF_COLLIDERS,
  stripTracks: /^(hair_|skirt_|sleeve|prop_)/,
  atlasMaterial: 'M_Elf',
}

// 紫晶精靈（小提琴刺客）：tools/blender/build_violinist.py 產生；小提琴與琴弓掛在 prop_violin / prop_bow 骨，
// 道具骨每個動作各自打了關鍵影格（拉琴時琴弓跟著運弓），所以不能移除 prop_ 軌道
export const VIOLINIST_ASSETS = {
  character: `${base}models/violinist/violinist.glb`,
} as const

export const VIOLINIST_CLIPS = [
  'Idle', 'Walk', 'Run', 'Play', 'Cast', 'ChargeWindup', 'ChargeDash', 'ChargeRecover', 'Capture', 'Victory', 'Stunned',
] as const

export const VIOLINIST_ANIM: AnimSpec = {
  clips: {
    Idle: { loop: true, fade: 0.3 },
    Walk: { loop: true, fade: 0.25 },
    Run: { loop: true, fade: 0.2 },
    Play: { loop: true, fade: 0.2 },
    Cast: { loop: false, fade: 0.1 },
    ChargeWindup: { loop: false, fade: 0.06 },
    ChargeDash: { loop: true, fade: 0.05 },
    ChargeRecover: { loop: false, fade: 0.05 },
    Capture: { loop: true, fade: 0.15 },
    Victory: { loop: true, fade: 0.4 },
    Stunned: { loop: true, fade: 0.12 },
  },
  poseClip: {
    play: 'Play', cast: 'Cast', attack: 'ChargeRecover', pack: 'Capture', stunned: 'Stunned',
    windup: 'ChargeWindup', dash: 'ChargeDash', recover: 'ChargeRecover',
  },
  // build_violinist.py 量測的 Mixamo Walking / Running 腳底速度
  gaitRef: { Walk: 1.57, Run: 5.57 },
  gaitRange: { Walk: [0.5, 2.0], Run: [0.6, 1.5] },
  // 前搖動作 0.5 s（12 格 @24fps）；突刺循環加快；收招配合 0.4 s
  timeScale: { Cast: 1.4, ChargeDash: 1.6, ChargeRecover: 1.25 },
}

export const VIOLINIST_RIG: ElfRig = {
  kind: 'violin',
  url: VIOLINIST_ASSETS.character,
  clips: VIOLINIST_CLIPS,
  anim: VIOLINIST_ANIM,
  lod: ['VioletMesh_LOD0', 'VioletMesh_LOD1'],
  springChains: {},
  colliders: [],
  stripTracks: /^$/,
  atlasMaterial: 'M_Violet',
}

export function rigOf(kind: ElfKind): ElfRig {
  return kind === 'violin' ? VIOLINIST_RIG : HARP_RIG
}

// 隱身時精靈玩家自己看到的半透明程度
export const GHOST_OPACITY = 0.32
