// 執行平台判斷。同一份建置同時部署到 CrazyGames、itch.io 與 Cloudflare Pages，以網域區分版本。
// CrazyGames：遊戲檔案放在 <slug>.game-files.crazygames.com（也包含地區網域）；本機（localhost）預設視為 CrazyGames，方便用 SDK 的 local 模式測試。
// itch.io：HTML5 遊戲在 iframe 裡執行，檔案放在 html-classic.itch.zone（遊戲頁面本身在 <user>.itch.io）。
// 開發時可用 VITE_PLATFORM 強制指定版本（bun run dev:cloudflare / dev:crazygame / dev:itch），正式建置不設定、一律依網域判斷
const forced: string | undefined = import.meta.env?.VITE_PLATFORM

export function onCrazyGames(host: string) {
  if (forced) return forced === 'crazygames'
  return /(^|\.)crazygames\.[a-z]{2,}(\.[a-z]{2})?$/i.test(host) || host === 'localhost' || host === '127.0.0.1'
}

export function onItch(host: string) {
  if (forced) return forced === 'itch'
  return /(^|\.)itch\.(zone|io)$/i.test(host)
}

const host = typeof location !== 'undefined' ? (location.hostname ?? '') : ''
export const isCrazyGames = typeof location !== 'undefined' && onCrazyGames(host)
export const isItch = typeof location !== 'undefined' && onItch(host)

// 短局玩法（4 分鐘、小地圖、7 隻哥布林、最終狩獵、新玩家直接進遊戲）：遊戲入口站的玩家單次遊玩時間短。
// 只影響玩法；畫質不受影響（高畫質只在 CrazyGames 延後到第一局開始後才載入，見 crazygames.afterFirstGameplay）
export const isShortSession = isCrazyGames || isItch

// 嵌在入口站的 iframe 裡：Esc 會退出平台的全螢幕，所以不用 Esc 當遊戲按鍵、不提供滑鼠鎖定（技能不需要鎖定也能用滑鼠施放）；
// 也不顯示「加入主畫面」引導（加入的會是入口站的頁面，不是遊戲）
export const isEmbedded = isCrazyGames || isItch
