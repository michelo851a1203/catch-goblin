import { describe, expect, it } from 'vitest'
import * as s from '../src/screen'
import type { NetLink } from '../src/net/room'

const link = { me: 'elf' } as unknown as NetLink
const start = (o: Partial<s.Startup> = {}) => s.initialScreen({ role: null, invite: null, instant: false, newPlayer: false, sheetOnStart: true, ...o })

describe('開啟遊戲時的畫面', () => {
  it('一般：選角畫面並打開多人連線 sheet', () => {
    expect(start()).toEqual({ kind: 'menu', sheet: { auto: null, error: null } })
  })
  it('CrazyGames 版一般開啟：選角畫面，不先打開多人 sheet（單機與多人一樣顯眼）', () => {
    expect(start({ sheetOnStart: false })).toEqual({ kind: 'menu', sheet: null })
    // 邀請與即時多人仍然直接打開
    expect(start({ sheetOnStart: false, invite: '123456' }).kind).toBe('menu')
    expect((start({ sheetOnStart: false, instant: true }) as { sheet: unknown }).sheet).not.toBeNull()
  })
  it('?role=：直接進入單機對局，不開 sheet', () => {
    expect(start({ role: 'elf' })).toEqual({ kind: 'solo', role: 'elf' })
  })
  it('CrazyGames 新玩家：直接當哥布林', () => {
    expect(start({ newPlayer: true })).toEqual({ kind: 'solo', role: 'goblin' })
  })
  it('好友邀請優先於一切：自動加入房間', () => {
    expect(start({ invite: '123456', role: 'elf', newPlayer: true, instant: true })).toEqual({
      kind: 'menu',
      sheet: { auto: { kind: 'join', code: '123456' }, error: null },
    })
  })
  it('即時多人優先於 ?role= 與新玩家：自動建立房間', () => {
    expect(start({ instant: true, role: 'elf', newPlayer: true })).toEqual({ kind: 'menu', sheet: { auto: { kind: 'create' }, error: null } })
  })
})

describe('畫面轉移', () => {
  it('sheet：打開 / 收起；收起時清掉錯誤與自動連線', () => {
    const closed = s.menu()
    expect(s.openSheet(closed)).toEqual({ kind: 'menu', sheet: { auto: null, error: null } })
    expect(s.closeSheet(s.menu({ auto: { kind: 'create' }, error: 'full' as never }))).toEqual(s.menu())
    // 已經打開時不覆蓋（保留錯誤訊息）
    const withErr = s.menu({ auto: null, error: 'full' as never })
    expect(s.openSheet(withErr)).toBe(withErr)
  })

  it('單機：選角 → 對局 → 再來一局 → 回選角', () => {
    const solo = s.startSolo(s.menu(), 'goblin')
    expect(solo).toEqual({ kind: 'solo', role: 'goblin' })
    expect(s.startSolo(solo, 'goblin')).toEqual(solo)
    expect(s.toMenu(solo)).toEqual(s.menu())
  })

  it('多人：加入房間 → 開局 → 回大廳 → 再開局 → 離開', () => {
    let x = s.roomAttached(s.menu({ auto: { kind: 'join', code: '1' }, error: null }))
    expect(x).toEqual(s.menu())
    x = s.roomStarted(link)
    expect(x).toEqual({ kind: 'online', link })
    x = s.backToLobby(x)
    expect(x).toEqual(s.menu())
    x = s.roomStarted(link)
    // 自己離開：回到選角畫面、不打開 sheet
    expect(s.roomClosed(x, null)).toEqual(s.menu())
  })

  it('房主離開 / 被拒絕：回到選角畫面並打開 sheet 顯示原因', () => {
    expect(s.roomClosed(s.roomStarted(link), 'hostLeft' as never)).toEqual(s.menu({ auto: null, error: 'hostLeft' as never }))
    expect(s.roomClosed(s.menu(), 'full' as never)).toEqual(s.menu({ auto: null, error: 'full' as never }))
  })

  it('大廳中自己離開：保持目前的 sheet 狀態', () => {
    const m = s.menu()
    expect(s.roomClosed(m, null)).toBe(m)
  })

  it('多人對局中不會被單機開局取代', () => {
    const on = s.roomStarted(link)
    expect(s.startSolo(on, 'elf')).toBe(on)
    expect(s.toMenu(on)).toBe(on)
  })

  it('收到好友邀請（不論目前畫面）：回到選角畫面並自動加入', () => {
    expect(s.invited('42')).toEqual({ kind: 'menu', sheet: { auto: { kind: 'join', code: '42' }, error: null } })
  })

  it('不合法的轉移保持原狀', () => {
    const solo = s.startSolo(s.menu(), 'elf')
    expect(s.closeSheet(solo)).toBe(solo)
    expect(s.openSheet(solo)).toBe(solo)
    expect(s.backToLobby(solo)).toBe(solo)
    expect(s.roomAttached(solo)).toBe(solo)
    expect(s.roomClosed(solo, 'hostLeft' as never)).toBe(solo)
  })
})
