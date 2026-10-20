import type { Role } from './game/config'

// 只存戰績到 localStorage，遊戲本身不存檔
const KEY = 'goblin-game:stats'

export interface Stats {
  elfWins: number
  goblinWins: number
  lastRole: Role | null
}

export function loadStats(): Stats {
  try {
    const raw = localStorage.getItem(KEY)
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
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}
