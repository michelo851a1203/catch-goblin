// 遊戲平衡參數：整體對精靈有利，但哥布林靠團隊合作與技能仍有機會獲勝
export const CONFIG = {
  matchDuration: 600, // 10 分鐘
  startCountdown: 3,
  goblinCount: 8,

  worldRadius: 115,

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
    aiSpeed: 6.2,
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
}

export type Role = 'elf' | 'goblin'
