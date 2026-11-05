// WebRTC 的 ICE 伺服器（STUN / TURN）。
// 正式環境向 Cloudflare Worker（worker/turn）索取 Cloudflare TURN 的短效憑證：TURN 金鑰只存在 Worker 上，不會打包進遊戲。
// 沒設定 VITE_TURN_URL、Worker 連不上或逾時時，退回 VITE_PEER_ICE_SERVERS 或只用 STUN（大部分網路仍可連線，嚴格 NAT 才需要 TURN）。
const env = import.meta.env
const TURN_URL: string = env.VITE_TURN_URL ?? ''
const FETCH_TIMEOUT = 4000
// 憑證到期前這麼久就換新的，避免房間開到一半憑證過期
const REFRESH_MARGIN = 3600

export const FALLBACK_ICE: RTCIceServer[] = env.VITE_PEER_ICE_SERVERS
  ? (JSON.parse(env.VITE_PEER_ICE_SERVERS) as RTCIceServer[])
  : [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }]

let cache: { servers: RTCIceServer[]; until: number } | null = null
let pending: Promise<RTCIceServer[]> | null = null

export function iceServers(): Promise<RTCIceServer[]> {
  if (!TURN_URL) return Promise.resolve(FALLBACK_ICE)
  if (cache && Date.now() < cache.until) return Promise.resolve(cache.servers)
  pending ??= fetchTurn().finally(() => (pending = null))
  return pending
}

async function fetchTurn(): Promise<RTCIceServer[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
  try {
    const res = await fetch(TURN_URL, { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) return FALLBACK_ICE
    const data = (await res.json()) as { iceServers?: unknown; ttl?: unknown }
    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) return FALLBACK_ICE
    const servers = data.iceServers as RTCIceServer[]
    const ttl = typeof data.ttl === 'number' ? data.ttl : 0
    if (ttl > REFRESH_MARGIN) cache = { servers, until: Date.now() + (ttl - REFRESH_MARGIN) * 1000 }
    return servers
  } catch {
    return FALLBACK_ICE // 逾時、離線、被擋：照樣用 STUN 連線
  } finally {
    clearTimeout(timer)
  }
}
