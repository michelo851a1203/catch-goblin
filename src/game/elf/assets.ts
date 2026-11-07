// 女精靈美術資源清單（與 docs/elf-asset-spec.md、tools/blender/build_elf_meshy.py 同步）
import { COLLIDE, type ColliderDef } from './SecondaryMotion'

const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/')

export const ELF_ASSETS = {
  character: `${base}models/elf/elf.glb`,
  harp: `${base}models/elf/harp.glb`,
} as const

// GLB 內的動作名稱
export const ELF_CLIPS = ['Idle', 'Walk', 'Run', 'Play', 'Cast', 'Strike', 'Capture', 'Victory', 'Stunned'] as const
export type ElfClip = (typeof ELF_CLIPS)[number]

export const ELF_NODES = {
  lod: ['ElfMesh_LOD0', 'ElfMesh_LOD1'],
  harpSocket: 'prop_harp',
} as const

const chain = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

// 次級動畫骨鏈（GLTFLoader 會把骨頭名稱中的 '.' 去掉，例如 hand.L → handL）
export const ELF_SPRING_CHAINS = {
  // 背後 3 條 + 兩側（臉側髮束）2 條，各 3 節
  hair: ['hair_SR', 'hair_R', 'hair_C', 'hair_L', 'hair_SL'].map((p) => chain(p, 3)),
  // 裙擺一圈 8 條，各 3 節（前 F、左前 FL、左 L …）
  skirt: ['F', 'FL', 'L', 'BL', 'B', 'BR', 'R', 'FR'].map((d) => chain(`skirt_${d}`, 3)),
  // 喇叭紗袖：前臂下方 2 節
  sleeve: [
    ['sleeveL', 'sleeve2L'],
    ['sleeveR', 'sleeve2R'],
  ],
} as const

// 次級動畫的碰撞體（半徑略小於實際身形，讓 rest pose 不會一開始就穿入）
export const ELF_COLLIDERS: readonly ColliderDef[] = [
  { from: 'hips', to: 'spine', radius: 0.11, group: COLLIDE.body },
  { from: 'spine', to: 'chest', radius: 0.1, group: COLLIDE.body },
  { from: 'chest', to: 'neck', radius: 0.105, group: COLLIDE.body },
  { from: 'head', offset: [0, 0.07, 0], radius: 0.1, group: COLLIDE.head },
  ...(['L', 'R'] as const).flatMap((s): ColliderDef[] => [
    { from: `upper_arm${s}`, to: `forearm${s}`, radius: 0.045, group: COLLIDE.arms },
    { from: `forearm${s}`, to: `hand${s}`, radius: 0.04, group: COLLIDE.arms },
    { from: `thigh${s}`, to: `shin${s}`, radius: 0.075, group: COLLIDE.legs },
    { from: `shin${s}`, to: `foot${s}`, radius: 0.055, group: COLLIDE.legs },
  ]),
]
