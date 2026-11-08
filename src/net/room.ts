import { reactive } from 'vue'
import Peer, { type DataConnection, type PeerOptions } from 'peerjs'
import { MAX_PLAYERS, assignSlots, canPick, type Pick, type Slot } from './assign'
import { store } from '../crazygames'
import { iceServers } from './ice'
import { t } from '../i18n'
import { isElfKind, type ElfKind } from '../game/config'

// 多人連線：使用 PeerJS（WebRTC P2P）。預設使用 PeerJS 的公用信令伺服器，可用 VITE_PEER_* 改成自架的 PeerServer。
// PeerJS 內建的 TURN 網域已無法解析，TURN 改由 Cloudflare 提供（見 ./ice.ts 與 worker/turn）。
// 建立房間的玩家是房主，負責整場模擬；其他玩家只傳送自己的操作，接收房主廣播的狀態。
// 房主以固定前綴 + 4 碼房號註冊 peer id，加入者直接用房號連線，所以不需要大廳列表。
const ID_PREFIX = 'elf-and-goblins-'
const env = import.meta.env
const SIGNALING: PeerOptions = env.VITE_PEER_HOST
  ? {
      host: env.VITE_PEER_HOST,
      port: Number(env.VITE_PEER_PORT) || 443,
      path: env.VITE_PEER_PATH || '/',
      key: env.VITE_PEER_KEY || 'peerjs',
      secure: true,
    }
  : {}
async function peerOptions(): Promise<PeerOptions> {
  return { ...SIGNALING, config: { iceServers: await iceServers() } }
}
// 通訊格式版本：不同版本的遊戲不能同房
const PROTO = 4
const TIMEOUT = 15000
// ICE 斷線後等待恢復的時間，超過就視為對方離線
const ICE_GRACE = 8000
const RECONNECT_DELAY = 3000
// CrazyGames 使用者名稱最長 20 字元
export const NAME_MAX = 20
const NAME_KEY = 'goblin-game.nickname'
const REJOIN_KEY = 'goblin-game.rejoin'

// 重新連線用的識別碼：同一個房號沿用上次的識別碼（關閉遊戲、斷線後重新輸入房號即可回到原本的角色）
function rejoinToken(code: string) {
  try {
    const last = JSON.parse(localStorage.getItem(REJOIN_KEY) ?? 'null') as { code?: string; token?: string } | null
    if (last?.code === code && typeof last.token === 'string') return last.token
  } catch {
    /* 格式錯誤就重新產生 */
  }
  const token = Math.random().toString(36).slice(2, 12)
  try {
    localStorage.setItem(REJOIN_KEY, JSON.stringify({ code, token }))
  } catch {
    /* 存不了就只能以新玩家身分加入 */
  }
  return token
}

// 暱稱：去掉控制字元、限制長度
export function cleanName(v: unknown) {
  return typeof v === 'string' ? [...v.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, NAME_MAX).join('') : ''
}
// 大廳顯示用：沒填暱稱時顯示「玩家N」
export function displayName(p: { n: number; name: string }) {
  return p.name || t('playerN', { n: p.n })
}
export function loadName() {
  try {
    return cleanName(store.getItem(NAME_KEY))
  } catch {
    return ''
  }
}
export function saveName(name: string) {
  try {
    store.setItem(NAME_KEY, name)
  } catch {
    /* 無痕模式等情況存不了，只影響下次預設值 */
  }
}

export type RoomError = 'full' | 'notFound' | 'started' | 'netFail' | 'hostLeft' | 'version'

export interface LobbyPlayer {
  id: string
  n: number // 玩家編號 1~9（房主是 1）
  pick: Pick
  // 選精靈時的角色（豎琴 / 紫晶）
  elf?: ElfKind
  name: string // 空字串時顯示「玩家N」
}

// 開局後交給 Game 使用的連線介面
export interface NetLink {
  host: boolean
  me: Slot
  // 這一局的精靈角色（選精靈的玩家決定；精靈由 AI 控制時由房主隨機）
  elfKind: ElfKind
  // 其他真人玩家：peer id → 角色
  peers: Map<string, Slot>
  // 角色 → 玩家編號（含自己）
  numbers: Map<Slot, number>
  // 角色 → 暱稱（含自己；沒填暱稱時為空字串）
  names: Map<Slot, string>
  // 房主：廣播給所有人；其他玩家：傳給房主
  send(msg: object, reliable: boolean): void
  listen(fn: (from: string, msg: { t: string }) => void): () => void
  onLeave(fn: (peer: string) => void): () => void
  // 房主：斷線的玩家重新連回來（prev 是原本的角色），回傳分配到的角色；回傳 null 表示不能加入
  onRejoin(fn: (peer: string, prev: Slot, name: string, n: number) => Slot | null): () => void
}

type LobbyMsg =
  | { t: 'hello'; v: number; name: string; token: string }
  | { t: 'pick'; pick: Pick; elf?: ElfKind }
  | { t: 'name'; name: string }
  | { t: 'lobby'; players: LobbyPlayer[] }
  | { t: 'reject'; why: RoomError }
  | { t: 'start'; slots: [string, Slot][]; kind?: ElfKind }

class RoomFail extends Error {
  why: RoomError
  idTaken = false // 房號已被使用（建立房間時換一個重試）
  constructor(why: RoomError) {
    super(why)
    this.why = why
  }
}

export class Room {
  readonly state = reactive({
    phase: 'connecting' as 'connecting' | 'lobby' | 'playing',
    code: '',
    host: false,
    me: '',
    players: [] as LobbyPlayer[],
  })
  // 開局（房主按下開始、或收到房主的開局訊息）
  onStart: ((link: NetLink) => void) | null = null
  // 房間關閉（被拒絕、房主離開、斷線）；自己離開時 why 為 null
  onClose: ((why: RoomError | null) => void) | null = null

  private peer: Peer
  // 每位對方兩條資料通道：reliable 與 unreliable（不保證順序，對應遊戲狀態廣播）
  private conns = new Map<string, { reliable?: DataConnection; unreliable?: DataConnection; connected: boolean; iceTimer: number }>()
  // 連線階段的 PeerJS 錯誤交給正在等待的 Promise
  private pendingFail: ((why: RoomFail) => void) | null = null
  private unload = () => this.peer.destroy()
  private hostId = ''
  private closed = false
  private gameListeners = new Set<(from: string, msg: { t: string }) => void>()
  private leaveListeners = new Set<(peer: string) => void>()
  private welcomed: (() => void) | null = null
  private name = loadName()
  private token = ''
  private link: NetLink | null = null
  private rejoinHandler: ((peer: string, prev: Slot, name: string, n: number) => Slot | null) | null = null
  // 房主：peer id → 重新連線識別碼；遊戲中斷線的玩家（識別碼 → 原本的資料）
  private tokens = new Map<string, string>()
  private dropped = new Map<string, LobbyPlayer & { slot: Slot }>()

  private constructor(opts: PeerOptions, id?: string) {
    this.peer = id ? new Peer(id, opts) : new Peer(opts)
    this.peer.on('connection', (c) => this.attachConn(c))
    this.peer.on('error', (e) => {
      const why = e.type === 'peer-unavailable' ? 'notFound' : 'netFail'
      const fail = new RoomFail(why)
      fail.idTaken = e.type === 'unavailable-id'
      this.pendingFail?.(fail)
    })
    // 只是跟信令伺服器斷線：已建立的 P2P 連線不受影響，持續嘗試連回去，新玩家與重新連線的玩家才找得到房間
    this.peer.on('disconnected', () => {
      if (this.closed) return
      setTimeout(() => {
        if (!this.closed && this.peer.disconnected && !this.peer.destroyed) this.peer.reconnect()
      }, RECONNECT_DELAY)
    })
    // 關閉分頁時主動斷線，對方才能立刻知道
    window.addEventListener('pagehide', this.unload)
  }

  // 建立房間：隨機產生沒人用的 4 碼數字房號（已被使用的 id 伺服器會拒絕）
  static async create(): Promise<Room> {
    const opts = await peerOptions()
    for (let i = 0; i < 10; i++) {
      const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
      const room = new Room(opts, ID_PREFIX + code)
      try {
        await room.ready()
        room.hostId = room.peer.id
        Object.assign(room.state, { phase: 'lobby', code, host: true, me: room.peer.id, players: [{ id: room.peer.id, n: 1, pick: 'random', name: room.name }] })
        return room
      } catch (e) {
        room.dispose()
        if (!(e instanceof RoomFail && e.idTaken)) throw e instanceof RoomFail ? e.why : 'netFail'
      }
    }
    throw 'netFail'
  }

  // 依 4 碼房號加入；失敗時丟出 RoomError（人數已滿、已開局等由房主回覆）
  static async join(code: string): Promise<Room> {
    const room = new Room(await peerOptions())
    try {
      await room.ready()
      room.hostId = ID_PREFIX + code
      room.token = rejoinToken(code)
      room.state.code = code
      room.state.me = room.peer.id
      const welcome = new Promise<void>((resolve) => (room.welcomed = resolve))
      const peerFail = new Promise<never>((_, reject) => (room.pendingFail = reject))
      room.attachConn(room.peer.connect(room.hostId, { label: 'reliable', reliable: true, serialization: 'raw' }))
      room.attachConn(room.peer.connect(room.hostId, { label: 'unreliable', reliable: false, serialization: 'raw' }))
      // 等房主回覆大廳狀態（P2P 連線建立需要一點時間）
      await Promise.race([welcome, peerFail, room.failAfter(TIMEOUT), room.closedPromise()])
      room.pendingFail = null
      return room
    } catch (e) {
      room.dispose()
      throw e instanceof RoomFail ? e.why : 'netFail'
    }
  }

  // 已開局時的連線介面（重新連線時，開局訊息可能比 onStart 設定得還早）
  get current() {
    return this.link
  }

  get isHost() {
    return this.state.host
  }

  setPick(pick: Pick, elf?: ElfKind) {
    if (this.state.phase !== 'lobby') return
    if (this.state.host) this.applyPick(this.state.me, pick, elf)
    else this.sendTo(this.hostId, { t: 'pick', pick, elf })
  }

  get myName() {
    return this.name
  }

  setName(v: string) {
    const name = cleanName(v)
    saveName(name)
    if (name === this.name) return
    this.name = name
    if (this.state.host) this.applyName(this.state.me, name)
    else this.sendTo(this.hostId, { t: 'name', name })
  }

  canPick(pick: Pick) {
    return canPick(this.state.players, this.state.me, pick)
  }

  // 房主開局
  start() {
    if (!this.state.host || this.state.phase !== 'lobby') return
    const slots = [...assignSlots(this.state.players)]
    const elfId = slots.find(([, slot]) => slot === 'elf')?.[0]
    const chosen = this.state.players.find((p) => p.id === elfId)?.elf
    const kind: ElfKind = chosen ?? (Math.random() < 0.5 ? 'harp' : 'violin')
    this.broadcast({ t: 'start', slots, kind })
    // 遊戲中房間維持可被搜尋，斷線的玩家才能用房號連回來（新玩家仍會被拒絕）
    this.begin(slots, kind)
  }

  // 一局結束後回到大廳
  backToLobby() {
    if (this.closed || this.state.phase !== 'playing') return
    this.state.phase = 'lobby'
    this.link = null
    if (this.state.host) {
      this.dropped.clear()
      this.broadcast({ t: 'lobby', players: this.state.players })
    }
  }

  leave() {
    this.close(null)
  }

  // ───────────── 內部 ─────────────
  private ready() {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RoomFail('netFail')), TIMEOUT)
      this.pendingFail = (e) => {
        clearTimeout(timer)
        reject(e)
      }
      this.peer.once('open', () => {
        clearTimeout(timer)
        this.pendingFail = null
        resolve()
      })
    })
  }

  // 兩條資料通道都打開才算連上；任一條關閉就算離線
  private attachConn(c: DataConnection) {
    const id = c.peer
    let entry = this.conns.get(id)
    if (!entry) {
      entry = { connected: false, iceTimer: 0 }
      this.conns.set(id, entry)
    }
    const e = entry
    if (c.label === 'reliable') e.reliable = c
    else if (c.label === 'unreliable') e.unreliable = c
    else return c.close()
    c.on('open', () => {
      if (e.connected || !e.reliable?.open || !e.unreliable?.open) return
      e.connected = true
      // 加入者連上房主後打招呼，由房主決定是否接受
      if (!this.state.host && id === this.hostId) this.sendTo(id, { t: 'hello', v: PROTO, name: this.name, token: this.token })
    })
    c.on('data', (data) => {
      if (typeof data !== 'string') return
      try {
        this.onMessage(id, JSON.parse(data))
      } catch {
        /* 格式錯誤的訊息直接忽略 */
      }
    })
    c.on('close', () => this.dropConn(id, e))
    c.on('error', () => {})
    c.on('iceStateChanged', (state) => {
      clearTimeout(e.iceTimer)
      if (state === 'disconnected') e.iceTimer = window.setTimeout(() => this.dropConn(id, e), ICE_GRACE)
      else if (state === 'failed' || state === 'closed') this.dropConn(id, e)
    })
  }

  private dropConn(id: string, e: { reliable?: DataConnection; unreliable?: DataConnection; iceTimer: number }) {
    if (this.conns.get(id) !== e) return
    clearTimeout(e.iceTimer)
    this.conns.delete(id)
    e.reliable?.close()
    e.unreliable?.close()
    this.onDisconnected(id)
  }

  private failAfter(ms: number) {
    return new Promise<never>((_, reject) => setTimeout(() => reject(new RoomFail('netFail')), ms))
  }

  private closedPromise() {
    return new Promise<never>((_, reject) => {
      const prev = this.onClose
      this.onClose = (why) => {
        this.onClose = prev
        reject(new RoomFail(why ?? 'netFail'))
      }
    })
  }

  private sendTo(peer: string, msg: LobbyMsg | object, reliable = true) {
    // 只看要用的那條通道：對方的 hello 可能比另一條通道的 open 事件先到
    const e = this.conns.get(peer)
    const c = reliable ? e?.reliable : e?.unreliable
    if (!c?.open) return
    try {
      void c.send(JSON.stringify(msg))
    } catch {
      /* 對方剛斷線 */
    }
  }

  private broadcast(msg: LobbyMsg | object, reliable = true) {
    for (const id of this.conns.keys()) this.sendTo(id, msg, reliable)
  }

  private onMessage(from: string, m: LobbyMsg | { t: string }) {
    const s = this.state
    if (s.host) {
      if (m.t === 'hello') {
        const v = (m as { v: number }).v
        if (v !== PROTO) return this.sendTo(from, { t: 'reject', why: 'version' })
        const token = String((m as { token?: unknown }).token ?? '').slice(0, 20)
        if (s.phase === 'playing') return this.rejoin(from, token, cleanName((m as { name?: unknown }).name))
        // 同一個識別碼已經在房間內（例如同一個瀏覽器開兩個分頁）時不記錄，避免互相頂替
        if (token && ![...this.tokens.values()].includes(token)) this.tokens.set(from, token)
        if (s.players.length >= MAX_PLAYERS) return this.sendTo(from, { t: 'reject', why: 'full' })
        if (!s.players.some((p) => p.id === from)) {
          let n = 1
          while (s.players.some((p) => p.n === n)) n++
          s.players.push({ id: from, n, pick: 'random', name: cleanName((m as { name?: unknown }).name) })
        }
        this.broadcast({ t: 'lobby', players: s.players })
        return
      }
      if (m.t === 'pick') return this.applyPick(from, (m as { pick: Pick }).pick, (m as { elf?: unknown }).elf)
      if (m.t === 'name') return this.applyName(from, cleanName((m as { name?: unknown }).name))
    } else if (from === this.hostId) {
      if (m.t === 'lobby') {
        s.players = (m as { players: LobbyPlayer[] }).players
        if (s.phase === 'connecting') s.phase = 'lobby'
        this.welcomed?.()
        this.welcomed = null
        return
      }
      if (m.t === 'reject') return this.close((m as { why: RoomError }).why)
      if (m.t === 'start') {
        // 還在結算畫面的玩家也直接進入下一局
        const kind = (m as { kind?: unknown }).kind
        if (s.players.some((p) => p.id === s.me)) this.begin((m as { slots: [string, Slot][] }).slots, isElfKind(kind) ? kind : 'harp')
        return
      }
    }
    // 其餘是遊戲中的訊息；只接受房主 ⇄ 玩家之間的通訊
    if (s.phase === 'playing' && (s.host || from === this.hostId)) for (const fn of this.gameListeners) fn(from, m)
  }

  private applyPick(id: string, pick: Pick, elf?: unknown) {
    const s = this.state
    const p = s.players.find((x) => x.id === id)
    if (p && (pick === 'elf' || pick === 'goblin' || pick === 'random') && canPick(s.players, id, pick)) {
      p.pick = pick
      if (pick === 'elf') p.elf = isElfKind(elf) ? elf : 'harp'
      else delete p.elf
    }
    // 不合法的選擇也廣播一次，讓對方畫面回到正確狀態
    this.broadcast({ t: 'lobby', players: s.players })
  }

  // 房主：遊戲中有人用房號連回來。只接受這一局中途斷線的玩家，由 Game 決定接手哪個角色
  private rejoin(from: string, token: string, name: string) {
    const s = this.state
    // 重新整理頁面時，房主可能還沒偵測到舊連線斷開：同一個識別碼連回來就先把舊連線當作離線
    const stale = token ? [...this.tokens].find(([id, tk]) => tk === token && id !== from)?.[0] : undefined
    if (stale) this.onDisconnected(stale)
    const d = token ? this.dropped.get(token) : undefined
    const link = this.link
    if (!d || !link || s.players.some((p) => p.id === from)) return this.sendTo(from, { t: 'reject', why: 'started' })
    const player = { id: from, n: d.n, pick: d.pick, name: name || d.name }
    const slot = this.rejoinHandler?.(from, d.slot, player.name, player.n) ?? null
    if (slot === null) return this.sendTo(from, { t: 'reject', why: 'started' })
    this.dropped.delete(token)
    this.tokens.set(from, token)
    s.players.push(player)
    s.players.sort((a, b) => a.n - b.n)
    this.broadcast({ t: 'lobby', players: s.players })
    this.sendTo(from, { t: 'start', slots: [[s.me, link.me], ...link.peers], kind: link.elfKind })
  }

  private applyName(id: string, name: string) {
    const s = this.state
    const p = s.players.find((x) => x.id === id)
    if (!p || p.name === name) return
    p.name = name
    this.broadcast({ t: 'lobby', players: s.players })
  }

  private onDisconnected(peer: string) {
    if (this.closed) return
    const s = this.state
    if (!s.host) {
      if (peer === this.hostId) this.close('hostLeft')
      return
    }
    const i = s.players.findIndex((p) => p.id === peer)
    const token = this.tokens.get(peer)
    this.tokens.delete(peer)
    if (i < 0) return
    const [p] = s.players.splice(i, 1)
    // 遊戲中斷線：記下原本的角色，之後可用同一個識別碼連回來
    const slot = this.link?.peers.get(peer)
    if (s.phase === 'playing' && token && slot !== undefined) this.dropped.set(token, { ...p, slot })
    this.broadcast({ t: 'lobby', players: s.players })
    for (const fn of this.leaveListeners) fn(peer)
  }

  private begin(slots: [string, Slot][], elfKind: ElfKind) {
    const s = this.state
    s.phase = 'playing'
    const all = new Map(slots)
    const numbers = new Map<Slot, number>()
    const names = new Map<Slot, string>()
    for (const p of s.players) {
      const slot = all.get(p.id)
      if (slot === undefined) continue
      numbers.set(slot, p.n)
      names.set(slot, cleanName(p.name))
    }
    const me = all.get(s.me)
    if (me === undefined) return
    all.delete(s.me)
    // 加入者只跟房主通訊，其他加入者由房主的 AI 狀態一併廣播
    const peers = s.host ? all : new Map<string, Slot>()
    this.gameListeners.clear()
    this.leaveListeners.clear()
    this.rejoinHandler = null
    this.dropped.clear()
    const link: NetLink = {
      host: s.host,
      me,
      elfKind,
      peers,
      numbers,
      names,
      send: (msg, reliable) => (s.host ? this.broadcast(msg, reliable) : this.sendTo(this.hostId, msg, reliable)),
      listen: (fn) => (this.gameListeners.add(fn), () => this.gameListeners.delete(fn)),
      onLeave: (fn) => (this.leaveListeners.add(fn), () => this.leaveListeners.delete(fn)),
      onRejoin: (fn) => ((this.rejoinHandler = fn), () => (this.rejoinHandler = null)),
    }
    this.link = link
    this.onStart?.(link)
  }

  private dispose() {
    this.closed = true
    for (const e of this.conns.values()) clearTimeout(e.iceTimer)
    window.removeEventListener('pagehide', this.unload)
    this.peer.destroy()
  }

  private close(why: RoomError | null) {
    if (this.closed) return
    this.closed = true
    this.gameListeners.clear()
    this.leaveListeners.clear()
    this.rejoinHandler = null
    this.dispose()
    this.onClose?.(why)
  }
}
