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
  // 在通道打開前就被關閉（真的 PeerJS 會中止連線）
  closed = false
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
    this.closed = true
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
      if (theirs.closed) return
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

// 房主按下開始 → 投票選地形 → 全員投完後（稍等 1.2 秒）開局
async function startAndVote(rooms: RoomT[], map: 'meadow' | 'mushroom' = 'meadow') {
  rooms[0].start()
  await flush()
  for (const r of rooms) r.vote(map)
  await flush()
  await wait(1300)
  await flush()
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
    await startAndVote([host, guest], 'mushroom')
    expect(host.state.phase).toBe('playing')
    expect(guest.state.phase).toBe('playing')
    expect(gs.mock.calls[0][0]).toMatchObject({ host: false, me: 'elf', elfKind: 'violin', map: 'mushroom' })
    expect(hs.mock.calls[0][0]).toMatchObject({ host: true, elfKind: 'violin', map: 'mushroom' })
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
    await expect(Room.join('000000')).rejects.toBe('notFound')
  })

  it('遊戲中斷線的玩家用同一個識別碼連回 → 回到原本的角色', async () => {
    const { host, guest } = await hostAndGuest()
    let link: Parameters<NonNullable<RoomT['onStart']>>[0] | null = null
    host.onStart = (l) => (link = l)
    await startAndVote([host, guest], 'mushroom')
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
    // 連回來的玩家也拿到同一張地圖
    expect(back.current?.map).toBe('mushroom')
  })
})

describe('Room 投票選地形', () => {
  async function three() {
    const { host, guest } = await hostAndGuest()
    const g2 = await Room.join(host.state.code)
    open.push(g2)
    await flush()
    return { host, guest, g2 }
  }

  it('房主按下開始 → 全員進入投票，角色已分配好，選角時沒有倒數；倒數 20 秒', async () => {
    const { host, guest } = await hostAndGuest()
    guest.setPick('elf')
    await flush()
    const started = vi.fn()
    host.onStart = started
    host.start()
    await flush()
    expect(host.state.phase).toBe('voting')
    expect(guest.state.phase).toBe('voting')
    expect(started).not.toHaveBeenCalled()
    expect(guest.mySlot).toBe('elf')
    expect(host.mySlot).toBe(0)
    const left = guest.state.vote!.endsAt - Date.now()
    expect(left).toBeGreaterThan(19000)
    expect(left).toBeLessThanOrEqual(20000)
    // 投票中不能再選角
    guest.setPick('goblin')
    await flush()
    expect(host.state.players.find((p) => p.id === guest.state.me)?.pick).toBe('elf')
  })

  it('精靈 1.5 票勝過 1 隻哥布林；兩隻哥布林（2 票）勝過精靈', async () => {
    {
      const { host, guest } = await hostAndGuest()
      guest.setPick('elf')
      await flush()
      const got = vi.fn()
      guest.onStart = got
      host.start()
      await flush()
      guest.vote('mushroom')
      host.vote('meadow')
      await flush()
      expect(host.state.vote?.votes).toEqual({ [guest.state.me]: 'mushroom', [host.state.me]: 'meadow' })
      await wait(1300)
      await flush()
      expect(got.mock.calls[0][0].map).toBe('mushroom')
      for (const r of open.splice(0)) r.leave()
      peers.clear()
    }
    const { host, guest, g2 } = await three()
    guest.setPick('elf')
    await flush()
    const got = vi.fn()
    host.onStart = got
    host.start()
    await flush()
    guest.vote('mushroom')
    host.vote('meadow')
    g2.vote('meadow')
    await wait(1300)
    await flush()
    expect(got.mock.calls[0][0].map).toBe('meadow')
  })

  it('可以改票；倒數結束時沒人投票 → 隨機地形', async () => {
    const { host, guest } = await hostAndGuest()
    const got = vi.fn()
    guest.onStart = got
    host.start()
    await flush()
    guest.vote('mushroom')
    await flush()
    guest.vote('meadow')
    await flush()
    expect(host.state.vote?.votes[guest.state.me]).toBe('meadow')
    delete host.state.vote!.votes[guest.state.me]
    ;(host as unknown as { finishVote(): void }).finishVote()
    await flush()
    expect(['meadow', 'mushroom']).toContain(got.mock.calls[0][0].map)
    expect(guest.state.phase).toBe('playing')
  })

  it('投票中離開：收回這一票，開局時不分配角色給離開的人；投票中新玩家不能加入', async () => {
    const { host, guest, g2 } = await three()
    const got = vi.fn()
    host.onStart = got
    host.start()
    await flush()
    g2.vote('mushroom')
    await flush()
    const g2id = g2.state.me
    g2.leave()
    await flush()
    expect(host.state.vote?.votes[g2id]).toBeUndefined()
    await expect(Room.join(host.state.code)).rejects.toBe('started')
    host.vote('meadow')
    guest.vote('meadow')
    await wait(1300)
    await flush()
    const link = got.mock.calls[0][0]
    expect(link.map).toBe('meadow')
    expect([...link.peers.keys()]).toEqual([guest.state.me])
  })

  it('還在結算畫面的玩家收到投票就進入投票（回到大廳後再開局）', async () => {
    const { host, guest } = await hostAndGuest()
    await startAndVote([host, guest])
    expect(guest.state.phase).toBe('playing')
    host.backToLobby()
    host.start()
    await flush()
    expect(guest.state.phase).toBe('voting')
    expect(guest.current).toBeNull()
  })
})

describe('Room 資安', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const conns = (r: RoomT) => (r as unknown as { conns: Map<string, unknown> }).conns

  it('房號為 6 碼數字', async () => {
    const host = await Room.create()
    open.push(host)
    expect(host.state.code).toMatch(/^\d{6}$/)
  })

  it('房主踢人：對方收到 kicked 並關閉，之後用同一個識別碼也加不回來', async () => {
    const { host, guest } = await hostAndGuest()
    const closed = vi.fn()
    guest.onClose = closed
    host.kick(guest.state.me)
    host.kick(host.state.me) // 不能踢自己
    await flush()
    expect(closed).toHaveBeenCalledWith('kicked')
    await wait(1100)
    expect(host.state.players).toHaveLength(1)
    await expect(Room.join(host.state.code)).rejects.toBe('kicked')
  })

  it('同一個 peer 不斷重開通道：超過上限就整個斷開，不會在房主端累積連線', async () => {
    const host = await Room.create()
    open.push(host)
    const bad = new FakePeer('attacker')
    await flush()
    const opened: FakeConn[] = []
    for (let i = 0; i < 10; i++) opened.push(bad.connect(host.peer.id, { label: 'reliable' }))
    await flush()
    expect(conns(host).size).toBe(0)
    // 被取代的舊通道都已關閉
    expect(opened.filter((c) => c.open).length).toBe(0)
  })

  it('被取代的舊通道送來的訊息不處理（不會變成沒有連線的幽靈玩家）', async () => {
    const host = await Room.create()
    open.push(host)
    const bad = new FakePeer('ghost')
    await flush()
    const old = bad.connect(host.peer.id, { label: 'reliable' })
    await flush()
    const fresh = bad.connect(host.peer.id, { label: 'reliable' })
    await flush()
    expect(old.open).toBe(false)
    expect(fresh.open).toBe(true)
  })

  it('加入者不接受陌生人直接連進來', async () => {
    const { guest } = await hostAndGuest()
    const stranger = new FakePeer('stranger')
    await flush()
    const c = stranger.connect(guest.state.me, { label: 'reliable' })
    await flush()
    expect(c.open).toBe(false)
  })
})
