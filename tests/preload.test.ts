import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchModel } from '../src/game/elf/preload'

afterEach(() => vi.unstubAllGlobals())

describe('精靈模型預先下載', () => {
  it('同一個網址只下載一次', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    vi.stubGlobal('fetch', fetch)
    const [a, b] = await Promise.all([fetchModel('/a.glb'), fetchModel('/a.glb')])
    expect(a).toBe(b)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('下載失敗（例如手機切到背景時網路被中斷）不會被快取，下次重新下載', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValue(new Response(new Uint8Array([7])))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchModel('/b.glb')).rejects.toThrow('Load failed')
    await Promise.resolve()
    const buf = await fetchModel('/b.glb')
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([7]))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('HTTP 錯誤也視為失敗', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    await expect(fetchModel('/c.glb')).rejects.toThrow('404')
  })
})
