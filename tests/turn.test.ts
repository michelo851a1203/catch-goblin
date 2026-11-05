import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { dropPort53, originAllowed } from '../worker/turn/src/index'

const ALLOWED = 'https://*.crazygames.com,http://localhost:5173'
const env = { TURN_KEY_ID: 'kid', TURN_KEY_API_TOKEN: 'secret', ALLOWED_ORIGINS: ALLOWED }

describe('TURN worker', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('只允許白名單來源', () => {
    expect(originAllowed('https://elf-and-goblins.game-files.crazygames.com', ALLOWED)).toBe(true)
    expect(originAllowed('http://localhost:5173', ALLOWED)).toBe(true)
    expect(originAllowed('http://localhost:5174', ALLOWED)).toBe(false)
    expect(originAllowed('https://crazygames.com.evil.io', ALLOWED)).toBe(false)
    expect(originAllowed('https://evilcrazygames.com', ALLOWED)).toBe(false)
    expect(originAllowed('http://x.crazygames.com', ALLOWED)).toBe(false)
    expect(originAllowed(null, ALLOWED)).toBe(false)
  })

  it('過濾 53 port 的 TURN 網址', () => {
    const out = dropPort53([
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: ['turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
      { urls: ['turn:turn.cloudflare.com:53'] },
    ])
    expect(out).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
    ])
  })

  it('白名單外的來源拿不到憑證，也不會呼叫 Cloudflare', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const res = await worker.fetch(new Request('https://w.dev/ice', { headers: { Origin: 'https://evil.io' } }), env)
    expect(res.status).toBe(403)
    expect(f).not.toHaveBeenCalled()
  })

  it('向 Cloudflare 產生憑證並帶上 CORS', async () => {
    const f = vi.fn(async () => Response.json({ iceServers: [{ urls: ['turn:turn.cloudflare.com:53', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }] }, { status: 201 }))
    vi.stubGlobal('fetch', f)
    const origin = 'https://a.game-files.crazygames.com'
    const res = await worker.fetch(new Request('https://w.dev/ice', { headers: { Origin: origin } }), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(await res.json()).toEqual({ iceServers: [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }], ttl: 86400 })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/kid/credentials/generate-ice-servers')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret')
  })
})

describe('ice', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  async function load(url: string) {
    vi.resetModules()
    vi.stubEnv('VITE_TURN_URL', url)
    return import('../src/net/ice')
  }

  it('沒設定 VITE_TURN_URL 時只用 STUN', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const ice = await load('')
    expect(await ice.iceServers()).toBe(ice.FALLBACK_ICE)
    expect(f).not.toHaveBeenCalled()
  })

  it('Worker 失敗時退回 STUN，成功後快取憑證', async () => {
    const servers = [{ urls: ['turn:t'], username: 'u', credential: 'c' }]
    const f = vi.fn(async () => new Response('x', { status: 502 }))
    vi.stubGlobal('fetch', f)
    const ice = await load('https://w.dev/ice')
    expect(await ice.iceServers()).toBe(ice.FALLBACK_ICE)
    f.mockImplementation(async () => Response.json({ iceServers: servers, ttl: 86400 }))
    expect(await ice.iceServers()).toEqual(servers)
    expect(await ice.iceServers()).toEqual(servers)
    expect(f).toHaveBeenCalledTimes(2)
  })
})
