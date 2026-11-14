import { describe, expect, it } from 'vitest'
import { BlinkTimer } from '../src/game/elf/blink'

// 固定亂數序列：可重現的眨眼節奏
function seq(...v: number[]) {
  let i = 0
  return () => v[i++ % v.length]
}

describe('眨眼節奏', () => {
  it('一開始睜眼，等待後閉上再睜開，數值都在 0～1', () => {
    const b = new BlinkTimer(seq(0.5, 0.9, 0.5))
    const dt = 1 / 60
    let maxK = 0
    let closedAt = -1
    let openedAt = -1
    for (let f = 0; f < 60 * 8; f++) {
      const k = b.update(dt)
      expect(k).toBeGreaterThanOrEqual(0)
      expect(k).toBeLessThanOrEqual(1)
      if (k >= 0.999 && closedAt < 0) closedAt = f
      if (closedAt >= 0 && openedAt < 0 && k === 0) openedAt = f
      maxK = Math.max(maxK, k)
    }
    expect(maxK).toBe(1)
    // 第一次眨眼在 1～3 秒之間（這組亂數為 2 秒）
    expect(closedAt / 60).toBeGreaterThan(1.9)
    expect(closedAt / 60).toBeLessThan(2.2)
    // 一次眨眼（閉 + 停 + 睜）約 0.23 秒
    expect((openedAt - closedAt) / 60).toBeLessThan(0.3)
  })

  it('兩成機率連眨兩下：緊接著 0.12 秒後再眨一次', () => {
    const b = new BlinkTimer(seq(0, 0.1, 0.9))
    const dt = 1 / 60
    const blinks: number[] = []
    let prev = 0
    for (let f = 0; f < 60 * 3; f++) {
      const k = b.update(dt)
      if (k > 0 && prev === 0) blinks.push(f / 60)
      prev = k
    }
    expect(blinks.length).toBeGreaterThanOrEqual(2)
    expect(blinks[1] - blinks[0]).toBeLessThan(0.5)
  })
})
