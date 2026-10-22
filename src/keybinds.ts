import type { Role } from './game/config'

// 玩家自訂鍵位，存在 localStorage
const KEY = 'goblin-game:keybinds'

export type MoveAction = 'up' | 'down' | 'left' | 'right'
export type ElfSkill = 'gaze' | 'music' | 'stun' | 'capture'
export type GoblinSkill = 'dash' | 'interfere' | 'ult'
export type Group = 'move' | Role

export interface Keybinds {
  move: Record<MoveAction, string>
  elf: Record<ElfSkill, string>
  goblin: Record<GoblinSkill, string>
}

export const DEFAULT_KEYBINDS: Keybinds = {
  move: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' },
  elf: { gaze: 'KeyQ', music: 'KeyE', stun: 'KeyF', capture: 'KeyR' },
  goblin: { dash: 'ShiftLeft', interfere: 'KeyF', ult: 'KeyR' },
}

export const ACTION_LABELS: { [G in Group]: Record<keyof Keybinds[G], string> } = {
  move: { up: '向前', down: '向後', left: '向左', right: '向右' },
  elf: { gaze: '凝視', music: '彈奏樂器', stun: '打暈', capture: '捕獲' },
  goblin: { dash: '加速', interfere: '攪局', ult: '大招・掙脫' },
}

// 系統保留鍵：Esc 取消設定／解除滑鼠鎖定，Tab 觀戰切換
export const RESERVED_KEYS = new Set(['Escape', 'Tab', 'MetaLeft', 'MetaRight'])

function clone(k: Keybinds): Keybinds {
  return { move: { ...k.move }, elf: { ...k.elf }, goblin: { ...k.goblin } }
}

export function defaultKeybinds(): Keybinds {
  return clone(DEFAULT_KEYBINDS)
}

export function loadKeybinds(): Keybinds {
  const k = defaultKeybinds()
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Keybinds>
      for (const g of ['move', 'elf', 'goblin'] as const) Object.assign(k[g], saved[g])
    }
  } catch {
    /* 無痕模式等情況忽略 */
  }
  return k
}

export function saveKeybinds(k: Keybinds) {
  try {
    localStorage.setItem(KEY, JSON.stringify(k))
  } catch {
    /* ignore */
  }
}

// 同一場遊戲中會同時生效的群組：移動鍵與該角色的技能鍵不可重複；精靈與哥布林之間可以共用
function scopeOf(group: Group): Group[] {
  return group === 'move' ? ['move', 'elf', 'goblin'] : ['move', group]
}

export interface Conflict {
  group: Group
  action: string
}

export function findConflicts(k: Keybinds, group: Group, action: string, code: string): Conflict[] {
  const out: Conflict[] = []
  for (const g of scopeOf(group)) {
    const binds = k[g] as Record<string, string>
    for (const a in binds) {
      if (g === group && a === action) continue
      if (sameKey(binds[a], code)) out.push({ group: g, action: a })
    }
  }
  return out
}

export type AssignResult = { ok: true; swapped: Conflict[] } | { ok: false; blocked: Conflict }

// 設定鍵位；若與其他動作衝突，就把對方換成原本的鍵（互換）。
// 互換後若對方又和別的群組撞鍵（例如技能鍵換到移動鍵，而舊技能鍵另一個角色也在用），則拒絕這次設定。
export function assignKey(k: Keybinds, group: Group, action: string, code: string): AssignResult {
  const binds = k[group] as Record<string, string>
  const old = binds[action]
  const conflicts = findConflicts(k, group, action, code)
  for (const c of conflicts) {
    const clash = findConflicts(k, c.group, c.action, old).find((x) => !(x.group === group && x.action === action))
    if (clash) return { ok: false, blocked: c }
  }
  for (const c of conflicts) (k[c.group] as Record<string, string>)[c.action] = old
  binds[action] = code
  return { ok: true, swapped: conflicts }
}

export function actionLabel(c: Conflict) {
  return (ACTION_LABELS[c.group] as Record<string, string>)[c.action]
}

// 左右 Shift／Ctrl／Alt 視為同一個鍵
function normalize(code: string) {
  return code.replace(/(Left|Right)$/, '')
}

export function sameKey(a: string, b: string) {
  return /^(Shift|Control|Alt)/.test(a) ? normalize(a) === normalize(b) : a === b
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6)
  const map: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    Control: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    CapsLock: 'Caps',
    Backspace: '⌫',
  }
  const n = normalize(code)
  return map[code] ?? map[n] ?? code
}
