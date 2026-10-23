import { reactive } from 'vue'
import { Network } from '@poki/netlib'
import { MAX_PLAYERS, assignSlots, canPick, type Pick, type Slot } from './assign'

// 多人連線：使用 Poki 的 netlib（WebRTC P2P）。信令伺服器與 TURN 由 Poki 免費提供，Cloudflare Pages / Poki 皆可連線。
// 建立房間的玩家是房主，負責整場模擬；其他玩家只傳送自己的操作，接收房主廣播的狀態。
// netlib 的房號由伺服器產生（英數混合），所以 4 碼數字房號存在 lobby 的 customData.room，加入時以 list() 查詢對應的 lobby。
const GAME_ID = import.meta.env.VITE_NETLIB_GAME_ID || 'ef8f2673-827f-43a0-8cb1-d64cd038294f'
// 通訊格式版本：不同版本的遊戲不能同房
const PROTO = 1
const TIMEOUT = 15000

export type RoomError = 'full' | 'notFound' | 'started' | 'netFail' | 'hostLeft' | 'version'

export interface LobbyPlayer {
  id: string
  n: number // 玩家編號 1~9（房主是 1）
  pick: Pick
}

// 開局後交給 Game 使用的連線介面
export interface NetLink {
  host: boolean
  me: Slot
  // 其他真人玩家：peer id → 角色
  peers: Map<string, Slot>
  // 角色 → 玩家編號（含自己）
  numbers: Map<Slot, number>
  // 房主：廣播給所有人；其他玩家：傳給房主
  send(msg: object, reliable: boolean): void
  listen(fn: (from: string, msg: { t: string }) => void): () => void
  onLeave(fn: (peer: string) => void): () => void
}

type LobbyMsg =
  | { t: 'hello'; v: number }
  | { t: 'pick'; pick: Pick }
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
      if (!this.state.host && peer.id === this.hostId) this.sendTo(peer.id, { t: 'hello', v: PROTO })
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
      Object.assign(room.state, { phase: 'lobby', code, host: true, me: room.net.id, players: [{ id: room.net.id, n: 1, pick: 'random' }] })
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

  get isHost() {
    return this.state.host
  }

  setPick(pick: Pick) {
    if (this.state.phase !== 'lobby') return
    if (this.state.host) this.applyPick(this.state.me, pick)
    else this.sendTo(this.hostId, { t: 'pick', pick })
  }

  canPick(pick: Pick) {
    return canPick(this.state.players, this.state.me, pick)
  }

  // 房主開局
  start() {
    if (!this.state.host || this.state.phase !== 'lobby') return
    const slots = [...assignSlots(this.state.players)]
    this.broadcast({ t: 'start', slots })
    void this.net.setLobbySettings({ public: false }).catch(() => {})
    this.begin(slots)
  }

  // 一局結束後回到大廳
  backToLobby() {
    if (this.closed || this.state.phase !== 'playing') return
    this.state.phase = 'lobby'
    if (this.state.host) {
      void this.net.setLobbySettings({ public: true }).catch(() => {})
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
        if (s.phase === 'playing') return this.sendTo(from, { t: 'reject', why: 'started' })
        if (s.players.length >= MAX_PLAYERS) return this.sendTo(from, { t: 'reject', why: 'full' })
        if (!s.players.some((p) => p.id === from)) {
          let n = 1
          while (s.players.some((p) => p.n === n)) n++
          s.players.push({ id: from, n, pick: 'random' })
        }
        this.broadcast({ t: 'lobby', players: s.players })
        return
      }
      if (m.t === 'pick') return this.applyPick(from, (m as { pick: Pick }).pick)
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

  private onDisconnected(peer: string) {
    if (this.closed) return
    const s = this.state
    if (!s.host) {
      if (peer === this.hostId) this.close('hostLeft')
      return
    }
    const i = s.players.findIndex((p) => p.id === peer)
    if (i < 0) return
    s.players.splice(i, 1)
    this.broadcast({ t: 'lobby', players: s.players })
    for (const fn of this.leaveListeners) fn(peer)
  }

  private begin(slots: [string, Slot][]) {
    const s = this.state
    s.phase = 'playing'
    const all = new Map(slots)
    const numbers = new Map<Slot, number>()
    for (const p of s.players) {
      const slot = all.get(p.id)
      if (slot !== undefined) numbers.set(slot, p.n)
    }
    const me = all.get(s.me)
    if (me === undefined) return
    all.delete(s.me)
    // 加入者只跟房主通訊，其他加入者由房主的 AI 狀態一併廣播
    const peers = s.host ? all : new Map<string, Slot>()
    this.gameListeners.clear()
    this.leaveListeners.clear()
    const link: NetLink = {
      host: s.host,
      me,
      peers,
      numbers,
      send: (msg, reliable) => (s.host ? this.broadcast(msg, reliable) : this.sendTo(this.hostId, msg, reliable)),
      listen: (fn) => (this.gameListeners.add(fn), () => this.gameListeners.delete(fn)),
      onLeave: (fn) => (this.leaveListeners.add(fn), () => this.leaveListeners.delete(fn)),
    }
    this.onStart?.(link)
  }

  private close(why: RoomError | null) {
    if (this.closed) return
    this.closed = true
    this.gameListeners.clear()
    this.leaveListeners.clear()
    this.net.close(why ?? 'left')
    this.onClose?.(why)
  }
}
