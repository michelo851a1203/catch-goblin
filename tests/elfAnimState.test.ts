import { describe, expect, it } from 'vitest'
import { CLIP_SPECS, ElfAnimState, LOCO } from '../src/game/elf/ElfAnimState'
import type { Pose } from '../src/game/models'

describe('ElfAnimState 動畫狀態機', () => {
  it('依移動量切換 Idle / Walk / Run', () => {
    const s = new ElfAnimState()
    expect(s.update('normal', 0).clip).toBe('Idle')
    expect(s.update('normal', 0.3).clip).toBe('Walk')
    expect(s.update('normal', 1.0).clip).toBe('Run')
    expect(s.update('normal', 0).clip).toBe('Idle')
  })

  it('門檻有遲滯，不會在邊界抖動', () => {
    const s = new ElfAnimState()
    s.update('normal', LOCO.walkIn + 0.01)
    expect(s.current).toBe('Walk')
    // 介於 walkOut 與 walkIn 之間維持 Walk
    expect(s.update('normal', (LOCO.walkIn + LOCO.walkOut) / 2).clip).toBe('Walk')
    s.update('normal', 1)
    expect(s.update('normal', (LOCO.runIn + LOCO.runOut) / 2).clip).toBe('Run')
    expect(s.update('normal', LOCO.runOut - 0.05).clip).toBe('Walk')
  })

  it('遊戲姿勢對應到技能動作', () => {
    const s = new ElfAnimState()
    const map: [Pose, string][] = [
      ['play', 'Play'],
      ['cast', 'Cast'],
      ['attack', 'Strike'],
      ['pack', 'Capture'],
      ['stunned', 'Stunned'],
      ['rooted', 'Idle'],
      ['held', 'Idle'],
    ]
    for (const [pose, clip] of map) expect(s.update(pose, 0).clip).toBe(clip)
  })

  it('只有切換時 changed 為 true，並帶入對應淡入時間', () => {
    const s = new ElfAnimState()
    s.update('normal', 0)
    const d = s.update('play', 0)
    expect(d.changed).toBe(true)
    expect(d.fade).toBe(CLIP_SPECS.Play.fade)
    expect(s.update('play', 0).changed).toBe(false)
  })

  it('一次性動作（Strike）連續觸發時會 restart', () => {
    const s = new ElfAnimState()
    s.update('attack', 0)
    s.update('cast', 0)
    expect(s.update('attack', 0).changed).toBe(true)
    // 姿勢沒變就不重播
    expect(s.update('attack', 0).restart).toBe(false)
  })

  it('勝利旗標覆蓋一般姿勢，但暈眩優先', () => {
    const s = new ElfAnimState()
    s.victory = true
    expect(s.update('normal', 0.8).clip).toBe('Victory')
    expect(s.update('stunned', 0).clip).toBe('Stunned')
  })

  it('走路 / 跑步的播放速度跟著移動量', () => {
    const s = new ElfAnimState()
    const slow = s.update('normal', 0.2).timeScale
    const fast = s.update('normal', 0.55).timeScale
    expect(fast).toBeGreaterThan(slow)
  })
})
