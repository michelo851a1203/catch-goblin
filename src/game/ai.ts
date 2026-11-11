import * as THREE from 'three'
import { CONFIG } from './config'
import type { Goblin } from './entities'
import type { Game } from './Game'

const tmp = new THREE.Vector3()
// 哥布林被打包時的大招決策：還沒決定 / 決定不放（倒數不會歸零）
const ULT_UNDECIDED = -1
const ULT_NEVER = 999
const tmp2 = new THREE.Vector3()

function dist2d(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

// ───────────────────────── 哥布林 AI ─────────────────────────
export function updateGoblinAI(game: Game, g: Goblin, dt: number) {
  const ai = g.ai
  const elf = game.elf
  g.wish.set(0, 0, 0)
  ai.fear -= dt
  ai.relocateT -= dt
  ai.wanderT -= dt

  const d = dist2d(g.pos, elf.pos)
  const sameCave = g.zone >= 0 && g.zone === elf.zone // 被動：哥布林雷達
  // 隱身的紫晶精靈：看不到、雷達也偵測不到，除非幾乎撞上
  const sees = elf.stealthed
    ? d < CONFIG.violin.stealth.revealRadius
    : sameCave || d < 6 || (d < 24 && game.world.lineOfSight(g.pos, elf.pos))
  if (sees) {
    ai.fear = 5
    ai.lastElf = elf.pos.clone()
  }

  // 被打包時：考慮使用大招
  if (g.held) {
    if (ai.ultDelay < 0) ai.ultDelay = !g.ultUsed && Math.random() < 0.5 ? 0.5 + Math.random() * 1.3 : ULT_NEVER
    ai.ultDelay -= dt
    if (ai.ultDelay <= 0) game.goblinUlt(g)
    return
  }
  ai.ultDelay = ULT_UNDECIDED
  if (g.stun > 0 || g.rooted > 0 || g.attract > 0 || g.terror > 0) return

  const packing = elf.packing
  if (packing && packing.g !== g) {
    if (ai.rescueId !== game.packId) {
      ai.rescueId = game.packId
      ai.rescuing = d < 30 && Math.random() < 0.6
    }
    if (ai.rescuing) {
      const dir = game.navigate(g, elf.pos)
      g.wish.copy(dir)
      if (d > 7 && g.dashCd <= 0) game.goblinDash(g)
      if (d < CONFIG.goblin.interfereRange - 0.3 && g.interfereCd <= 0) game.goblinInterfere(g)
      return
    }
  } else ai.rescuing = false

  if (ai.fear > 0 && ai.lastElf) {
    flee(game, g, ai.lastElf, d)
    return
  }

  // 閒晃：在自己的洞裡群聚，偶爾搬家到別的洞
  if (ai.relocateT <= 0 && !ai.relocating) {
    const others = game.world.caves.filter((c) => c.id !== g.homeCave)
    const c = others[Math.floor(Math.random() * others.length)]
    g.homeCave = c.id
    ai.relocating = true
    ai.target = c.center.clone().add(tmp.set(Math.random() * 6 - 3, 0, Math.random() * 6 - 3))
  }
  const home = game.world.caves[g.homeCave]
  if (ai.relocating) {
    if (ai.target && dist2d(g.pos, ai.target) < 2.5) {
      ai.relocating = false
      ai.relocateT = 60 + Math.random() * 90
    }
  } else if (!ai.target || ai.wanderT <= 0 || dist2d(g.pos, ai.target) < 1) {
    const a = Math.random() * Math.PI * 2
    const r = 3 + Math.random() * (home.radius - 6)
    ai.target = new THREE.Vector3(home.center.x + Math.cos(a) * r, 0, home.center.z + Math.sin(a) * r)
    ai.wanderT = 3 + Math.random() * 5
    ai.walk = Math.random() < 0.3 ? 0 : 0.4
  }
  if (ai.target) {
    const dir = game.navigate(g, ai.target)
    g.wish.copy(dir).multiplyScalar(ai.relocating ? 0.85 : ai.walk)
  }
}

function flee(game: Game, g: Goblin, elfPos: THREE.Vector3, d: number) {
  const world = game.world
  const elf = game.elf
  let target: THREE.Vector3
  if (g.zone >= 0 && (elf.zone === g.zone || d < 9)) {
    // 精靈闖進來了：從遠離精靈的洞口逃到最遠的洞
    target = farthestCave(game, g, elfPos)
  } else if (g.zone >= 0) {
    // 精靈在外面：躲到洞內遠離精靈的一側
    const c = world.caves[g.zone]
    tmp.subVectors(c.center, elfPos).setY(0).normalize()
    target = tmp2.copy(c.center).addScaledVector(tmp, c.radius * 0.55).clone()
  } else {
    target = farthestCave(game, g, elfPos)
  }
  const dir = game.navigate(g, target, elfPos)
  if (d < 13) {
    tmp.subVectors(g.pos, elfPos).setY(0).normalize()
    const k = ((13 - d) / 13) * 1.2
    if (dir.dot(tmp) < 0.2) dir.addScaledVector(tmp, k).normalize()
  }
  g.wish.copy(dir)
  if (d < 8 && g.dashCd <= 0) game.goblinDash(g)
}

function farthestCave(game: Game, g: Goblin, elfPos: THREE.Vector3) {
  let best = game.world.caves[0]
  let score = -Infinity
  for (const c of game.world.caves) {
    if (c.id === game.elf.zone) continue
    if (c.id === g.zone && game.elf.zone === g.zone) continue
    const s = dist2d(c.center, elfPos) - 1.2 * dist2d(c.center, g.pos)
    if (s > score) {
      score = s
      best = c
    }
  }
  return best.center
}

// ───────────────────────── 精靈 AI ─────────────────────────
export function updateElfAI(game: Game, dt: number) {
  const elf = game.elf
  const ai = elf.ai
  elf.wish.set(0, 0, 0)
  if (elf.kind === 'violin') return updateVioletAI(game, dt)
  if (elf.stagger > 0 || elf.packing) return
  if (elf.channel >= 0) {
    if (elf.channel > ai.plannedChannel) game.elfStopMusic()
    return
  }
  const E = CONFIG.elf
  const now = game.elapsed
  senseGoblins(game)

  ai.think -= dt
  if (ai.think <= 0) {
    ai.think = 0.2
    // 選擇目標：看得到的，優先暈眩/定身的、最近的
    let best: Goblin | null = null
    let bestScore = Infinity
    for (const [g, rec] of ai.seen) {
      if (now - rec.at > 0.3) continue
      let s = dist2d(g.pos, elf.pos)
      if (g.stun > 0) s -= 12
      if (g.rooted > 0) s -= 6
      if (g === ai.target) s -= 4
      if (g.grace > 0) s += 6
      if (s < bestScore) {
        bestScore = s
        best = g
      }
    }
    ai.target = best
  }

  const t = ai.target
  if (t && !t.captured) {
    const rec = ai.seen.get(t)
    const d = dist2d(t.pos, elf.pos)
    const visibleFor = rec ? now - rec.since : 0
    faceTo(elf, t.pos)
    if (t.stun > 0 && !t.held) {
      if (d < E.capture.range - 0.3 && elf.cd.capture <= 0) {
        game.elfStartCapture()
        return
      }
    } else if (d < E.stun.range - 0.4 && elf.cd.stun <= 0 && t.grace <= 0 && !t.held) {
      game.elfStun()
    } else if (
      elf.cd.gaze <= 0 && d > 3.5 && d < E.aiGazeRange && visibleFor > E.aiReaction && t.rooted <= 0 && t.stun <= 0 && t.grace <= 0 &&
      game.world.lineOfSight(elf.pos, t.pos)
    ) {
      game.elfGaze(tmp.subVectors(t.pos, elf.pos).setY(0).normalize())
    } else if (elf.cd.music <= 0) {
      const near = game.goblins.filter((g) => !g.captured && dist2d(g.pos, elf.pos) < E.music.radius * 0.8).length
      const hiding = t.zone >= 0 && t.zone !== elf.zone && d < 14 && elf.cd.gaze > 2
      if (near >= 2 || hiding) {
        ai.plannedChannel = 2.2 + Math.random() * 1.3
        game.elfStartMusic()
        return
      }
    }
    // 追擊並預判
    tmp.copy(t.pos).addScaledVector(t.vel, Math.min(0.6, d / 12))
    elf.wish.copy(game.navigate(elf, tmp))
    if (t.stun > 0 || t.rooted > 0) elf.wish.multiplyScalar(1)
    return
  }

  if (chaseLastSeen(game)) return
  // 豎琴精靈巡邏時會聽到洞外的哥布林
  patrol(game, dt, true)
}

// ───────────────────────── 紫晶精靈 AI ─────────────────────────
// 刺客打法：巡邏時隱身靠近 → 近距離衝鋒擊暈 → 捕獲；找不到目標時開刺客之眼，太遠就瞬移過去
// 視覺（兩種精靈共用）：前方視野 + 視線；刺客之眼開圖中全部看得到
function senseGoblins(game: Game) {
  const elf = game.elf
  const ai = elf.ai
  const E = CONFIG.elf
  const now = game.elapsed
  const fwdX = Math.sin(elf.yaw), fwdZ = Math.cos(elf.yaw)
  for (const g of game.goblins) {
    if (g.captured) {
      ai.seen.delete(g)
      continue
    }
    const dx = g.pos.x - elf.pos.x, dz = g.pos.z - elf.pos.z
    const d = Math.hypot(dx, dz)
    const facing = (dx * fwdX + dz * fwdZ) / (d || 1)
    // 刺客之眼開圖中：全部看得到
    const visible = elf.eye > 0 || d < 4 || (d < E.aiSight && (facing > 0.35 || d < 9) && game.world.lineOfSight(elf.pos, g.pos))
    const rec = ai.seen.get(g)
    if (visible) {
      if (rec && now - rec.at < 0.5) {
        rec.pos.copy(g.pos)
        rec.at = now
      } else ai.seen.set(g, { pos: g.pos.clone(), at: now, since: now })
    }
  }
}

function updateVioletAI(game: Game, dt: number) {
  const elf = game.elf
  const ai = elf.ai
  const V = CONFIG.violin
  const E = CONFIG.elf
  const now = game.elapsed
  if (elf.stagger > 0 || elf.packing || elf.stealthCast >= 0) return
  if (elf.charge) {
    // 收招中撞到的哥布林就在面前：直接捕獲（取消收招）
    const hit = elf.charge.phase === 'recover' && elf.charge.hit >= 0 ? game.goblins[elf.charge.hit] : null
    if (hit && hit.stun > 0 && !hit.held && elf.cd.capture <= 0) game.elfStartCapture()
    return
  }
  senseGoblins(game)

  ai.think -= dt
  if (ai.think <= 0) {
    ai.think = 0.2
    let best: Goblin | null = null
    let bestScore = Infinity
    for (const [g, rec] of ai.seen) {
      if (now - rec.at > 0.3 || g.held) continue
      let s = dist2d(g.pos, elf.pos)
      if (g.stun > 0) s -= 12
      if (g.terror > 0) s -= 5
      // 刺客：偏好落單的目標（身邊同伴越多，捕獲時越容易被攪局）
      for (const o of game.goblins) if (o !== g && !o.captured && !o.disabled && dist2d(o.pos, g.pos) < 9) s += 3
      if (g === ai.target) s -= 4
      if (g.grace > 0) s += 6
      if (s < bestScore) {
        bestScore = s
        best = g
      }
    }
    ai.target = best
  }

  const t = ai.target
  if (t && !t.captured && !t.held) {
    const rec = ai.seen.get(t)
    const d = dist2d(t.pos, elf.pos)
    const visibleFor = rec ? now - rec.since : 0
    faceTo(elf, t.pos)
    // 目標還遠：先隱身再摸過去（衝鋒時現身，順便嚇住旁邊想救人的哥布林）
    if (!elf.stealthed && elf.cd.stealth <= 0 && d > 11 && t.stun <= 0) {
      game.violinStealth()
      return
    }
    if (t.stun > 0) {
      if (d < E.capture.range - 0.3 && elf.cd.capture <= 0) {
        game.elfStartCapture()
        return
      }
    } else if (
      elf.cd.charge <= 0 && t.grace <= 0 && d < V.charge.distance - 1 && (visibleFor > E.aiReaction * 0.6 || elf.stealthed || d < 3) &&
      game.world.lineOfSight(elf.pos, t.pos)
    ) {
      // 預判：衝鋒前搖 0.5 秒，瞄準哥布林屆時的位置（恐懼中的哥布林走得很慢）
      const lead = t.terror > 0 ? 0.3 : 0.45
      tmp.copy(t.pos).addScaledVector(t.vel, lead).sub(elf.pos).setY(0)
      if (tmp.lengthSq() > 0.01) {
        game.violinCharge(tmp.normalize())
        return
      }
    } else if (elf.stealthed && d < V.stealth.fearRadius - 1.5 && elf.cd.charge > 1.5) {
      // 隱身摸到身邊但衝鋒還在冷卻：現身嚇住一群，等衝鋒好了再撞
      game.violinStealth()
    }
    // 開圖中目標很遠：瞬移
    if (elf.eye > 0 && d > 14) {
      game.violinEye()
      return
    }
    tmp.copy(t.pos).addScaledVector(t.vel, Math.min(0.6, d / 12))
    elf.wish.copy(game.navigate(elf, tmp))
    return
  }

  // 沒有目標：先隱身巡邏；隱身用完才開刺客之眼找人，開圖中瞬移到最近的哥布林身後（衝鋒好了才瞬移）
  if (elf.eye > 0) {
    if (V.eye.duration - elf.eye > 0.8 && elf.cd.charge <= 0.5) game.violinEye()
    return
  }
  if (!elf.stealthed && elf.cd.stealth <= 0 && ai.patrolWait <= 0) {
    game.violinStealth()
    return
  }
  if (elf.cd.eye <= 0 && now > 25 && !elf.stealthed && elf.cd.charge <= 2) {
    game.violinEye()
    return
  }

  if (chaseLastSeen(game)) return
  patrol(game, dt, false)
}

// 沒有目標時走向記憶中最後看到哥布林的位置（7 秒內）；有地方可去時回傳 true
function chaseLastSeen(game: Game) {
  const elf = game.elf
  const now = game.elapsed
  let lastPos: THREE.Vector3 | null = null
  let lastAt = -Infinity
  for (const [, rec] of elf.ai.seen) {
    if (rec.at > lastAt && now - rec.at < 7) {
      lastAt = rec.at
      lastPos = rec.pos
    }
  }
  if (lastPos && dist2d(lastPos, elf.pos) > 2) {
    elf.wish.copy(game.navigate(elf, lastPos))
    return true
  }
  return false
}

// 巡邏：精靈的直覺會偏向有較多哥布林的洞。listen：聽得到洞外的哥布林（豎琴精靈）
function patrol(game: Game, dt: number, listen: boolean) {
  const elf = game.elf
  const ai = elf.ai
  const now = game.elapsed
  if (ai.patrolWait > 0) {
    ai.patrolWait -= dt
    elf.yaw += dt * 1.5
    return
  }
  if (listen) {
    const outside = game.goblins.find((g) => !g.captured && g.zone < 0 && dist2d(g.pos, elf.pos) < 40)
    if (outside && Math.random() < 0.005) ai.dest = outside.pos.clone()
  }
  if (!ai.dest) {
    const weights = game.world.caves.map((c) => {
      if (c.id === ai.patrolCave) return 0.05
      let w = 1
      for (const g of game.goblins) if (!g.captured && g.zone === c.id) w += 0.4
      if (now < 90 && game.playerGoblin && game.playerGoblin.zone === c.id) w *= 0.25
      return w
    })
    const sum = weights.reduce((a, b) => a + b, 0)
    let r = Math.random() * sum
    let pick = 0
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]
      if (r <= 0) {
        pick = i
        break
      }
    }
    ai.patrolCave = pick
    const c = game.world.caves[pick]
    const a = Math.random() * Math.PI * 2
    ai.dest = new THREE.Vector3(c.center.x + Math.cos(a) * 5, 0, c.center.z + Math.sin(a) * 5)
  }
  if (dist2d(ai.dest, elf.pos) < 2.5) {
    ai.dest = null
    ai.patrolWait = 1.2
    return
  }
  elf.wish.copy(game.navigate(elf, ai.dest))
}

function faceTo(a: { pos: THREE.Vector3; yaw: number }, p: THREE.Vector3) {
  a.yaw = Math.atan2(p.x - a.pos.x, p.z - a.pos.z)
}
