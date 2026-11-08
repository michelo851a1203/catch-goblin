import type { Pose } from '../models'
import type { ElfClip } from './assets'

export interface ClipSpec {
  loop: boolean
  fade: number // 進入此動作的淡入秒數
}

// 每個角色的動畫規格（動作清單、姿勢 → 動作、步態參考速度）；預設為豎琴精靈
export interface AnimSpec {
  clips: Record<string, ClipSpec>
  poseClip: Partial<Record<Pose, string>>
  // 步態動作在 timeScale = 1 時腳底相對地面的速度（m/s），與 Blender 腳本量測 / 設定的值一致
  gaitRef: { Walk: number; Run: number }
  gaitRange: { Walk: readonly [number, number]; Run: readonly [number, number] }
  // 各動作固定的播放速率（未列出為 1）
  timeScale?: Record<string, number>
}

export const CLIP_SPECS: Record<ElfClip, ClipSpec> = {
  Idle: { loop: true, fade: 0.3 },
  Walk: { loop: true, fade: 0.25 },
  Run: { loop: true, fade: 0.2 },
  Play: { loop: true, fade: 0.25 },
  Cast: { loop: false, fade: 0.1 },
  Strike: { loop: false, fade: 0.06 },
  Capture: { loop: true, fade: 0.15 },
  Victory: { loop: true, fade: 0.4 },
  Stunned: { loop: true, fade: 0.12 },
}

// 移動量門檻（含遲滯，避免在邊界來回切換）；約 3.3 m/s 以上改為跑步
export const LOCO = { walkIn: 0.12, walkOut: 0.06, runIn: 0.45, runOut: 0.36 }

// 步態動作在 timeScale = 1 時腳底相對地面的速度（m/s），與 build_elf_meshy.py 的 WALK_REF / RUN_REF 一致。
// 依角色實際移動速度調整播放速率 → 支撐腳不會在地面上滑動（看起來不像飄著走）
export const GAIT_REF = { Walk: 1.9, Run: 6.6 }

export const HARP_ANIM: AnimSpec = {
  clips: CLIP_SPECS,
  poseClip: { play: 'Play', cast: 'Cast', attack: 'Strike', pack: 'Capture', stunned: 'Stunned' },
  gaitRef: GAIT_REF,
  gaitRange: { Walk: [0.5, 1.9], Run: [0.55, 1.35] },
  timeScale: { Cast: 1.6 },
}

export interface AnimDecision {
  clip: string
  changed: boolean
  fade: number
  timeScale: number
  restart: boolean // 一次性動作重新觸發
}

// 純邏輯的動畫狀態機：輸入遊戲姿勢與移動量，輸出要播放的動作
export class ElfAnimState {
  current = 'Idle'
  victory = false
  readonly spec: AnimSpec
  private lastPose: Pose = 'normal'
  private readonly out: AnimDecision = { clip: 'Idle', changed: false, fade: 0, timeScale: 1, restart: false }

  constructor(spec: AnimSpec = HARP_ANIM) {
    this.spec = spec
  }

  // speed：角色實際的水平速度（m/s）；未提供時以移動量推估
  update(pose: Pose, move: number, speed?: number): AnimDecision {
    const S = this.spec
    const prev = this.current
    let next = S.poseClip[pose] ?? this.locomotion(move)
    if (this.victory && next !== 'Stunned' && (pose === 'normal' || pose === 'rooted' || pose === 'held')) next = 'Victory'
    const spec = S.clips[next] ?? { loop: true, fade: 0.2 }
    const restart = next === prev && !spec.loop && pose !== this.lastPose
    this.lastPose = pose
    this.current = next
    const o = this.out
    o.clip = next
    o.changed = next !== prev
    o.restart = restart
    o.fade = spec.fade
    if (next === 'Walk' || next === 'Run') {
      const v = speed ?? move * 6.5
      o.timeScale = clamp(v / S.gaitRef[next], S.gaitRange[next][0], S.gaitRange[next][1])
    } else o.timeScale = S.timeScale?.[next] ?? 1
    return o
  }

  private locomotion(m: number): string {
    const c = this.current
    if (c === 'Run') return m < LOCO.runOut ? (m < LOCO.walkOut ? 'Idle' : 'Walk') : 'Run'
    if (c === 'Walk') return m > LOCO.runIn ? 'Run' : m < LOCO.walkOut ? 'Idle' : 'Walk'
    return m > LOCO.runIn ? 'Run' : m > LOCO.walkIn ? 'Walk' : 'Idle'
  }
}

function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v
}
