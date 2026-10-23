import { CONFIG } from '../game/config'

// 多人房間的角色分配（純函式，方便測試）
export type Pick = 'elf' | 'goblin' | 'random'
// 'elf' 或哥布林編號（0 ~ goblinCount-1）
export type Slot = 'elf' | number

export const MAX_PLAYERS = CONFIG.goblinCount + 1

// 某位玩家能否選擇該陣營：精靈只有一位、哥布林最多 goblinCount 隻
export function canPick(players: { id: string; pick: Pick }[], id: string, pick: Pick, goblins = CONFIG.goblinCount) {
  const others = players.filter((p) => p.id !== id)
  if (pick === 'elf') return !others.some((p) => p.pick === 'elf')
  if (pick === 'goblin') return others.filter((p) => p.pick === 'goblin').length < goblins
  return true
}

// 選了精靈 / 哥布林的照選擇；選隨機的人中，若還沒有人當精靈就先抽一位當精靈，其餘當哥布林。
// 全員都指定哥布林時，精靈由 AI 控制。真人哥布林依加入順序取得編號 0、1、2…，其餘編號由 AI 控制
export function assignSlots(players: { id: string; pick: Pick }[], rand = Math.random): Map<string, Slot> {
  const out = new Map<string, Slot>()
  const randoms: string[] = []
  const goblins: string[] = []
  let elf = ''
  for (const p of players) {
    if (p.pick === 'elf' && !elf) elf = p.id
    else if (p.pick === 'goblin' && goblins.length < CONFIG.goblinCount) goblins.push(p.id)
    else randoms.push(p.id)
  }
  if (!elf && randoms.length) elf = randoms.splice(Math.floor(rand() * randoms.length), 1)[0]
  if (elf) out.set(elf, 'elf')
  // 隨機的人保持加入順序，與指定哥布林的人一起依序編號
  const order = players.map((p) => p.id).filter((id) => goblins.includes(id) || randoms.includes(id))
  order.forEach((id, i) => out.set(id, i))
  return out
}
