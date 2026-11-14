import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 純 JS 工具腳本，無型別宣告
import { inspectGlb } from '../tools/validate-glb.mjs'
import { CONFIG } from '../src/game/config'
import { ElfAnimState } from '../src/game/elf/ElfAnimState'
import { ElfCharacter } from '../src/game/elf/ElfCharacter'
import { VIOLINIST_ANIM, VIOLINIST_CLIPS, VIOLINIST_COLLIDERS, VIOLINIST_RIG, VIOLINIST_SPRING_CHAINS } from '../src/game/elf/rigs'
import { behindSpot, fearTargets, nearestTarget, sweepHit, type Target } from '../src/game/violin'
import { fakeFallback, fileLoad, VIOLINIST_GLB } from './helpers'

const g = (id: number, x: number, z: number, extra: Partial<Target> = {}): Target => ({
  id, pos: new THREE.Vector3(x, 0, z), yaw: 0, radius: 0.55, captured: false, held: false, grace: 0, ...extra,
})

describe('紫晶精靈技能判定', () => {
  it('衝鋒掃掠：命中路徑上最先碰到的那一隻（單體）', () => {
    const list = [g(0, 0, 6), g(1, 0, 3), g(2, 3, 3)]
    const hit = sweepHit(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 9), list, 0.8)
    expect(hit?.id).toBe(1)
  })

  it('衝鋒不會撞到已被抓 / 打包中 / 掙脫無敵的哥布林', () => {
    const list = [g(0, 0, 2, { captured: true }), g(1, 0, 3, { held: true }), g(2, 0, 4, { grace: 1 }), g(3, 0, 8)]
    expect(sweepHit(new THREE.Vector3(), new THREE.Vector3(0, 0, 9), list, 0.8)?.id).toBe(3)
  })

  it('衝鋒落空：路徑旁太遠的不算', () => {
    expect(sweepHit(new THREE.Vector3(), new THREE.Vector3(0, 0, 9), [g(0, 2, 4)], 0.8)).toBeNull()
  })

  it('瞬移：範圍內最近的哥布林；超出範圍時為 null', () => {
    const list = [g(0, 10, 0), g(1, 30, 0), g(2, 3, 0, { held: true })]
    expect(nearestTarget(new THREE.Vector3(), list, 45)?.id).toBe(0)
    expect(nearestTarget(new THREE.Vector3(), [g(0, 60, 0)], 45)).toBeNull()
  })

  it('瞬移到哥布林身後（依面向）', () => {
    const t = g(0, 5, 5, { yaw: 0 }) // 面向 +Z
    const p = behindSpot(t, CONFIG.violin.eye.behind)
    expect(p.x).toBeCloseTo(5)
    expect(p.z).toBeCloseTo(5 - CONFIG.violin.eye.behind)
  })

  it('現身恐懼只影響半徑內、可被影響的哥布林', () => {
    const list = [g(0, 2, 0), g(1, 9, 0), g(2, 1, 1, { held: true })]
    expect(fearTargets(new THREE.Vector3(), list, CONFIG.violin.stealth.fearRadius).map((x) => x.id)).toEqual([0])
  })

  it('平衡：與預設精靈同速、衝鋒距離大於打暈距離、各技能冷卻符合設計', () => {
    const V = CONFIG.violin
    expect(CONFIG.elf.speed).toBeGreaterThan(CONFIG.goblin.speed)
    expect(V.charge.distance).toBeGreaterThan(CONFIG.elf.stun.range * 2)
    expect([V.stealth.duration, V.stealth.cooldown, V.stealth.fearTime]).toEqual([15, 12, 3])
    expect([V.eye.duration, V.eye.cooldown]).toEqual([20, 20])
    expect([V.charge.windup, V.charge.stun, V.charge.cooldown]).toEqual([0.5, 1.5, 7])
  })
})

describe('紫晶精靈動畫狀態機', () => {
  it('衝鋒三段姿勢對應到前搖 / 突刺 / 收招動作', () => {
    const s = new ElfAnimState(VIOLINIST_ANIM)
    expect(s.update('windup', 0).clip).toBe('ChargeWindup')
    expect(s.update('dash', 1.3).clip).toBe('ChargeDash')
    expect(s.update('recover', 0).clip).toBe('ChargeRecover')
    expect(s.update('play', 0).clip).toBe('Play')
    expect(s.update('pack', 0).clip).toBe('Capture')
  })

  it('步態依建置腳本的參考速度播放（不滑步）', () => {
    const s = new ElfAnimState(VIOLINIST_ANIM)
    const r = s.update('normal', 1, 7.4)
    expect(r.clip).toBe('Run')
    expect(r.timeScale * VIOLINIST_ANIM.gaitRef.Run).toBeCloseTo(7.4, 5)
  })
})

describe('紫晶精靈 GLB', () => {
  const info = inspectGlb(readFileSync(VIOLINIST_GLB))

  it('結構無錯誤，包含所有動作、LOD 與道具骨', () => {
    expect(info.errors).toEqual([])
    const names = info.animations.map((a: { name: string }) => a.name)
    for (const c of VIOLINIST_CLIPS) expect(names).toContain(c)
    for (const n of [...VIOLINIST_RIG.lod, 'prop_violin', 'prop_bow', 'Violin', 'Bow']) expect(info.nodes).toContain(n)
    // 布料 / 頭髮的彈簧骨鏈都在骨架裡
    for (const chains of Object.values(VIOLINIST_SPRING_CHAINS)) for (const c of chains) for (const b of c) expect(info.bones).toContain(b)
  })

  it('尺寸：約 1.7m；Mixamo rest（T-pose）腳底比動作中低約 0.1m（動作的骨盆位移會把腳放回地面）', () => {
    expect(info.bounds.size[1]).toBeGreaterThan(1.5)
    expect(info.bounds.size[1]).toBeLessThan(1.95)
    expect(info.bounds.min[1]).toBeGreaterThan(-0.15)
    expect(info.bounds.min[1]).toBeLessThan(0.05)
  })

  it('ElfCharacter 以紫晶規格載入，小提琴掛在左手的 prop_violin 骨', async () => {
    const elf = new ElfCharacter({ rig: VIOLINIST_RIG, load: fileLoad, fallback: fakeFallback(), lowEnd: false })
    await elf.ready
    expect(elf.status).toBe('ready')
    expect([...elf.actions.keys()].sort()).toEqual([...VIOLINIST_CLIPS].sort())
    const chain: string[] = []
    let p: THREE.Object3D | null = elf.root.getObjectByName('Violin')!
    while (p) {
      chain.push(p.name)
      p = p.parent
    }
    expect(chain).toContain('prop_violin')
    expect(chain).toContain('LeftHand')
    // 所有姿勢都能播放
    for (const pose of ['normal', 'play', 'cast', 'windup', 'dash', 'recover', 'pack', 'stunned'] as const) elf.animate(0.05, 0, pose)
    // 隱身：完全看不見 / 半透明 / 恢復
    elf.setOpacity(0)
    expect(elf.root.visible).toBe(false)
    elf.setOpacity(0.3)
    expect(elf.root.visible).toBe(true)
    elf.setOpacity(1)
    elf.dispose()
  })
})

// 紫晶精靈的儀態與布料（build_violinist.py 的 ground / rig_cloth）：
// Meshy 的自動綁骨把裙擺、垂袖綁在腿骨上，骨架又比網格高 4 cm、膝關節在腿後方 16 cm——走路時布料黏著腿、關節繞著肢體外面的點轉
describe('紫晶精靈的骨架與布料', () => {
  // 彈簧鏈的抖動相位固定下來，量測值才不會每次不同
  // （不能直接 mock Math.random：three 的 UUID 也用它，動作會互相覆蓋）
  const load = async () => {
    const elf = new ElfCharacter({ rig: VIOLINIST_RIG, load: fileLoad, fallback: fakeFallback(), lowEnd: false, random: () => 0.37 })
    await elf.ready
    return elf
  }
  const LEGS = /(UpLeg|Leg|Foot|ToeBase)$/
  const CLOTH = /^(skirt_|drape_|hair_)/

  // LOD0 的綁定姿勢：頂點座標、每個頂點各骨頭的權重、各骨頭的綁定位置
  function bindData(elf: ElfCharacter) {
    const mesh = elf.root.getObjectByName('VioletMesh_LOD0') as THREE.SkinnedMesh
    const pos = mesh.geometry.attributes.position
    const si = mesh.geometry.attributes.skinIndex
    const sw = mesh.geometry.attributes.skinWeight
    const bones = mesh.skeleton.bones
    const bind = (name: string) => {
      const i = bones.findIndex((b) => b.name === name)
      return new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[i].clone().invert())
    }
    const weights = (v: number) => {
      const out: [string, number][] = []
      for (let k = 0; k < 4; k++) if (sw.getComponent(v, k) > 0) out.push([bones[si.getComponent(v, k)].name, sw.getComponent(v, k)])
      return out
    }
    return { pos, bind, weights, count: pos.count }
  }

  it('骨架與網格對齊：手腕關節在手的高度、膝關節在腿的中心（不在腿的後方）', async () => {
    const elf = await load()
    const { pos, bind, weights, count } = bindData(elf)
    const box = (pred: (w: [string, number][], y: number) => boolean) => {
      const b = new THREE.Box3()
      for (let v = 0; v < count; v++) if (pred(weights(v), pos.getY(v))) b.expandByPoint(new THREE.Vector3().fromBufferAttribute(pos, v))
      return b
    }
    // 手：LeftHand 權重為主的頂點（T-pose 手掌水平，厚度約 3 cm）
    const hand = box((w) => w.some(([n, x]) => n === 'LeftHand' && x > 0.6))
    const wrist = bind('LeftHand')
    expect(wrist.y).toBeGreaterThan(hand.min.y - 0.015)
    expect(wrist.y).toBeLessThan(hand.max.y + 0.015)
    // 膝：膝關節高度附近、腿骨權重為主的頂點（腿本身；裙擺已不帶腿骨權重）
    const knee = bind('LeftLeg')
    const leg = box((w, y) => Math.abs(y - knee.y) < 0.03 && w.filter(([n]) => /^Left(UpLeg|Leg)$/.test(n)).reduce((a, [, x]) => a + x, 0) > 0.9)
    const c = leg.getCenter(new THREE.Vector3())
    expect(Math.abs(knee.z - c.z)).toBeLessThan(0.03)
    expect(Math.abs(knee.x - c.x)).toBeLessThan(0.03)
    // 腿的比例：大腿與小腿長度相近（原本膝蓋偏高：0.34 / 0.49）
    const thigh = bind('LeftUpLeg').distanceTo(knee), shin = knee.distanceTo(bind('LeftFoot'))
    expect(thigh / shin).toBeGreaterThan(0.8)
    expect(thigh / shin).toBeLessThan(1.1)
    elf.dispose()
  })

  it('布料不再綁在腿上：遠離腿的裙片 / 垂袖完全不帶腿骨權重，改由彈簧骨帶動', async () => {
    const elf = await load()
    const { pos, weights, count } = bindData(elf)
    const sum = (w: [string, number][], re: RegExp) => w.filter(([n]) => re.test(n)).reduce((a, [, x]) => a + x, 0)
    let cloth = 0, far = 0, dragged = 0
    for (let v = 0; v < count; v++) {
      const w = weights(v)
      if (sum(w, CLOTH) > 0.3) cloth++
      // 身體中線 26 cm 以外、腰以下：只有裙片與垂袖（原本這裡有上千個頂點跟著大腿 / 小腿動）。
      // 更靠近腿的布料在臀部交界帶保留少量大腿權重做過渡（blend_cloth_boundary）
      if (Math.abs(pos.getX(v)) > 0.26 && pos.getY(v) < 0.9) {
        far++
        if (sum(w, LEGS) > 0.05) dragged++
      }
    }
    expect(cloth).toBeGreaterThan(4000)
    expect(far).toBeGreaterThan(500)
    expect(dragged).toBe(0)
    elf.dispose()
  })

  it('彈簧骨：裙擺 8×4 + 垂袖 2×3 + 頭髮 3×3；rest pose 下尖端不在碰撞體內', async () => {
    const elf = await load()
    elf.animate(0.016, 0, 'normal')
    expect(elf.springs.count).toBe(47)
    expect(elf.springs.colliderCount).toBe(VIOLINIST_COLLIDERS.length)
    const { worst, name } = elf.springs.restClearance(elf.root)
    expect(worst, name).toBeGreaterThan(0)
    elf.dispose()
  })

  it('靜止時布料穩定、不發散', async () => {
    const elf = await load()
    for (let i = 0; i < 240; i++) elf.animate(1 / 60, 0, 'normal')
    const tips = ['skirt_B4', 'skirt_L4', 'drape_L3', 'hair_C3'].map((n) => elf.root.getObjectByName(n)!)
    const a = tips.map((o) => o.getWorldPosition(new THREE.Vector3()))
    for (let i = 0; i < 30; i++) elf.animate(1 / 60, 0, 'normal')
    tips.forEach((o, k) => expect(o.getWorldPosition(new THREE.Vector3()).distanceTo(a[k]), o.name).toBeLessThan(0.03))
    elf.root.traverse((o) => {
      if ((o as THREE.Bone).isBone) expect(Number.isFinite(o.quaternion.x)).toBe(true)
    })
    elf.dispose()
  })

  it('走動時裙擺往後飄（輕盈），而且不會穿進腿裡', async () => {
    const elf = await load()
    const legs = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'].map((n) => elf.root.getObjectByName(n)!)
    const skirt: THREE.Object3D[] = []
    elf.root.traverse((o) => /^skirt_.*[234]$/.test(o.name) && skirt.push(o))
    const hips = elf.root.getObjectByName('Hips')!
    const back = elf.root.getObjectByName('skirt_B4')!
    const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Vector3()
    const trail = () => hips.getWorldPosition(a).z - back.getWorldPosition(b).z // 裙擺後緣在骨盆後方多遠（角色朝 +Z 前進）
    for (let i = 0; i < 120; i++) elf.animate(1 / 60, 0, 'normal')
    const still = trail()
    const run = (speed: number, move: number, frames: number) => {
      let worst = Infinity, sum = 0, n = 0
      for (let i = 0; i < frames; i++) {
        elf.root.position.z += speed / 60
        elf.animate(1 / 60, move, 'normal')
        if (i < 60) continue
        sum += trail()
        n++
        for (const o of skirt) {
          o.getWorldPosition(p)
          for (let l = 0; l < legs.length; l += 3) {
            for (const [from, to, r] of [[legs[l], legs[l + 1], 0.07], [legs[l + 1], legs[l + 2], 0.05]] as const) {
              from.getWorldPosition(a)
              to.getWorldPosition(b)
              const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(b.clone().sub(a)) / b.distanceToSquared(a), 0, 1)
              c.copy(a).lerp(b, t)
              worst = Math.min(worst, p.distanceTo(c) - r)
            }
          }
        }
      }
      return { worst, trail: sum / n }
    }
    const walk = run(2, 0.27, 180)
    expect(elf.anim.current).toBe('Walk')
    expect(walk.worst).toBeGreaterThan(0)
    expect(walk.trail - still).toBeGreaterThan(0.08) // 走路就飄得起來
    const sprint = run(7.4, 1, 180)
    expect(elf.anim.current).toBe('Run')
    expect(sprint.worst).toBeGreaterThan(0)
    expect(sprint.trail - still).toBeGreaterThan(0.08)
    // 迎風有上限：全速也不會被吹成水平（後緣仍明顯低於骨盆）
    expect(back.getWorldPosition(p).y).toBeLessThan(hips.getWorldPosition(a).y - 0.1)
    elf.dispose()
  })

  it('走路 / 跑步時支撐腳貼地（不浮空、不陷入地面）', async () => {
    const elf = await load()
    const feet = ['LeftFoot', 'RightFoot'].map((n) => elf.root.getObjectByName(n)!)
    elf.animate(1 / 60, 0, 'normal')
    elf.root.updateMatrixWorld(true)
    const rest = feet.map((f) => f.getWorldPosition(new THREE.Vector3()).y) // 待機時腳踝高度
    for (const [move, speed, flight] of [[0.27, 2, 0.015], [1, 7.4, 0.07]] as const) {
      let maxLow = -Infinity, minLow = Infinity
      for (let i = 0; i < 120; i++) {
        elf.root.position.z += speed / 60
        elf.animate(1 / 60, move, 'normal')
        elf.root.updateMatrixWorld(true)
        if (i < 40) continue
        const low = Math.min(...feet.map((f, k) => f.getWorldPosition(new THREE.Vector3()).y - rest[k]))
        maxLow = Math.max(maxLow, low)
        minLow = Math.min(minLow, low)
      }
      expect(maxLow).toBeLessThan(flight) // 跑步騰空期只允許幾公分
      expect(minLow).toBeGreaterThan(-0.03)
    }
    elf.dispose()
  })

  it('儀態：上身平穩滑行——骨盆上下起伏只有幾公分（原本的支撐期太長，跑步每步起伏 17 cm，像在彈跳）', async () => {
    const elf = await load()
    const hips = elf.root.getObjectByName('Hips')!
    for (const [move, speed, limit] of [[0.27, 2, 0.045], [1, 7.4, 0.06]] as const) {
      let lo = Infinity, hi = -Infinity
      for (let i = 0; i < 240; i++) {
        elf.root.position.z += speed / 60
        elf.animate(1 / 60, move, 'normal')
        if (i < 120) continue
        lo = Math.min(lo, hips.position.y)
        hi = Math.max(hi, hips.position.y)
      }
      expect(hi - lo).toBeGreaterThan(0.01) // 仍然有步伐的起伏
      expect(hi - lo).toBeLessThan(limit)
    }
    elf.dispose()
  })

  it('急停時裙擺不會整片甩到身體前面；瞬移時重設', async () => {
    const elf = await load()
    const hips = elf.root.getObjectByName('Hips')!
    const tips = ['skirt_B4', 'skirt_BL4', 'skirt_BR4'].map((n) => elf.root.getObjectByName(n)!)
    const a = new THREE.Vector3(), b = new THREE.Vector3()
    for (let i = 0; i < 120; i++) {
      elf.root.position.z += 7.4 / 60
      elf.animate(1 / 60, 1, 'normal')
    }
    let ahead = -Infinity
    for (let i = 0; i < 90; i++) {
      elf.animate(1 / 60, 0, 'normal') // 速度瞬間歸零
      for (const o of tips) ahead = Math.max(ahead, o.getWorldPosition(b).z - hips.getWorldPosition(a).z)
    }
    expect(ahead).toBeLessThan(0.25) // 後片的下緣最多往前盪過骨盆一點（完全的慣性會甩到身前 0.6 m 以上）
    elf.root.position.set(20, 0, -15)
    elf.root.updateMatrixWorld(true)
    elf.animate(1 / 60, 0, 'normal')
    for (const o of tips) expect(o.getWorldPosition(b).distanceTo(hips.getWorldPosition(a))).toBeLessThan(1.2)
    elf.dispose()
  })
})
