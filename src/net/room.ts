import { reactive } from 'vue'
import { Network } from '@poki/netlib'
import { MAX_PLAYERS, assignSlots, canPick, type Pick, type Slot } from './assign'
import { t } from '../i18n'

// 多人連線：使用 Poki 的 netlib（WebRTC P2P）。信令伺服器與 TURN 由 Poki 免費提供，Cloudflare Pages / Poki 皆可連線。
// 建立房間的玩家是房主，負責整場模擬；其他玩家只傳送自己的操作，接收房主廣播的狀態。
// netlib 的房號由伺服器產生（英數混合），所以 4 碼數字房號存在 lobby 的 customData.room，加入時以 list() 查詢對應的 lobby。
const GAME_ID = import.meta.env.VITE_NETLIB_GAME_ID || 'ef8f2673-827f-43a0-8cb1-d64cd038294f'
// 通訊格式版本：不同版本的遊戲不能同房
const PROTO = 2
const TIMEOUT = 15000
export const NAME_MAX = 12
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
    return cleanName(localStorage.getItem(NAME_KEY))
  } catch {
    return ''
  }
}
export function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch {
    /* 無痕模式等情況存不了，只影響下次預設值 */
  }
}

export type RoomError = 'full' | 'notFound' | 'started' | 'netFail' | 'hostLeft' | 'version'

export interface LobbyPlayer {
  id: string
  n: number // 玩家編號 1~9（房主是 1）
  pick: Pick
  name: string // 空字串時顯示「玩家N」
}

// 開局後交給 Game 使用的連線介面
export interface NetLink {
  host: boolean
  me: Slot
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
  | { t: 'pick'; pick: Pick }
  | { t: 'name'; name: string }
  | { t: 'lobby'; players: LobbyPlayer[] }
  | { t: 'reject'; why: RoomError }
  | { t: 'start'; slots: [string, Slot][] }

class RoomFail extends Error {
  why: RoomError
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

  private net: Network
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

  private constructor() {
    this.net = new Network(GAME_ID)
    // 錯誤都在各自的請求中處理；註冊空的 listener 避免 netlib 印出 console.error
    this.net.on('signalingerror', () => {})
    this.net.on('rtcerror', () => {})
    this.net.on('failed', () => this.close('netFail'))
    this.net.on('message', (peer, _channel, data) => {
      if (typeof data !== 'string') return
      try {
        this.onMessage(peer.id, JSON.parse(data))
      } catch {
        /* 格式錯誤的訊息直接忽略 */
      }
    })
    this.net.on('connected', (peer) => {
      // 加入者連上房主後打招呼，由房主決定是否接受
      if (!this.state.host && peer.id === this.hostId) this.sendTo(peer.id, { t: 'hello', v: PROTO, name: this.name, token: this.token })
    })
    this.net.on('disconnected', (peer) => this.onDisconnected(peer.id))
  }

  // 建立房間：隨機產生沒人用的 4 碼數字房號
  static async create(): Promise<Room> {
    const room = new Room()
    try {
      await room.ready()
      let code = ''
      for (let i = 0; i < 10 && !code; i++) {
        const c = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
        if (!(await room.find(c))) code = c
      }
      if (!code) throw new RoomFail('netFail')
      await room.net.create({
        public: true,
        maxPlayers: MAX_PLAYERS,
        canUpdateBy: 'creator',
        customData: { room: code, host: room.net.id, v: PROTO },
      })
      room.hostId = room.net.id
      Object.assign(room.state, { phase: 'lobby', code, host: true, me: room.net.id, players: [{ id: room.net.id, n: 1, pick: 'random', name: room.name }] })
      return room
    } catch (e) {
      room.net.close()
      throw e instanceof RoomFail ? e.why : 'netFail'
    }
  }

  // 依 4 碼房號加入；失敗時丟出 RoomError
  static async join(code: string): Promise<Room> {
    const room = new Room()
    try {
      await room.ready()
      const entry = await room.find(code)
      if (!entry) throw new RoomFail('notFound')
      if (entry.customData?.v !== PROTO) throw new RoomFail('version')
      if (entry.playerCount >= entry.maxPlayers) throw new RoomFail('full')
      room.hostId = String(entry.customData?.host ?? '')
      room.token = rejoinToken(code)
      room.state.code = code
      room.state.me = room.net.id
      const welcome = new Promise<void>((resolve) => (room.welcomed = resolve))
      try {
        await room.net.join(entry.code)
      } catch (e) {
        const c = (e as { code?: string }).code
        throw new RoomFail(c === 'lobby-is-full' ? 'full' : c === 'lobby-not-found' ? 'notFound' : 'netFail')
      }
      // 等房主回覆大廳狀態（P2P 連線建立需要一點時間）
      await Promise.race([welcome, room.failAfter(TIMEOUT), room.closedPromise()])
      return room
    } catch (e) {
      room.closed = true
      room.net.close()
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

  setPick(pick: Pick) {
    if (this.state.phase !== 'lobby') return
    if (this.state.host) this.applyPick(this.state.me, pick)
    else this.sendTo(this.hostId, { t: 'pick', pick })
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
    this.broadcast({ t: 'start', slots })
    // 遊戲中房間維持可被搜尋，斷線的玩家才能用房號連回來（新玩家仍會被拒絕）
    this.begin(slots)
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
      this.net.once('ready', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // 房主離開後伺服器還會暫時保留空的 lobby（或改由其他人當 leader），只認房主仍在的那一個
  private async find(code: string) {
    const list = await this.net.list({ room: code }, undefined, 10)
    return list.find((l) => l.playerCount > 0 && l.leader !== undefined && l.leader === l.customData?.host)
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
    try {
      this.net.send(reliable ? 'reliable' : 'unreliable', peer, JSON.stringify(msg))
    } catch {
      /* 對方剛斷線 */
    }
  }

  private broadcast(msg: LobbyMsg | object, reliable = true) {
    try {
      this.net.broadcast(reliable ? 'reliable' : 'unreliable', JSON.stringify(msg))
    } catch {
      /* ignore */
    }
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
      if (m.t === 'pick') return this.applyPick(from, (m as { pick: Pick }).pick)
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
        if (s.players.some((p) => p.id === s.me)) this.begin((m as { slots: [string, Slot][] }).slots)
        return
      }
    }
    // 其餘是遊戲中的訊息；只接受房主 ⇄ 玩家之間的通訊
    if (s.phase === 'playing' && (s.host || from === this.hostId)) for (const fn of this.gameListeners) fn(from, m)
  }

  private applyPick(id: string, pick: Pick) {
    const s = this.state
    const p = s.players.find((x) => x.id === id)
    if (p && (pick === 'elf' || pick === 'goblin' || pick === 'random') && canPick(s.players, id, pick)) p.pick = pick
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
    this.sendTo(from, { t: 'start', slots: [[s.me, link.me], ...link.peers] })
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

  private begin(slots: [string, Slot][]) {
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

  private close(why: RoomError | null) {
    if (this.closed) return
    this.closed = true
    this.gameListeners.clear()
    this.leaveListeners.clear()
    this.rejoinHandler = null
    this.net.close(why ?? 'left')
    this.onClose?.(why)
  }
}
