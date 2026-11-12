import { isCrazyGames } from '../platform'

// 短局版（CrazyGames）：網頁玩家單次遊玩時間短，改成 4 分鐘一局、較小的地圖、6 隻哥布林，
// 最後 60 秒進入「最終狩獵」（精靈小地圖顯示所有哥布林），避免最後幾隻找不到而拖到時間結束。
// 以無頭 AI 對 AI 模擬（每組 12 個種子）調整：玩家速度的豎琴精靈對 6 隻 AI 哥布林約 2/3 勝率（略偏精靈）；
// 哥布林玩家面對的 AI 精靈約五五波。5 隻時精靈 9 成以上會贏、7 隻時 AI 精靈幾乎抓不完。
// Cloudflare Pages 網站版維持原本的 10 分鐘長局。
const SHORT = isCrazyGames

// 遊戲平衡參數：整體對精靈有利，但哥布林靠團隊合作與技能仍有機會獲勝
export const CONFIG = {
  matchDuration: SHORT ? 240 : 600, // 4 分鐘 / 10 分鐘
  startCountdown: 3,
  // 最終狩獵：剩下這麼多秒時，所有哥布林的位置顯示在精靈的小地圖上（0＝關閉）
  finalHunt: SHORT ? 60 : 0,
  goblinCount: SHORT ? 6 : 8,

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
    stealth: { castTime: 0.8, duration: 15, cooldown: 12, fearRadius: 8, fearTime: 3, fearSpeed: 0.42, revealRadius: 1.6 },
    // 刺客之眼：開圖 duration 秒（沒有瞬移就在時間到後進入冷卻）；期間再按一次瞬移到最近的哥布林身後（blinkRange＝全地圖）
    eye: { duration: 20, cooldown: 20, blinkRange: 240, behind: 1.25 },
    // 衝鋒擊暈：前搖 windup 秒後以 speed 衝刺 distance 公尺，撞到的第一隻暈 stun 秒；結束後 recover 秒收招
    charge: { windup: 0.5, distance: 9, speed: 24, hitRadius: 0.5, stun: 1.5, cooldown: 7, recover: 0.4 },
  },
}

export type Role = 'elf' | 'goblin'
// 精靈角色：預設的豎琴精靈 / 紫晶精靈（小提琴刺客）
export type ElfKind = 'harp' | 'violin'
export const ELF_KINDS: readonly ElfKind[] = ['harp', 'violin']
export function isElfKind(v: unknown): v is ElfKind {
  return v === 'harp' || v === 'violin'
}
