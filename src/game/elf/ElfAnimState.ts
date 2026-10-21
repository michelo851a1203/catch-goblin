import type { Pose } from '../models'
import type { ElfClip } from './assets'

export interface ClipSpec {
  loop: boolean
  fade: number // 進入此動作的淡入秒數
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

// 移動量門檻（含遲滯，避免在邊界來回切換）
export const LOCO = { walkIn: 0.12, walkOut: 0.06, runIn: 0.62, runOut: 0.5 }

const POSE_CLIP: Partial<Record<Pose, ElfClip>> = {
  play: 'Play',
  cast: 'Cast',
  attack: 'Strike',
  pack: 'Capture',
  stunned: 'Stunned',
}

export interface AnimDecision {
  clip: ElfClip
  changed: boolean
  fade: number
  timeScale: number
  restart: boolean // 一次性動作重新觸發
}

// 純邏輯的動畫狀態機：輸入遊戲姿勢與移動量，輸出要播放的動作
export class ElfAnimState {
  current: ElfClip = 'Idle'
  victory = false
  private lastPose: Pose = 'normal'
  private readonly out: AnimDecision = { clip: 'Idle', changed: false, fade: 0, timeScale: 1, restart: false }

  update(pose: Pose, move: number): AnimDecision {
    const prev = this.current
    let next: ElfClip = POSE_CLIP[pose] ?? this.locomotion(move)
    if (this.victory && next !== 'Stunned' && (pose === 'normal' || pose === 'rooted' || pose === 'held')) next = 'Victory'
    const restart = next === prev && !CLIP_SPECS[next].loop && pose !== this.lastPose
    this.lastPose = pose
    this.current = next
    const o = this.out
    o.clip = next
    o.changed = next !== prev
    o.restart = restart
    o.fade = CLIP_SPECS[next].fade
    o.timeScale = next === 'Walk' ? clamp(move / 0.4, 0.6, 1.6) : next === 'Run' ? clamp(move / 0.95, 0.8, 1.4) : next === 'Cast' ? 1.6 : 1
    return o
  }

  private locomotion(m: number): ElfClip {
    const c = this.current
    if (c === 'Run') return m < LOCO.runOut ? (m < LOCO.walkOut ? 'Idle' : 'Walk') : 'Run'
    if (c === 'Walk') return m > LOCO.runIn ? 'Run' : m < LOCO.walkOut ? 'Idle' : 'Walk'
    return m > LOCO.runIn ? 'Run' : m > LOCO.walkIn ? 'Walk' : 'Idle'
  }
}

function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v
}
