// App 的畫面狀態機：選角畫面（可疊上多人連線的 bottom sheet）/ 單機對局 / 多人對局。
// 以前由 role / link / sheet / auto / roomError 五個 ref 組合而成（例如 role 與 link 同時有值、
// sheet 關著卻留著舊的錯誤訊息）；改成單一的判別聯集，只能經由下面的轉移函式改變。
// 純函式、不依賴 Vue，方便測試。多人房間（Room）本身的連線另外保存：它在大廳（選角畫面）與多人對局之間都存在。
import type { Role } from './game/config'
import type { NetLink, RoomError } from './net/room'

// CrazyGames 的邀請 / 即時多人：直接連線，跳過建立 / 加入與暱稱的步驟
export type AutoRoom = { kind: 'create' } | { kind: 'join'; code: string }

export interface SheetState {
  auto: AutoRoom | null
  // 被拒絕 / 房主離開等原因（自己離開時為 null）
  error: RoomError | null
}

export type Screen =
  | { kind: 'menu'; sheet: SheetState | null }
  | { kind: 'solo'; role: Role }
  | { kind: 'online'; link: NetLink }

const emptySheet = (): SheetState => ({ auto: null, error: null })
export const menu = (sheet: SheetState | null = null): Screen => ({ kind: 'menu', sheet })

export interface Startup {
  // ?role=elf / goblin（測試用，直接跳過選角）
  role: Role | null
  // CrazyGames 好友邀請的房號
  invite: string | null
  // CrazyGames 即時多人
  instant: boolean
  // CrazyGames 版的新玩家：直接進入遊戲當哥布林
  newPlayer: boolean
}

// 開啟遊戲時的畫面：邀請 > 即時多人 > ?role= > 新玩家 > 選角畫面（先打開多人連線的 sheet）
export function initialScreen(s: Startup): Screen {
  if (s.invite) return invited(s.invite)
  if (s.instant) return menu({ auto: { kind: 'create' }, error: null })
  if (s.role) return { kind: 'solo', role: s.role }
  if (s.newPlayer) return { kind: 'solo', role: 'goblin' }
  return menu(emptySheet())
}

// 選角畫面按「多人連線」
export function openSheet(s: Screen): Screen {
  return s.kind === 'menu' && !s.sheet ? menu(emptySheet()) : s
}

// 收起 sheet：在房間內只是收起來（回到選角畫面用卡片選角）；不在房間時即為單機模式。清掉錯誤與自動連線
export function closeSheet(s: Screen): Screen {
  return s.kind === 'menu' && s.sheet ? menu() : s
}

// 收到好友邀請（任何畫面）：回到選角畫面並自動加入
export function invited(code: string): Screen {
  return menu({ auto: { kind: 'join', code }, error: null })
}

// 建立 / 加入房間成功：收起 sheet，左上角改為「已加入 <房號>」
export function roomAttached(s: Screen): Screen {
  return s.kind === 'menu' ? menu() : s
}

// 房主開局
export function roomStarted(link: NetLink): Screen {
  return { kind: 'online', link }
}

// 房間關閉：被拒絕 / 房主離開（why）時回到選角畫面並打開 sheet 顯示原因；自己離開則不打開
export function roomClosed(s: Screen, why: RoomError | null): Screen {
  if (s.kind === 'solo') return s
  if (why) return menu({ auto: null, error: why })
  return s.kind === 'online' ? menu() : s
}

// 多人對局結束後回到房間大廳
export function backToLobby(s: Screen): Screen {
  return s.kind === 'online' ? menu() : s
}

// 開始 / 重新開始單機對局：只能從選角畫面或單機對局進入
export function startSolo(s: Screen, role: Role): Screen {
  return s.kind === 'online' ? s : { kind: 'solo', role }
}

// 單機對局回到選角畫面
export function toMenu(s: Screen): Screen {
  return s.kind === 'solo' ? menu() : s
}
