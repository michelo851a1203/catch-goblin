import { isCrazyGames } from '../platform'

// 短局版（CrazyGames）：網頁玩家單次遊玩時間短，改成 4 分鐘一局、較小的地圖、7 隻哥布林，
// 最後 70 秒進入「最終狩獵」（精靈小地圖顯示所有哥布林），避免最後幾隻找不到而拖到時間結束。
// 數值以無頭 AI 對 AI 模擬調整到與網站版（10 分鐘）的勝率接近（精靈勝率，每格 96 場；網站版 64 場）：
//                     網站版   短局版
//   豎琴・AI 精靈        0.27     0.22    ← 哥布林玩家面對的對手
//   豎琴・玩家速度精靈    0.58     0.55    ← 近似玩家操控精靈
//   紫晶・AI 精靈        0.66     0.64
//   紫晶・玩家速度精靈    0.81     0.75
// 紫晶精靈在短局裡原本很弱（勝率約 0.1），主要靠加強「現身恐懼」並縮短冷卻補回來；首次捕獲約在開局 35～45 秒。
// Cloudflare Pages 網站版維持原本的數值（SHORT 為 false 時每一項都和原本相同）。
const SHORT = isCrazyGames

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
    aiSpeed: SHORT ? 6.8 : 6.2,
    aiSight: 19,
    aiReaction: 1.0,
    aiGazeRange: 15,
    aiRest: 2.5,
    radius: 0.6,
    // 依射線上由近到遠的命中順序定身：第一個 2 秒、第二個 1.4 秒、其餘 1 秒（讓後面的哥布林有時間救人）
    gaze: { range: 24, width: 1.3, root: [2, 1.4, 1], cooldown: 7, beamTime: 0.5 },
    music: { radius: 17, maxChannel: 5, attractTime: 3, charmTime: 10, cooldown: 18 },
    stun: { range: 2.7, duration: 2, cooldown: 3.5 },
    capture: { range: 2.8, packTime: 4, charmedPackTime: 2, cooldown: 1 },
    staggerOnInterrupt: 1.2,
  },

  // 紫晶精靈（小提琴刺客）：移動速度與預設精靈相同（比哥布林快），捕獲沿用 elf.capture。
  // 沒有近身打暈、沒有群體控場，唯一的暈眩來源是 7 秒一次的衝鋒 → 單點爆發強、抓多隻時節奏較慢
  violin: {
    // 隱身：拉琴 castTime 秒後隱身 duration 秒；手動取消或施放其他技能時，身邊的哥布林恐懼
    stealth: { castTime: 0.8, duration: 15, cooldown: SHORT ? 8 : 12, fearRadius: SHORT ? 12 : 8, fearTime: SHORT ? 4.5 : 3, fearSpeed: 0.42, revealRadius: 1.6 },
    // 刺客之眼：開圖 duration 秒（沒有瞬移就在時間到後進入冷卻）；期間再按一次瞬移到最近的哥布林身後（blinkRange＝全地圖）
    eye: { duration: 20, cooldown: SHORT ? 10 : 20, blinkRange: 240, behind: 1.25 },
    // 衝鋒擊暈：前搖 windup 秒後以 speed 衝刺 distance 公尺，撞到的第一隻暈 stun 秒；結束後 recover 秒收招
    charge: { windup: 0.5, distance: 9, speed: 24, hitRadius: 0.5, stun: SHORT ? 2 : 1.5, cooldown: SHORT ? 3.5 : 7, recover: 0.4 },
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
