// Cloudflare Worker：發給遊戲 Cloudflare TURN 的短效憑證。
// TURN 金鑰（TURN_KEY_ID / TURN_KEY_API_TOKEN）只存在 Worker 的 secret，瀏覽器只拿得到有期限的帳密。
// GET /ice → { iceServers: RTCIceServer[], ttl: number }

export interface Env {
  TURN_KEY_ID: string
  TURN_KEY_API_TOKEN: string
  // 允許呼叫的網頁來源，逗號分隔；支援 https://*.crazygames.com 這種子網域萬用字元
  ALLOWED_ORIGINS: string
  // 憑證有效秒數（預設 24 小時）
  TURN_TTL?: string
}

const DEFAULT_TTL = 86400

// 來源比對：scheme 與 port 要相同；*.example.com 只比對子網域（不含 example.com 本身）
export function originAllowed(origin: string | null, patterns: string): boolean {
  if (!origin) return false
  let o: URL
  try {
    o = new URL(origin)
  } catch {
    return false
  }
  return patterns
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => {
      const m = /^(https?):\/\/(\*\.)?([^/:]+)(?::(\d+))?$/.exec(p)
      if (!m) return false
      const [, scheme, wild, host, port = ''] = m
      if (o.protocol !== `${scheme}:` || o.port !== port) return false
      return wild ? o.hostname.endsWith(`.${host}`) : o.hostname === host
    })
}

// 瀏覽器會擋 53 port，留著只會讓 ICE 收集等到逾時（Cloudflare 官方建議過濾）
export function dropPort53(servers: RTCIceServer[]): RTCIceServer[] {
  return servers
    .map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u))
      return { ...s, urls }
    })
    .filter((s) => s.urls.length > 0)
}

function cors(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin')
    if (!originAllowed(origin, env.ALLOWED_ORIGINS)) return new Response('Forbidden', { status: 403 })
    const headers = cors(origin!)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (req.method !== 'GET' || new URL(req.url).pathname !== '/ice') return new Response('Not found', { status: 404, headers })

    const ttl = Number(env.TURN_TTL) || DEFAULT_TTL
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl }),
    })
    if (!res.ok) return new Response('TURN unavailable', { status: 502, headers })
    const { iceServers } = (await res.json()) as { iceServers: RTCIceServer[] }
    return Response.json({ iceServers: dropPort53(iceServers), ttl }, { headers: { ...headers, 'Cache-Control': 'no-store' } })
  },
}
