// 女精靈美術資源清單（與 docs/elf-asset-spec.md、tools/blender/build_elf.py 同步）
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

// 次級動畫骨鏈（GLTFLoader 會把骨頭名稱中的 '.' 去掉，例如 hand.L → handL）
export const ELF_SPRING_CHAINS = {
  hair: [
    ['hair_L1', 'hair_L2', 'hair_L3'],
    ['hair_C1', 'hair_C2', 'hair_C3'],
    ['hair_R1', 'hair_R2', 'hair_R3'],
  ],
  skirt: [
    ['skirt_F1', 'skirt_F2'],
    ['skirt_L1', 'skirt_L2'],
    ['skirt_B1', 'skirt_B2'],
    ['skirt_R1', 'skirt_R2'],
  ],
  sleeve: [['sleeveL'], ['sleeveR']],
} as const
