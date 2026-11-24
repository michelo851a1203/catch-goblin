import { isShortSession } from '../platform'

// 短局版（CrazyGames、itch.io）：網頁玩家單次遊玩時間短，改成 4 分鐘一局、較小的地圖、7 隻哥布林，
// 最後 70 秒進入「最終狩獵」（精靈小地圖顯示所有哥布林），避免最後幾隻找不到而拖到時間結束。
// 數值以無頭 AI 對 AI 模擬調整（精靈勝率，種子 1000 起，短局版每格 96 場；網站版 64 場）。
// 2026-11-18 加入「打包保留進度、琴聲吸引中不能攪局、短局打包 3 秒」後重新量測；
// AI 精靈的勝率調回修改前附近（修改前：網站版 豎琴 0.30 / 紫晶 0.55，短局版 豎琴 0.31 / 紫晶 0.71）：
//                     網站版   短局版
//   豎琴・AI 精靈        0.28     0.35    ← 哥布林玩家面對的對手
//   豎琴・玩家速度精靈    0.66     0.80    ← 近似玩家操控精靈（AI 速度換成玩家速度 7.4）
//   紫晶・AI 精靈        0.55     0.71
//   紫晶・玩家速度精靈    0.83     0.84
// 紫晶精靈在短局裡原本很弱（勝率約 0.1），主要靠加強「現身恐懼」並縮短冷卻補回來；首次捕獲約在開局 35～45 秒。
// Cloudflare Pages 網站版維持原本的數值（SHORT 為 false 時每一項都和原本相同），
// 唯一例外是打包保留進度與琴聲吸引中不能攪局（兩個版本共用），網站版 AI 豎琴精靈因此把凝視距離 15 → 12 補回勝率。
const SHORT = isShortSession

// 遊戲平衡參數：整體對精靈有利，但哥布林靠團隊合作與技能仍有機會獲勝
export const CONFIG = {
  matchDuration: SHORT ? 240 : 600, // 4 分鐘 / 10 分鐘
  startCountdown: 3,
  // 最終狩獵：剩下這麼多秒時，所有哥布林的位置顯示在精靈的小地圖上（0＝關閉）
  finalHunt: SHORT ? 70 : 0,
  goblinCount: SHORT ? 7 : 8,

  worldRadius: SHORT ? 80 : 115,
  // 山洞與小徑離中央的距離倍率（地圖邊界另由 worldRadius 決定）
  mapScale: SHORT ? 0.7 : 1,

  goblin: {
    speed: 6.0,
    radius: 0.55,
    dashMultiplier: 1.85,
    dashDuration: 2,
    dashCooldown: 10,
    interfereRange: 3.2,
    interfereCooldown: 6,
    breakFreeGrace: 1.5,
  },

  elf: {
    speed: 7.4,
    // AI 豎琴精靈：短局版打包變快、被打斷會保留進度，調慢一點讓勝率維持原本附近（6.3 以下勝率會驟降，跑不贏衝刺的哥布林）
    aiSpeed: SHORT ? 6.5 : 6.2,
    aiSight: 19,
    aiReaction: 1.0,
    // 網站版的 AI 速度已經很接近哥布林（6.0），改用縮短凝視距離把勝率調回來
    aiGazeRange: SHORT ? 15 : 12,
    aiRest: 2.5,
    radius: 0.6,
    // 依射線上由近到遠的命中順序定身：第一個 2 秒、第二個 1.4 秒、其餘 1 秒（讓後面的哥布林有時間救人）
    gaze: { range: 24, width: 1.3, root: [2, 1.4, 1], cooldown: 7, beamTime: 0.5 },
    // 被琴聲吸引（attract）的哥布林不能攪局：豎琴精靈對付抱團的手段。
    // 彈奏中持續刷新，attractTime 秒從彈奏結束才開始算；AI 在目標身邊有隊友時會先彈琴再擊暈。
    // 2026-11-22 改成這樣後琴聲每次出手都很有效，冷卻 18 → 28 秒，避免沒抱團時也每次都先彈琴
    music: { radius: 17, maxChannel: 5, attractTime: 3, charmTime: 10, cooldown: 28 },
    stun: { range: 2.7, duration: 2, cooldown: 3.5 },
    // 打包：短局版縮短（4→3 秒、魅惑 2→1.5 秒），貼身的隊友仍有 1 秒以上能反應攪局。
    // 被攪局打斷時保留這次新增進度的 keep 比例（最多保留到 keepMax，至少還要再打包 50%，救人仍來得及），
    // keepTime 秒內再被打包就從保留的進度繼續；用大招掙脫則進度歸零。
    // 避免哥布林抱團輪流攪局讓打包永遠完成不了
    capture: { range: 2.8, packTime: SHORT ? 3 : 4, charmedPackTime: SHORT ? 1.5 : 2, cooldown: 1, keep: 0.5, keepMax: 0.5, keepTime: 10 },
    staggerOnInterrupt: 1.2,
  },

  // 紫晶精靈（小提琴刺客）：移動速度與預設精靈相同（比哥布林快），捕獲沿用 elf.capture。
  // 沒有近身打暈、沒有群體控場，唯一的暈眩來源是 7 秒一次的衝鋒 → 單點爆發強、抓多隻時節奏較慢
  violin: {
    // 隱身：拉琴 castTime 秒後隱身 duration 秒；手動取消或施放其他技能時，身邊的哥布林恐懼
    stealth: { castTime: 0.8, duration: 15, cooldown: SHORT ? 8 : 12, fearRadius: SHORT ? 12 : 8, fearTime: SHORT ? 4.5 : 3, fearSpeed: 0.42, revealRadius: 1.6 },
    // 刺客之眼：開圖 duration 秒（沒有瞬移就在時間到後進入冷卻）；期間再按一次瞬移到最近的哥布林身後（blinkRange＝全地圖）。
    // 瞬移後 lockTime 秒內按衝鋒＝鎖定衝鋒：自動朝最近的哥布林（衝鋒距離內）突刺並追蹤，不需要瞄準
    eye: { duration: 20, cooldown: SHORT ? 10 : 20, blinkRange: 240, behind: 1.25, lockTime: 3 },
    // 衝鋒擊暈：前搖 windup 秒後以 speed 衝刺 distance 公尺，撞到的第一隻暈 stun 秒；結束後 recover 秒收招
    charge: { windup: 0.3, distance: 9, speed: 24, hitRadius: 0.5, stun: SHORT ? 2 : 1.5, cooldown: SHORT ? 3.5 : 7, recover: 0.4 },
    // AI 紫晶精靈的移動速度（豎琴精靈用 elf.aiSpeed）
    aiSpeed: SHORT ? 7.0 : 6.2,
    // AI 開場多久之後才會開刺客之眼找人（秒）
    aiEyeAfter: SHORT ? 5 : 25,
  },
}

export type Role = 'elf' | 'goblin'
// 精靈角色：預設的豎琴精靈 / 紫晶精靈（小提琴刺客）
export type ElfKind = 'harp' | 'violin'
export const ELF_KINDS: readonly ElfKind[] = ['harp', 'violin']
export function isElfKind(v: unknown): v is ElfKind {
  return v === 'harp' || v === 'violin'
}
