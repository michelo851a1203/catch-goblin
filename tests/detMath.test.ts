// tests/sim/detMath 的精度與「跨平台結果固定」檢查
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as D from './sim/detMath'

// 固定種子的亂數（mulberry32）
function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const N = 20000
// 相對誤差（結果接近 0 時改看絕對誤差）
const err = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-3, Math.abs(b))

describe('跨平台一致的數學函式', () => {
  const rnd = seeded(2026)
  const xs = Array.from({ length: N }, () => [(rnd() - 0.5) * 200, (rnd() - 0.5) * 200])
  const cases: Record<string, [(x: number, y: number) => number, (x: number, y: number) => number]> = {
    sin: [(x) => D.sin(x), (x) => Math.sin(x)],
    cos: [(x) => D.cos(x), (x) => Math.cos(x)],
    sinBig: [(x) => D.sin(x * 500), (x) => Math.sin(x * 500)],
    atan: [(x) => D.atan(x / 10), (x) => Math.atan(x / 10)],
    atan2: [(x, y) => D.atan2(x, y), (x, y) => Math.atan2(x, y)],
    asin: [(x) => D.asin(x / 100), (x) => Math.asin(x / 100)],
    acos: [(x) => D.acos(x / 100), (x) => Math.acos(x / 100)],
    exp: [(x) => D.exp(x), (x) => Math.exp(x)],
    log: [(x) => D.log(Math.abs(x)), (x) => Math.log(Math.abs(x))],
    pow: [(x, y) => D.pow(Math.abs(x), y / 20), (x, y) => Math.pow(Math.abs(x), y / 20)],
    powInt: [(x, y) => D.pow(x / 10, Math.round(y / 20)), (x, y) => Math.pow(x / 10, Math.round(y / 20))],
  }

  for (const [name, [mine, native]] of Object.entries(cases))
    it(`${name} 與內建版本的誤差在容許範圍內`, () => {
      let worst = 0
      for (const [x, y] of xs) {
        const a = mine(x, y), b = native(x, y)
        if (Number.isFinite(b)) worst = Math.max(worst, err(a, b))
        else expect(a).toBe(b)
      }
      expect(worst).toBeLessThan(name.startsWith('pow') || name === 'sinBig' ? 2e-13 : 4e-15)
    })

  it('tan 在遠離極點處與內建版本一致', () => {
    for (const [x] of xs) {
      const b = Math.tan(x)
      if (Math.abs(b) < 100) expect(err(D.tan(x), b)).toBeLessThan(1e-12)
    }
  })

  it('特殊值', () => {
    expect(D.sin(0)).toBe(0)
    expect(Object.is(D.sin(-0), -0)).toBe(true)
    expect(D.cos(0)).toBe(1)
    expect(D.sin(NaN)).toBeNaN()
    expect(D.cos(Infinity)).toBeNaN()
    expect(D.atan2(0, -1)).toBe(Math.PI)
    expect(D.atan2(1, 0)).toBe(Math.PI / 2)
    expect(D.atan2(-1, -1)).toBeCloseTo(-0.75 * Math.PI, 15)
    expect(D.atan(Infinity)).toBe(Math.PI / 2)
    expect(D.asin(2)).toBeNaN()
    expect(D.acos(1)).toBe(0)
    expect(D.exp(0)).toBe(1)
    expect(D.exp(-Infinity)).toBe(0)
    expect(D.exp(1000)).toBe(Infinity)
    expect(D.exp(-740) / Math.exp(-740)).toBeCloseTo(1, 1)
    expect(D.log(1)).toBe(0)
    expect(D.log(0)).toBe(-Infinity)
    expect(D.log(-1)).toBeNaN()
    expect(D.log(5e-324)).toBeCloseTo(Math.log(5e-324), 10)
    expect(D.pow(3, 2)).toBe(9)
    expect(D.pow(-2, 3)).toBe(-8)
    expect(D.pow(2, -2)).toBe(0.25)
    expect(D.pow(9, 0.5)).toBe(3)
    expect(D.pow(-8, 0.5)).toBeNaN()
    expect(D.pow(5, 0)).toBe(1)
    expect(D.pow(0, 3)).toBe(0)
  })

  // 這個雜湊在任何 CPU 架構 / 作業系統上都必須相同：不同就代表 golden master 又會跟著平台變
  it('結果的每一個位元都固定', () => {
    const out = new Float64Array(N * 10)
    let i = 0
    for (const [x, y] of xs) {
      out[i++] = D.sin(x)
      out[i++] = D.cos(x)
      out[i++] = D.tan(x)
      out[i++] = D.atan(x)
      out[i++] = D.atan2(x, y)
      out[i++] = D.asin(x / 100)
      out[i++] = D.acos(y / 100)
      out[i++] = D.exp(x / 10)
      out[i++] = D.log(Math.abs(y))
      out[i++] = D.pow(Math.abs(x), y / 20)
    }
    expect(createHash('sha256').update(new Uint8Array(out.buffer)).digest('hex')).toBe('42cf63ccdc34bd3e6a22f54fd1050a8afb490ee725e8e92b4e209d06a9764eb0')
  })
})
