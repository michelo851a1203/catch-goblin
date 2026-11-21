// 兩種精靈角色的資源規格：同一套 ElfCharacter 載入器依此載入不同的 GLB、動作與道具
import type { ElfKind } from '../config'
import { ELF_ASSETS, ELF_CLIPS, ELF_COLLIDERS, ELF_NODES, ELF_SPRING_CHAINS } from './assets'
import { HARP_ANIM, type AnimSpec } from './ElfAnimState'
import { COLLIDE, type ColliderDef } from './SecondaryMotion'
import type { CelParams } from './celShading'
import type { BlinkSpec } from './blink'

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
  // 貼圖集材質改用 cel shading（直射光分兩階、臉部以 _facemask 柔化陰影，見 celShading.ts）
  cel?: Partial<CelParams>
  // 非低階裝置在模型載入後另外載入的高解析貼圖（替換貼圖集材質的 map / normalMap），放大看時保有細節
  hiResMap?: string
  hiResNormal?: string
  // 眨眼（見 blink.ts）：眼睛在綁定姿勢中的位置，以正面正交視角在眼睛中心、上下眼瞼、眼角射線量測
  blink?: BlinkSpec
  // 站定展示（holdPose，選角詳情頁）時讓道具確實握在手裡：把道具上握把那一段（grip，道具網格局部座標的兩端點，
  // 第二點朝道具頂端）對齊到手的軸線、放進手掌截面中心（見 ElfCharacter.applyHoldProp，執行時依實際網格計算）
  holdProp?: { node: string; hand: string; grip: readonly [readonly [number, number, number], readonly [number, number, number]] }
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
  // 布料骨由程式驅動；prop_harp 每個動作各自打了關鍵影格（琴身保持直立），不能移除
  stripTracks: /^(hair_|skirt_|sleeve_|col_)/,
  atlasMaterial: 'M_Elf',
  // 與紫晶精靈相同的 cel shading（臉部遮罩 _facemask 與橢球法線由 build_harpist.py 產生）
  // 這個角色的皮膚與白色布料貼圖本身很亮（接近 1.0），亮面壓低一些才不會整片曝白、看不出皺褶與金飾
  cel: { lit: 0.42, shade: 0.62, faceShade: 0.86 },
  hiResMap: ELF_ASSETS.colorHiRes,
  hiResNormal: ELF_ASSETS.normalHiRes,
  blink: {
    eyes: [
      { center: [-0.0383, 1.5545, 0.178], radius: [0.0215, 0.012, 0.025] },
      { center: [0.036, 1.5545, 0.178], radius: [0.0215, 0.012, 0.025] },
    ],
    skin: 0xfce9e3,
    lash: 0x422e24,
  },
}

// 紫晶精靈（小提琴刺客）：tools/blender/build_violinist.py 產生；小提琴與琴弓掛在 prop_violin / prop_bow 骨，
// 道具骨每個動作各自打了關鍵影格（拉琴時琴弓跟著運弓），所以不能移除 prop_ 軌道
export const VIOLINIST_ASSETS = {
  character: `${base}models/violinist/violinist.glb`,
  // build_violinist.py 由 Meshy 原始 4096² 貼圖另存
  colorHiRes: `${base}models/violinist/violet_color_4k.webp`,
  // 由 384 萬面高模烘焙的切線空間法線貼圖
  normalHiRes: `${base}models/violinist/violet_normal_4k.webp`,
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
  // build_violinist.py 的程序化步態（WALK_REF / RUN_REF）：timeScale=1 時腳底相對地面的速度
  gaitRef: { Walk: 1.6, Run: 6.0 },
  gaitRange: { Walk: [0.5, 2.0], Run: [0.6, 1.5] },
  // 前搖動作原長 0.5 s（12 格 @24fps），加快到 0.3 s 播完（配合 CONFIG.violin.charge.windup）；突刺循環加快；收招配合 0.4 s
  timeScale: { Cast: 1.4, ChargeWindup: 0.5 / 0.3, ChargeDash: 1.6, ChargeRecover: 1.25 },
}

const vchain = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

// 紫晶精靈的布料 / 頭髮彈簧骨（build_violinist.py 的 rig_cloth）：裙擺一圈 8 條 × 4 節掛在 Hips、垂袖左右各 3 節掛在 Spine2
export const VIOLINIST_SPRING_CHAINS = {
  silk: ['F', 'FL', 'L', 'BL', 'B', 'BR', 'R', 'FR'].map((d) => vchain(`skirt_${d}`, 4)),
  drape: [vchain('drape_L', 3), vchain('drape_R', 3)],
  // 背後的長髮（肩膀以下）3 條 × 3 節，掛在 Spine2
  tress: [vchain('hair_L', 3), vchain('hair_C', 3), vchain('hair_R', 3)],
}

// 碰撞體（Mixamo 骨名）：腿把裙擺推開、垂袖不穿進身體；半徑略小於實際身形，rest pose 不會一開始就穿入
export const VIOLINIST_COLLIDERS: readonly ColliderDef[] = [
  { from: 'Hips', to: 'Spine1', radius: 0.1, group: COLLIDE.body },
  { from: 'Spine1', to: 'Neck', radius: 0.095, group: COLLIDE.body },
  ...(['Left', 'Right'] as const).flatMap((s): ColliderDef[] => [
    { from: `${s}UpLeg`, to: `${s}Leg`, radius: 0.07, group: COLLIDE.legs },
    { from: `${s}Leg`, to: `${s}Foot`, radius: 0.05, group: COLLIDE.legs },
  ]),
]

export const VIOLINIST_RIG: ElfRig = {
  kind: 'violin',
  url: VIOLINIST_ASSETS.character,
  clips: VIOLINIST_CLIPS,
  anim: VIOLINIST_ANIM,
  lod: ['VioletMesh_LOD0', 'VioletMesh_LOD1'],
  springChains: VIOLINIST_SPRING_CHAINS,
  colliders: VIOLINIST_COLLIDERS,
  // 布料骨由程式驅動；道具骨（prop_）每個動作各自打了關鍵影格，不能移除
  stripTracks: /^(skirt_|drape_|hair_)/,
  atlasMaterial: 'M_Violet',
  cel: {},
  hiResMap: VIOLINIST_ASSETS.colorHiRes,
  hiResNormal: VIOLINIST_ASSETS.normalHiRes,
  // 待機時小提琴垂在左手前緣、琴頸斜斜伸到胸口，看起來像浮在手旁邊（手指沒有骨骼，無法彎曲包住琴頸）。
  // 站定展示時把琴頸（局部 z -0.045～0.035，寬 2.6 cm、厚 2.2 cm，比手掌的 4 cm 厚度薄）整段放進手裡：
  // 手掌與手指從四周蓋住琴頸，琴頭在手腕旁露出、琴身垂在指尖下＝單手提著琴頸，任何角度都看得出握住。
  // 只用在選角詳情頁，遊戲中各動作的道具位置不受影響
  holdProp: { node: 'Violin', hand: 'LeftHand', grip: [[0.065, 0.052, -0.045], [0.065, 0.052, 0.035]] },
  blink: {
    eyes: [
      { center: [-0.0332, 1.4696, 0.1872], radius: [0.02, 0.0118, 0.025] },
      { center: [0.0328, 1.4696, 0.1875], radius: [0.02, 0.0118, 0.025] },
    ],
    skin: 0xe9c3c3,
    lash: 0x3a2238,
  },
}

export function rigOf(kind: ElfKind): ElfRig {
  return kind === 'violin' ? VIOLINIST_RIG : HARP_RIG
}

// 隱身時精靈玩家自己看到的半透明程度
export const GHOST_OPACITY = 0.32
