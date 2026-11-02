import { store } from './crazygames'
import type { Role } from './game/config'

// 只存戰績（CrazyGames 存檔，不可用時為 localStorage），遊戲本身不存檔
const KEY = 'goblin-game:stats'

export interface Stats {
  elfWins: number
  goblinWins: number
  lastRole: Role | null
}

export function loadStats(): Stats {
  try {
    const raw = store.getItem(KEY)
    if (raw) return { elfWins: 0, goblinWins: 0, lastRole: null, ...JSON.parse(raw) }
  } catch {
    /* 無痕模式等情況忽略 */
  }
  return { elfWins: 0, goblinWins: 0, lastRole: null }
}

export function recordResult(role: Role, winner: Role) {
  const s = loadStats()
  if (winner === 'elf') s.elfWins++
  else s.goblinWins++
  s.lastRole = role
  try {
    store.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}
