import { describe, expect, it } from 'vitest'
import { mobileOs } from '../src/input/install'

describe('加入主畫面引導：判斷手機系統', () => {
  it('iPhone / iPad / iPadOS 桌機版 UA', () => {
    expect(mobileOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('ios')
    expect(mobileOs('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('ios')
    expect(mobileOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5)).toBe('ios')
  })

  it('Android', () => {
    expect(mobileOs('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe('android')
  })

  it('桌機不顯示', () => {
    expect(mobileOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 0)).toBeNull()
    expect(mobileOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36')).toBeNull()
  })
})
