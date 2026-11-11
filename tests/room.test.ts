// 房間連線的狀態流程：以記憶體中的假 PeerJS（同一個行程內的房主 ⇄ 加入者）測試 Room 的大廳 / 開局 / 離開
import './sim/env'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Fn = (...a: unknown[]) => void
class Emitter {
  private h = new Map<string, Fn[]>()
  on(ev: string, fn: Fn) {
    this.h.set(ev, [...(this.h.get(ev) ?? []), fn])
    return this
  }
  once(ev: string, fn: Fn) {
    const w: Fn = (...a) => {
      this.off(ev, w)
      fn(...a)
    }
    return this.on(ev, w)
  }
  off(ev: string, fn: Fn) {
    this.h.set(ev, (this.h.get(ev) ?? []).filter((f) => f !== fn))
  }
  emit(ev: string, ...a: unknown[]) {
    for (const f of this.h.get(ev) ?? []) f(...a)
  }
}

const peers = new Map<string, FakePeer>()
let nextId = 0

class FakeConn extends Emitter {
  open = false
  other!: FakeConn
  constructor(
    public peer: string,
    public label: string,
  ) {
    super()
  }
  send(data: string) {
    if (!this.open) return
    const o = this.other
    queueMicrotask(() => o.open && o.emit('data', data))
  }
  close() {
    if (!this.open && !this.other.open) return
    this.open = false
    this.emit('close')
    if (this.other.open) this.other.close()
  }
}

class FakePeer extends Emitter {
  id: string
  disconnected = false
  destroyed = false
  conns: FakeConn[] = []
  constructor(a?: unknown) {
    super()
    this.id = typeof a === 'string' ? a : `guest-${++nextId}`
    queueMicrotask(() => {
      if (peers.has(this.id)) return this.emit('error', { type: 'unavailable-id' })
      peers.set(this.id, this)
      this.emit('open')
    })
  }
  connect(id: string, opts: { label: string }) {
    const mine = new FakeConn(id, opts.label)
    const theirs = new FakeConn(this.id, opts.label)
    mine.other = theirs
    theirs.other = mine
    this.conns.push(mine)
    queueMicrotask(() => {
      const host = peers.get(id)
      if (!host) return this.emit('error', { type: 'peer-unavailable' })
      host.conns.push(theirs)
      host.emit('connection', theirs)
      mine.open = theirs.open = true
      theirs.emit('open')
      mine.emit('open')
    })
    return mine
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    peers.delete(this.id)
    for (const c of this.conns) c.close()
  }
  reconnect() {}
}

vi.mock('peerjs', () => ({ default: FakePeer }))

const { Room } = await import('../src/net/room')
type RoomT = InstanceType<typeof Room>

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

const open: RoomT[] = []
afterEach(() => {
  for (const r of open.splice(0)) r.leave()
  peers.clear()
})

async function hostAndGuest() {
  const host = await Room.create()
  open.push(host)
  const guest = await Room.join(host.state.code)
  open.push(guest)
  await flush()
  return { host, guest }
}

describe('Room 狀態流程', () => {
  it('建立房間 → 大廳；加入 → 雙方看到兩位玩家', async () => {
    const { host, guest } = await hostAndGuest()
    expect(host.state.phase).toBe('lobby')
    expect(guest.state.phase).toBe('lobby')
    expect(host.state.players.map((p) => p.n)).toEqual([1, 2])
    expect(guest.state.players.map((p) => p.n)).toEqual([1, 2])
  })

  it('房主開局 → 雙方 playing 並收到連線介面；回到大廳', async () => {
    const { host, guest } = await hostAndGuest()
    const hs = vi.fn(), gs = vi.fn()
    host.onStart = hs
    guest.onStart = gs
    guest.setPick('elf', 'violin')
    await flush()
    host.start()
    await flush()
    expect(host.state.phase).toBe('playing')
    expect(guest.state.phase).toBe('playing')
    expect(gs.mock.calls[0][0]).toMatchObject({ host: false, me: 'elf', elfKind: 'violin' })
    expect(hs.mock.calls[0][0]).toMatchObject({ host: true, elfKind: 'violin' })
    host.backToLobby()
    guest.backToLobby()
    expect(host.state.phase).toBe('lobby')
    expect(guest.state.phase).toBe('lobby')
  })

  it('房主離開 → 加入者收到 hostLeft 並關閉', async () => {
    const { host, guest } = await hostAndGuest()
    const closed = vi.fn()
    guest.onClose = closed
    host.leave()
    await flush()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith('hostLeft')
    expect(guest.state.phase).toBe('closed')
  })

  it('自己離開：onClose(null) 只通知一次，之後開局 / 回大廳 / 選角都不再有作用', async () => {
    const { host } = await hostAndGuest()
    const closed = vi.fn(), started = vi.fn()
    host.onClose = closed
    host.onStart = started
    host.leave()
    host.leave()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith(null)
    expect(host.state.phase).toBe('closed')
    host.start()
    host.backToLobby()
    host.setPick('goblin')
    await flush()
    expect(started).not.toHaveBeenCalled()
    expect(host.state.phase).toBe('closed')
  })

  it('開局訊息的角色分配裡沒有自己：維持在大廳，不會卡在沒有連線介面的 playing', async () => {
    const { host, guest } = await hostAndGuest()
    const started = vi.fn()
    guest.onStart = started
    ;(host as unknown as { broadcast(m: object): void }).broadcast({ t: 'start', slots: [[host.state.me, 'elf']], kind: 'harp' })
    await flush()
    expect(started).not.toHaveBeenCalled()
    expect(guest.state.phase).toBe('lobby')
    expect(guest.current).toBeNull()
    guest.setPick('goblin')
    await flush()
    expect(host.state.players.find((p) => p.id === guest.state.me)?.pick).toBe('goblin')
  })

  it('房號不存在 → notFound', async () => {
    await expect(Room.join('0000')).rejects.toBe('notFound')
  })

  it('遊戲中斷線的玩家用同一個識別碼連回 → 回到原本的角色', async () => {
    const { host, guest } = await hostAndGuest()
    let link: Parameters<NonNullable<RoomT['onStart']>>[0] | null = null
    host.onStart = (l) => (link = l)
    host.start()
    await flush()
    const prev = [...link!.peers.values()][0]
    // 與 Game.onPeerRejoin 相同：把新的 peer id 對應到原本的角色
    const rejoin = vi.fn((peer: string, slot: unknown) => {
      for (const [id, s] of link!.peers) if (s === slot) link!.peers.delete(id)
      link!.peers.set(peer, slot as never)
      return slot as never
    })
    link!.onRejoin(rejoin)
    guest.leave()
    await flush()
    expect(host.state.players).toHaveLength(1)
    const back = await Room.join(host.state.code)
    open.push(back)
    await flush()
    expect(rejoin).toHaveBeenCalledTimes(1)
    expect(rejoin.mock.calls[0][1]).toBe(prev)
    expect(back.state.phase).toBe('playing')
    expect(back.current?.me).toBe(prev)
  })
})
