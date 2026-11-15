import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { ElfCharacter } from '../src/game/elf/ElfCharacter'
import { ELF_CLIPS, ELF_COLLIDERS } from '../src/game/elf/assets'
import type { CharacterModel, Pose } from '../src/game/models'
import { fakeFallback, fileLoad } from './helpers'

const ALL_POSES: Pose[] = ['normal', 'stunned', 'rooted', 'held', 'cast', 'play', 'attack', 'pack']

async function loaded() {
  const fb = fakeFallback()
  // 彈簧鏈的抖動相位固定下來，量測值才不會每次不同
  const elf = new ElfCharacter({ load: fileLoad, fallback: fb, lowEnd: false, random: () => 0.37 })
  await elf.ready
  return { elf, fb }
}

describe('ElfCharacter 載入', () => {
  it('載入 GLB 後狀態為 ready，九個動作都建立', async () => {
    const { elf } = await loaded()
    expect(elf.status).toBe('ready')
    expect([...elf.actions.keys()].sort()).toEqual([...ELF_CLIPS].sort())
    expect(elf.root.getObjectByName('ElfMesh_LOD0')).toBeTruthy()
    expect(elf.root.getObjectByName('ElfMesh_LOD1')).toBeTruthy()
  })

  it('載入完成後移除程序化替身並釋放其幾何', async () => {
    const fb = fakeFallback()
    const spy = vi.spyOn(fb.mesh.geometry, 'dispose')
    const elf = new ElfCharacter({ load: fileLoad, fallback: fb, lowEnd: false })
    expect(elf.root.children).toContain(fb.root)
    await elf.ready
    expect(elf.root.children).not.toContain(fb.root)
    expect(spy).toHaveBeenCalled()
  })

  it('豎琴掛在 prop_harp（左手）骨上', async () => {
    const { elf } = await loaded()
    const harp = elf.root.getObjectByName('Harp')!
    expect(harp).toBeTruthy()
    let p: THREE.Object3D | null = harp
    const chain: string[] = []
    while (p) {
      chain.push(p.name)
      p = p.parent
    }
    expect(chain).toContain('prop_harp')
    expect(chain).toContain('LeftHand')
  })

  it('載入失敗時保留程序化模型，仍可正常 animate', async () => {
    const fb = fakeFallback()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const elf = new ElfCharacter({ load: () => Promise.reject(new Error('404')), fallback: fb, lowEnd: false })
    await elf.ready
    expect(elf.status).toBe('fallback')
    expect(elf.root.children).toContain(fb.root)
    elf.animate(0.016, 0.5, 'play')
    elf.setHarp(true)
    expect(fb.calls).toEqual(['play', 'harp:true'])
    warn.mockRestore()
  })

  it('載入前就 dispose 不會把模型裝上去', async () => {
    const elf = new ElfCharacter({ load: fileLoad, lowEnd: false })
    elf.dispose()
    await elf.ready
    expect(elf.status).toBe('disposed')
    expect(elf.root.children.length).toBe(0)
  })
})

describe('ElfCharacter 動畫轉換', () => {
  it('姿勢改變時交叉淡入目標動作', async () => {
    const { elf } = await loaded()
    elf.animate(0.016, 0, 'normal')
    expect(elf.anim.current).toBe('Idle')
    elf.animate(0.016, 0, 'play')
    const play = elf.actions.get('Play')!
    const idle = elf.actions.get('Idle')!
    expect(play.isRunning()).toBe(true)
    for (let i = 0; i < 40; i++) elf.animate(0.016, 0, 'play')
    expect(play.getEffectiveWeight()).toBeCloseTo(1, 2)
    expect(idle.getEffectiveWeight()).toBeCloseTo(0, 2)
  })

  it('動作確實驅動骨架（手臂在彈奏時移動）', async () => {
    const { elf } = await loaded()
    const arm = elf.root.getObjectByName('LeftArm')!
    for (let i = 0; i < 30; i++) elf.animate(0.016, 0, 'normal')
    const idle = arm.quaternion.clone()
    for (let i = 0; i < 60; i++) elf.animate(0.016, 0, 'play')
    expect(arm.quaternion.angleTo(idle)).toBeGreaterThan(0.3)
  })

  it('彈奏時豎琴出現，結束後收起', async () => {
    const { elf } = await loaded()
    elf.setHarp(true)
    for (let i = 0; i < 30; i++) elf.animate(0.016, 0, 'play')
    expect(elf.harpVisible).toBe(true)
    elf.setHarp(false)
    for (let i = 0; i < 60; i++) elf.animate(0.016, 0, 'normal')
    expect(elf.harpVisible).toBe(false)
  })

  it('移動時頭髮彈簧骨偏離 rest pose', async () => {
    const { elf } = await loaded()
    const hair = elf.root.getObjectByName('hair_C2')!
    elf.animate(0.016, 0, 'normal')
    const rest = hair.quaternion.clone()
    for (let i = 0; i < 40; i++) {
      elf.root.position.z += 0.12
      elf.animate(0.016, 1, 'normal')
    }
    expect(hair.quaternion.angleTo(rest)).toBeGreaterThan(0.05)
    // 裙擺 8×4 + 寬袖 6×3 + 頭髮 3×3
    expect(elf.springs.count).toBe(59)
    expect(elf.springs.colliderCount).toBe(ELF_COLLIDERS.length)
  })

  it('rest pose 下彈簧骨尖端不在碰撞體內（否則待機時會抖動 / 被推歪）', async () => {
    const { elf } = await loaded()
    elf.animate(0.016, 0, 'normal')
    const { worst, name } = elf.springs.restClearance(elf.root)
    expect(worst, name).toBeGreaterThan(0)
  })

  it('布料模擬：靜止時穩定，不會發散', async () => {
    const { elf } = await loaded()
    for (let i = 0; i < 240; i++) elf.animate(1 / 60, 0, 'normal')
    const sk = elf.root.getObjectByName('skirt_L4')!
    const a = sk.getWorldPosition(new THREE.Vector3())
    for (let i = 0; i < 30; i++) elf.animate(1 / 60, 0, 'normal')
    const b = sk.getWorldPosition(new THREE.Vector3())
    expect(a.distanceTo(b)).toBeLessThan(0.03)
    elf.root.traverse((o) => {
      if ((o as THREE.Bone).isBone) expect(Number.isFinite(o.quaternion.x)).toBe(true)
    })
  })

  it('袖子受重力：手舉高（勝利動作）時袖子仍往下垂', async () => {
    const { elf } = await loaded()
    elf.setVictory(true)
    for (let i = 0; i < 120; i++) elf.animate(1 / 60, 0, 'normal')
    const s1 = elf.root.getObjectByName('sleeve_LC1')!.getWorldPosition(new THREE.Vector3())
    const s2 = elf.root.getObjectByName('sleeve_LC3')!.getWorldPosition(new THREE.Vector3())
    expect(s2.y).toBeLessThan(s1.y) // 第二節在第一節下方
  })

  it('跑步時裙擺被腿推開：裙擺骨尖端不會穿進腿裡', async () => {
    const { elf } = await loaded()
    const legs = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'].map((n) => elf.root.getObjectByName(n)!)
    const skirt: THREE.Object3D[] = []
    elf.root.traverse((o) => /^skirt_.*[234]$/.test(o.name) && skirt.push(o))
    const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Vector3()
    let worst = Infinity
    let moved = 0
    const start = skirt.map((o) => o.getWorldPosition(new THREE.Vector3()))
    for (let i = 0; i < 180; i++) {
      elf.root.position.z += 0.07 // 約 4 m/s
      elf.animate(1 / 60, 1, 'normal')
      if (i < 60) continue
      for (const [k, o] of skirt.entries()) {
        o.getWorldPosition(p)
        moved = Math.max(moved, p.clone().sub(elf.root.position).distanceTo(start[k]))
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
    expect(worst).toBeGreaterThan(0) // 骨頭尖端（裙擺節點）永遠在腿的外面
    expect(moved).toBeGreaterThan(0.03) // 而且裙擺確實在擺動
  })

  it('走路 / 跑步時支撐腳貼地（不浮空）', async () => {
    const { elf } = await loaded()
    const feet = ['LeftFoot', 'RightFoot'].map((n) => elf.root.getObjectByName(n)!)
    const rest = feet.map((f) => f.getWorldPosition(new THREE.Vector3()).y) // 待機時腳踝高度
    for (const move of [0.3, 1]) {
      let maxLow = -Infinity
      for (let i = 0; i < 90; i++) {
        elf.root.position.z += (move === 1 ? 7.4 : 2) / 60
        elf.animate(1 / 60, move, 'normal')
        elf.root.updateMatrixWorld(true)
        if (i < 30) continue
        const low = Math.min(...feet.map((f, k) => f.getWorldPosition(new THREE.Vector3()).y - rest[k]))
        maxLow = Math.max(maxLow, low)
      }
      // 較低的那隻腳的腳踝幾乎不會高於待機高度（跑步騰空期只允許幾公分）
      expect(maxLow).toBeLessThan(move === 1 ? 0.09 : 0.02)
    }
  })

  it('瞬移（重生）時布料重設，不會甩出去', async () => {
    const { elf } = await loaded()
    for (let i = 0; i < 30; i++) elf.animate(1 / 60, 0, 'normal')
    const hair = elf.root.getObjectByName('hair_C3')!
    elf.root.position.set(20, 0, -15)
    elf.root.updateMatrixWorld(true)
    elf.animate(1 / 60, 0, 'normal')
    const head = elf.root.getObjectByName('Head')!.getWorldPosition(new THREE.Vector3())
    expect(hair.getWorldPosition(new THREE.Vector3()).distanceTo(head)).toBeLessThan(0.8)
  })

  it('LOD 依相機距離切換（含遲滯）', async () => {
    const { elf } = await loaded()
    const cam = new THREE.PerspectiveCamera()
    elf.setCamera(cam)
    cam.position.set(0, 1.5, 5)
    elf.animate(0.016, 0, 'normal')
    expect(elf.lodLevel).toBe(0)
    cam.position.set(0, 1.5, 30)
    elf.animate(0.016, 0, 'normal')
    expect(elf.lodLevel).toBe(1)
    expect(elf.root.getObjectByName('ElfMesh_LOD0')!.visible).toBe(false)
    cam.position.set(0, 1.5, 14.5) // 介於 near / far 之間：維持 LOD1
    elf.animate(0.016, 0, 'normal')
    expect(elf.lodLevel).toBe(1)
    cam.position.set(0, 1.5, 4)
    elf.animate(0.016, 0, 'normal')
    expect(elf.lodLevel).toBe(0)
  })

  it('低階裝置固定使用 LOD1', async () => {
    const elf = new ElfCharacter({ load: fileLoad, lowEnd: true })
    await elf.ready
    elf.animate(0.016, 0, 'normal')
    expect(elf.lodLevel).toBe(1)
  })
})

describe('ElfCharacter 資源釋放', () => {
  it('dispose 釋放幾何、材質、貼圖並停止 mixer', async () => {
    const { elf } = await loaded()
    const geos: THREE.BufferGeometry[] = []
    const mats = new Set<THREE.Material>()
    elf.root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        geos.push(m.geometry)
        ;(Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => mats.add(x))
      }
    })
    const gSpies = geos.map((g) => vi.spyOn(g, 'dispose'))
    const mSpies = [...mats].map((m) => vi.spyOn(m, 'dispose'))
    const tex = [...mats].map((m) => (m as THREE.MeshStandardMaterial).map).find(Boolean)!
    const tSpy = vi.spyOn(tex, 'dispose')
    elf.dispose()
    expect(gSpies.every((s) => s.mock.calls.length > 0)).toBe(true)
    expect(mSpies.every((s) => s.mock.calls.length > 0)).toBe(true)
    expect(tSpy).toHaveBeenCalled()
    expect(elf.mixer).toBeNull()
    expect(elf.root.children.length).toBe(0)
    // dispose 後再呼叫不會丟錯
    expect(() => elf.animate(0.016, 0, 'normal')).not.toThrow()
    expect(() => elf.dispose()).not.toThrow()
  })
})

describe('與遊戲端的相容性', () => {
  it('符合 CharacterModel 介面，所有遊戲姿勢都能播放', async () => {
    const { elf } = await loaded()
    const model: CharacterModel = elf
    for (const pose of ALL_POSES) {
      for (let i = 0; i < 5; i++) expect(() => model.animate(0.016, 0.5, pose, { scared: false })).not.toThrow()
    }
    expect(typeof model.setHarp).toBe('function')
  })

  it('root 是穩定的 Group：遊戲掛上的血條 / 圖示在載入後保留', async () => {
    const fb = fakeFallback()
    const elf = new ElfCharacter({ load: fileLoad, fallback: fb, lowEnd: false })
    const bar = new THREE.Group()
    elf.root.add(bar) // Elf 建構子會在 root 上掛 UI
    const root = elf.root
    await elf.ready
    expect(elf.root).toBe(root)
    expect(elf.root.children).toContain(bar)
  })

  it('模型尺寸與朝向：約 1.7m 高、面向 +Z、腳在地面', async () => {
    const { elf } = await loaded()
    elf.animate(0.016, 0, 'normal')
    elf.root.updateMatrixWorld(true)
    const head = elf.root.getObjectByName('Head')!.getWorldPosition(new THREE.Vector3())
    const toe = elf.root.getObjectByName('LeftFoot')!
    const ankle = toe.getWorldPosition(new THREE.Vector3())
    expect(head.y).toBeGreaterThan(1.4)
    expect(head.y).toBeLessThan(1.6)
    // 腳尖骨的 +Y（骨頭方向）指向角色正面 +Z
    const toeDir = new THREE.Vector3(0, 1, 0).applyQuaternion(toe.getWorldQuaternion(new THREE.Quaternion()))
    expect(toeDir.z).toBeGreaterThan(0.5)
    expect(ankle.y).toBeLessThan(0.15)
  })
})

// 4K 版豎琴精靈（build_harpist.py）：舊版把 T-pose 的手臂硬轉成 A-pose，肩膀塌陷變形；頭髮 / 袖子與身體之間切開的橋接面沒有補，
// 一擺動背上和身體就露出破洞。新版以雙四元數蒙皮把 A-pose 烘進綁定姿勢、切開處補面，布料改掛彈簧骨
describe('豎琴精靈的身形與布料', () => {
  const ARM = /(Arm|ForeArm|Hand)$/
  const CLOTH = /^(skirt_|sleeve_|hair_)/

  function bindData(elf: ElfCharacter) {
    const mesh = elf.root.getObjectByName('ElfMesh_LOD0') as THREE.SkinnedMesh
    const pos = mesh.geometry.attributes.position
    const si = mesh.geometry.attributes.skinIndex
    const sw = mesh.geometry.attributes.skinWeight
    const bones = mesh.skeleton.bones
    const bind = (name: string) => {
      const i = bones.findIndex((b) => b.name === name)
      return new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[i].clone().invert())
    }
    const weight = (v: number, re: RegExp) => {
      let w = 0
      for (let k = 0; k < 4; k++) if (re.test(bones[si.getComponent(v, k)].name)) w += sw.getComponent(v, k)
      return w
    }
    return { mesh, pos, bind, weight, count: pos.count }
  }

  it('綁定姿勢是 A-pose：手臂與垂直約 30°、左右對稱，肩寬與高模相同（肩膀沒有塌）', async () => {
    const { elf } = await loaded()
    const { pos, bind, weight, count } = bindData(elf)
    for (const S of ['Left', 'Right']) {
      const d = bind(`${S}Hand`).sub(bind(`${S}Arm`)).normalize()
      const fromVertical = THREE.MathUtils.radToDeg(Math.acos(-d.y))
      expect(fromVertical).toBeGreaterThan(22)
      expect(fromVertical).toBeLessThan(42)
    }
    expect(bind('LeftArm').x).toBeCloseTo(-bind('RightArm').x, 3)
    // 肩關節在肩膀裡面：關節周圍 6 cm 內、以鎖骨 / 上臂權重為主的皮膚，外框在各方向都包住關節
    const sh = bind('LeftArm')
    const box = new THREE.Box3()
    const q = new THREE.Vector3()
    for (let v = 0; v < count; v++) {
      q.fromBufferAttribute(pos, v)
      if (q.distanceTo(sh) < 0.06 && weight(v, /^Left(Shoulder|Arm)$/) > 0.5) box.expandByPoint(q)
    }
    for (const k of ['x', 'y', 'z'] as const) {
      expect(sh[k], k).toBeGreaterThan(box.min[k] + 0.008)
      expect(sh[k], k).toBeLessThan(box.max[k] - 0.008)
    }
    // 兩肩關節相距約 24 cm（高模 T-pose 量測的肩寬），A-pose 沒有把肩膀往內擠
    expect(sh.x * 2).toBeGreaterThan(0.22)
    expect(sh.x * 2).toBeLessThan(0.29)
    elf.dispose()
  })

  it('頭髮、裙擺不被手臂帶動；布料由彈簧骨帶動', async () => {
    const { elf } = await loaded()
    const { weight, count } = bindData(elf)
    let cloth = 0, dragged = 0
    for (let v = 0; v < count; v++) {
      if (weight(v, /^(skirt_|hair_)/) > 0.3) {
        cloth++
        if (weight(v, ARM) > 0.05) dragged++
      }
    }
    expect(cloth).toBeGreaterThan(4000)
    expect(dragged).toBe(0)
    elf.dispose()
  })

  it('網格沒有破洞：切開橋接面後都補了面（封閉曲面，邊界邊為 0）', async () => {
    const { elf } = await loaded()
    const { mesh } = bindData(elf)
    const g = mesh.geometry
    const p = g.attributes.position
    // 匯出時頂點沿 UV 縫分裂：以座標合併後統計每條邊被幾個三角形使用
    const key = (i: number) => `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`
    const ids = new Map<string, number>()
    const id = (i: number) => {
      const k = key(i)
      let v = ids.get(k)
      if (v === undefined) ids.set(k, (v = ids.size))
      return v
    }
    const edges = new Map<number, number>()
    const idx = g.index!
    for (let t = 0; t < idx.count; t += 3) {
      const a = [id(idx.getX(t)), id(idx.getX(t + 1)), id(idx.getX(t + 2))]
      for (let k = 0; k < 3; k++) {
        const u = a[k], w = a[(k + 1) % 3]
        if (u === w) continue
        const e = Math.min(u, w) * 100000 + Math.max(u, w)
        edges.set(e, (edges.get(e) ?? 0) + 1)
      }
    }
    let boundary = 0
    for (const n of edges.values()) if (n === 1) boundary++
    expect(boundary).toBeLessThan(12) // 座標量化後極少數邊會對不上；舊流程切開後沒補的破洞有上百條邊界邊
    elf.dispose()
  })

  it('走動時裙擺與寬袖往後飄；停下來落回原位', async () => {
    const { elf } = await loaded()
    const hips = elf.root.getObjectByName('Hips')!
    const hand = elf.root.getObjectByName('LeftHand')!
    const skirt = elf.root.getObjectByName('skirt_B4')!
    const sleeve = elf.root.getObjectByName('sleeve_LC3')!
    const a = new THREE.Vector3(), b = new THREE.Vector3()
    // 角色朝 +Z 前進：正值 = 在參考點後方
    const trail = (ref: THREE.Object3D, o: THREE.Object3D) => ref.getWorldPosition(a).z - o.getWorldPosition(b).z
    for (let i = 0; i < 180; i++) elf.animate(1 / 60, 0, 'normal')
    const still = [trail(hips, skirt), trail(hand, sleeve)]
    let sk = 0, sl = 0, n = 0
    for (let i = 0; i < 240; i++) {
      elf.root.position.z += 2 / 60
      elf.animate(1 / 60, 0.3, 'normal')
      if (i < 120) continue
      sk += trail(hips, skirt)
      sl += trail(hand, sleeve)
      n++
    }
    expect(elf.anim.current).toBe('Walk')
    expect(sk / n - still[0]).toBeGreaterThan(0.04)
    expect(sl / n - still[1]).toBeGreaterThan(0.03)
    for (let i = 0; i < 300; i++) elf.animate(1 / 60, 0, 'normal')
    expect(Math.abs(trail(hips, skirt) - still[0])).toBeLessThan(0.05)
    elf.dispose()
  })

  it('儀態：走路 / 奔跑時上身平穩，骨盆上下起伏只有幾公分', async () => {
    const { elf } = await loaded()
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
      expect(hi - lo).toBeGreaterThan(0.01)
      expect(hi - lo).toBeLessThan(limit)
    }
    elf.dispose()
  })
  it('走路時的飄動量以紫晶精靈為基準（裙擺往後飄的距離、下襬的擺動速度都不低於她的七成五；正面開衩的長裙飄得一樣開時腿會整個露出來）', async () => {
    const { VIOLINIST_RIG } = await import('../src/game/elf/rigs')
    const measure = async (rig: typeof VIOLINIST_RIG | undefined) => {
      const elf = new ElfCharacter({ rig, load: fileLoad, lowEnd: false, random: () => 0.37 })
      await elf.ready
      const hips = elf.root.getObjectByName('Hips')!, hem = elf.root.getObjectByName('skirt_B4')!
      const a = new THREE.Vector3(), b = new THREE.Vector3()
      for (let i = 0; i < 180; i++) elf.animate(1 / 60, 0, 'normal')
      const still = hips.getWorldPosition(a).z - hem.getWorldPosition(b).z
      let trail = 0, speed = 0, n = 0
      let prev: THREE.Vector3 | null = null
      for (let i = 0; i < 300; i++) {
        elf.root.position.z += 2 / 60
        elf.animate(1 / 60, 0.3, 'normal')
        if (i < 120) continue
        trail += hips.getWorldPosition(a).z - hem.getWorldPosition(b).z - still
        const rel = b.clone().sub(elf.root.position)
        if (prev) speed += rel.distanceTo(prev) * 60
        prev = rel
        n++
      }
      elf.dispose()
      return { trail: trail / n, speed: speed / (n - 1) }
    }
    const harp = await measure(undefined), violin = await measure(VIOLINIST_RIG)
    expect(harp.trail).toBeGreaterThan(violin.trail * 0.75)
    expect(harp.speed).toBeGreaterThan(violin.speed * 0.75)
  })

  // 使用者回饋（2026-11-15）：遊戲中從側面看奔跑不自然——張開雙腿的弓箭步、骨盆壓得很低、裙子被吹成水平露出整雙腿
  it('奔跑的側面輪廓：小步快頻、骨盆不下沉、雙腿在裙子底下，裙擺不被吹成水平', async () => {
    const { elf } = await loaded()
    const hips = elf.root.getObjectByName('Hips')!, hem = elf.root.getObjectByName('skirt_B4')!
    const feet = ['LeftFoot', 'RightFoot'].map((n) => elf.root.getObjectByName(n)!)
    const a = new THREE.Vector3(), b = new THREE.Vector3()
    for (let i = 0; i < 180; i++) elf.animate(1 / 60, 0, 'normal')
    const standing = hips.getWorldPosition(a).y
    let spread = 0, lowest = Infinity, hemTop = -Infinity
    for (let i = 0; i < 300; i++) {
      elf.root.position.z += 7.4 / 60
      elf.animate(1 / 60, 1, 'normal')
      if (i < 120) continue
      lowest = Math.min(lowest, hips.getWorldPosition(a).y)
      hemTop = Math.max(hemTop, hem.getWorldPosition(b).y)
      spread = Math.max(spread, Math.abs(feet[0].getWorldPosition(a).z - feet[1].getWorldPosition(b).z))
    }
    expect(elf.anim.current).toBe('Run')
    expect(spread).toBeLessThan(0.4) // 兩腳前後最多相距 40 cm（原本 62 cm）
    expect(standing - lowest).toBeLessThan(0.045) // 骨盆比站姿低不到 4.5 cm（原本 8 cm）
    expect(hemTop).toBeLessThan(0.66) // 後片下襬的最高點仍在膝蓋附近以下（原本飄到 74 cm）
    elf.dispose()
  })

  it('膝蓋的彎曲集中在關節：膝上 / 膝下 7 cm 以外的腿只跟大腿 / 小腿其中一根骨頭', async () => {
    const { elf } = await loaded()
    const { pos, bind, weight, count } = bindData(elf)
    const knee = bind('LeftLeg')
    let above = 0, below = 0, mixed = 0
    for (let v = 0; v < count; v++) {
      const up = weight(v, /^LeftUpLeg$/), lo = weight(v, /^LeftLeg$/)
      if (up + lo < 0.9) continue
      const dy = pos.getY(v) - knee.y
      if (dy > 0.07 && dy < 0.25) {
        above++
        if (lo > 0.05) mixed++
      } else if (dy < -0.07 && dy > -0.25) {
        below++
        if (up > 0.05) mixed++
      }
    }
    expect(above).toBeGreaterThan(50)
    expect(below).toBeGreaterThan(50)
    expect(mixed).toBe(0)
    elf.dispose()
  })
})

describe('4K 貼圖的下載時機', () => {
  it('閘門（CrazyGames：第一次進入遊玩）打開前不下載，打開後才下載並替換', async () => {
    const { setHiResGate } = await import('../src/game/elf/ElfCharacter')
    let open!: () => void
    setHiResGate(() => new Promise<void>((r) => (open = r)))
    try {
      const loadTexture = vi.fn(async () => new THREE.Texture())
      const elf = new ElfCharacter({ load: fileLoad, fallback: fakeFallback(), lowEnd: false, loadTexture })
      await elf.ready
      await new Promise((r) => setTimeout(r, 0))
      expect(loadTexture).not.toHaveBeenCalled()
      open()
      await new Promise((r) => setTimeout(r, 0))
      expect(loadTexture).toHaveBeenCalledTimes(2)
      elf.dispose()
    } finally {
      setHiResGate(() => Promise.resolve())
    }
  })

  it('閘門打開前角色已釋放：不下載', async () => {
    const { setHiResGate } = await import('../src/game/elf/ElfCharacter')
    let open!: () => void
    setHiResGate(() => new Promise<void>((r) => (open = r)))
    try {
      const loadTexture = vi.fn(async () => new THREE.Texture())
      const elf = new ElfCharacter({ load: fileLoad, fallback: fakeFallback(), lowEnd: false, loadTexture })
      await elf.ready
      elf.dispose()
      open()
      await new Promise((r) => setTimeout(r, 0))
      expect(loadTexture).not.toHaveBeenCalled()
    } finally {
      setHiResGate(() => Promise.resolve())
    }
  })
})
