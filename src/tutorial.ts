import { store } from './crazygames'
import { loadStats } from './stats'

// 新手教學：每一張教學卡只出現一次，看過的記在 CrazyGames 存檔（不可用時為 localStorage）
const KEY = 'goblin-game:tutorial'

// move：移動與視角　goal：本局目標　dash / rescue / ult：哥布林的逃跑、救人、掙脫　combo：精靈的抓人連招
export type CoachStep = 'move' | 'goal' | 'dash' | 'rescue' | 'ult' | 'combo'
export const ALL_STEPS: readonly CoachStep[] = ['move', 'goal', 'dash', 'rescue', 'ult', 'combo']

function load(): Set<string> {
  try {
    const raw = store.getItem(KEY)
    const arr: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [])
  } catch {
    return new Set()
  }
}

function save(done: Set<string>) {
  try {
    store.setItem(KEY, JSON.stringify([...done]))
  } catch {
    /* 無痕模式等情況忽略 */
  }
}

export function stepDone(step: CoachStep) {
  return load().has(step)
}

export function markStep(step: CoachStep) {
  const done = load()
  if (done.has(step)) return
  done.add(step)
  save(done)
}

// 「略過教學」：之後都不再出現
export function skipTutorial() {
  save(new Set(ALL_STEPS))
}

// 第一次玩：沒看過任何教學卡、也沒有任何戰績
export function isNewPlayer() {
  const s = loadStats()
  return load().size === 0 && s.elfWins + s.goblinWins === 0
}
