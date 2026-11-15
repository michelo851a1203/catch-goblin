// 女精靈（豎琴精靈）美術資源清單（與 docs/elf-asset-spec.md、tools/blender/build_harpist.py 同步）
import { COLLIDE, type ColliderDef } from './SecondaryMotion'

const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/')

export const ELF_ASSETS = {
  character: `${base}models/elf/elf.glb`,
  harp: `${base}models/elf/harp.glb`,
  // build_harpist.py 由高模烘焙的 4096² 貼圖（GLB 內嵌 2048²；非低階裝置延遲載入替換）
  colorHiRes: `${base}models/elf/elf_color_4k.webp`,
  normalHiRes: `${base}models/elf/elf_normal_4k.webp`,
} as const

// GLB 內的動作名稱
export const ELF_CLIPS = ['Idle', 'Walk', 'Run', 'Play', 'Cast', 'Strike', 'Capture', 'Victory', 'Stunned'] as const
export type ElfClip = (typeof ELF_CLIPS)[number]

export const ELF_NODES = {
  lod: ['ElfMesh_LOD0', 'ElfMesh_LOD1'],
  harpSocket: 'prop_harp',
} as const

const chain = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

// 次級動畫骨鏈（build_harpist.py 的 rig_character；鍵 = SecondaryMotion 的 SPRINGS 參數組）
export const ELF_SPRING_CHAINS = {
  // 裙擺一圈 8 條 × 4 節，掛在 Hips（前 F、左前 FL、左 L …）
  gown: ['F', 'FL', 'L', 'BL', 'B', 'BR', 'R', 'FR'].map((d) => chain(`skirt_${d}`, 4)),
  // 寬袖：每邊 3 條 × 3 節，沿手臂掛在上臂（A）/ 前臂（B、C）下緣；重力為主，手怎麼擺袖子都往下垂
  veil: ['LA', 'LB', 'LC', 'RA', 'RB', 'RC'].map((d) => chain(`sleeve_${d}`, 3)),
  // 背後的長髮（肩膀以下）3 條 × 3 節，掛在 Spine2
  tress: ['L', 'C', 'R'].map((d) => chain(`hair_${d}`, 3)),
} as const

// 次級動畫的碰撞體（Mixamo 骨名；半徑略小於實際身形，讓 rest pose 不會一開始就穿入）
export const ELF_COLLIDERS: readonly ColliderDef[] = [
  { from: 'Hips', to: 'Spine1', radius: 0.1, group: COLLIDE.body },
  { from: 'Spine1', to: 'Neck', radius: 0.095, group: COLLIDE.body },
  ...(['Left', 'Right'] as const).flatMap((s): ColliderDef[] => [
    { from: `${s}UpLeg`, to: `${s}Leg`, radius: 0.07, group: COLLIDE.legs },
    { from: `${s}Leg`, to: `${s}Foot`, radius: 0.05, group: COLLIDE.legs },
  ]),
  // 裙子的圓錐（col_skirt2 是掛在 Hips 下、裙子軸線上離地 0.3 m 的輔助骨）：寬袖的長袖尾披在裙子外面。
  // 沒有這個碰撞體時袖尾會垂直垂進裙子裡被裙片遮住，只剩手邊一團袖口。半徑比實際的裙子小 4 cm（裙片本身也會擺動）
  { from: 'Hips', to: 'col_skirt2', t0: 0.17, radius: 0.17, radiusEnd: 0.485, group: COLLIDE.skirt },
]
