import { describe, expect, it } from 'vitest'
import { MAX_PLAYERS, assignSlots, canPick, type Pick } from '../src/net/assign'

const room = (...picks: Pick[]) => picks.map((pick, i) => ({ id: `p${i}`, pick }))

describe('canPick', () => {
  it('精靈只能有一位', () => {
    const ps = room('elf', 'random')
    expect(canPick(ps, 'p1', 'elf')).toBe(false)
    expect(canPick(ps, 'p0', 'elf')).toBe(true) // 自己已經是精靈
    expect(canPick(ps, 'p1', 'goblin')).toBe(true)
  })

  it('哥布林最多 8 隻', () => {
    const ps = room('goblin', 'goblin', 'goblin', 'goblin', 'goblin', 'goblin', 'goblin', 'goblin', 'random')
    expect(ps.length).toBe(MAX_PLAYERS)
    expect(canPick(ps, 'p8', 'goblin')).toBe(false)
    expect(canPick(ps, 'p8', 'elf')).toBe(true)
  })
})

describe('assignSlots', () => {
  it('依選擇分配，精靈固定、哥布林依加入順序編號', () => {
    const s = assignSlots(room('goblin', 'elf', 'goblin'))
    expect(s.get('p1')).toBe('elf')
    expect(s.get('p0')).toBe(0)
    expect(s.get('p2')).toBe(1)
  })

  it('沒人選精靈時，從隨機的玩家中抽一位當精靈', () => {
    const s = assignSlots(room('goblin', 'random', 'random'), () => 0.99)
    expect(s.get('p2')).toBe('elf')
    expect(s.get('p0')).toBe(0)
    expect(s.get('p1')).toBe(1)
  })

  it('已有精靈時，隨機的玩家都當哥布林', () => {
    const s = assignSlots(room('random', 'elf', 'random'))
    expect(s.get('p1')).toBe('elf')
    expect([s.get('p0'), s.get('p2')]).toEqual([0, 1])
  })

  it('全員指定哥布林時沒有真人精靈（由 AI 控制）', () => {
    const s = assignSlots(room('goblin', 'goblin'))
    expect([...s.values()]).toEqual([0, 1])
  })

  it('滿房 9 人時每人都有唯一角色', () => {
    const s = assignSlots(room('random', 'random', 'goblin', 'random', 'random', 'random', 'random', 'random', 'random'))
    const slots = [...s.values()]
    expect(slots.length).toBe(9)
    expect(new Set(slots).size).toBe(9)
    expect(slots.filter((x) => x === 'elf').length).toBe(1)
    expect(slots.filter((x) => typeof x === 'number').every((x) => (x as number) >= 0 && (x as number) < 8)).toBe(true)
  })
})
