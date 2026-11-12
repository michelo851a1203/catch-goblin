// 執行平台判斷。同一份建置同時部署到 CrazyGames 與 Cloudflare Pages，以網域區分版本。
// CrazyGames：遊戲檔案放在 <slug>.game-files.crazygames.com（也包含地區網域）；本機（localhost）預設視為 CrazyGames，方便用 SDK 的 local 模式測試。
// 開發時可用 VITE_PLATFORM 強制指定版本（bun run dev:cloudflare / bun run dev:crazygame），正式建置不設定、一律依網域判斷
const forced: string | undefined = import.meta.env?.VITE_PLATFORM

export function onCrazyGames(host: string) {
  if (forced === 'cloudflare') return false
  if (forced === 'crazygames') return true
  return /(^|\.)crazygames\.[a-z]{2,}(\.[a-z]{2})?$/i.test(host) || host === 'localhost' || host === '127.0.0.1'
}

export const isCrazyGames = typeof location !== 'undefined' && onCrazyGames(location.hostname ?? '')
