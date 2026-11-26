import { CONFIG, MAP_IDS, isMapId, type MapId } from '../game/config'

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

// ───── 地形投票 ─────
// 房主按下開始後先分配好角色，再讓大家投票選地形：精靈 1.5 票、每隻哥布林 1 票，倒數 VOTE_SECONDS 秒。
// 票數最高的地形勝出；平手時從平手的地形中隨機，沒人投票時從所有地形中隨機
export const VOTE_SECONDS = 20

export function voteWeight(slot: Slot) {
  return slot === 'elf' ? 1.5 : 1
}

// votes：玩家 id → 投的地形；slots：玩家 id → 角色（不在 slots 裡的票不算，例如投完票就離開的玩家）
export function tallyVotes(votes: Record<string, MapId>, slots: Map<string, Slot>): Record<MapId, number> {
  const out = Object.fromEntries(MAP_IDS.map((m) => [m, 0])) as Record<MapId, number>
  for (const [id, map] of Object.entries(votes)) {
    const slot = slots.get(id)
    if (slot === undefined || !isMapId(map)) continue
    out[map] += voteWeight(slot)
  }
  return out
}

export function pickMap(tally: Record<MapId, number>, rand = Math.random): MapId {
  const top = Math.max(...MAP_IDS.map((m) => tally[m]))
  const best = top > 0 ? MAP_IDS.filter((m) => tally[m] === top) : [...MAP_IDS]
  return best[Math.floor(rand() * best.length)] ?? MAP_IDS[0]
}
