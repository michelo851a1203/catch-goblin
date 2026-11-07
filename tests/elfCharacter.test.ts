import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { ElfCharacter } from '../src/game/elf/ElfCharacter'
import { ELF_CLIPS, ELF_COLLIDERS } from '../src/game/elf/assets'
import type { CharacterModel, Pose } from '../src/game/models'
import { fakeFallback, fileLoad } from './helpers'

const ALL_POSES: Pose[] = ['normal', 'stunned', 'rooted', 'held', 'cast', 'play', 'attack', 'pack']

async function loaded() {
  const fb = fakeFallback()
  const elf = new ElfCharacter({ load: fileLoad, fallback: fb, lowEnd: false })
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
    expect(chain).toContain('handL')
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
    const arm = elf.root.getObjectByName('upper_armL')!
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
    // 頭髮 5×3 + 裙擺 8×3 + 袖子 2×2
    expect(elf.springs.count).toBe(43)
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
    const sk = elf.root.getObjectByName('skirt_L3')!
    const a = sk.getWorldPosition(new THREE.Vector3())
    for (let i = 0; i < 30; i++) elf.animate(1 / 60, 0, 'normal')
    const b = sk.getWorldPosition(new THREE.Vector3())
    expect(a.distanceTo(b)).toBeLessThan(0.02)
    elf.root.traverse((o) => {
      if ((o as THREE.Bone).isBone) expect(Number.isFinite(o.quaternion.x)).toBe(true)
    })
  })

  it('袖子受重力：手舉高（勝利動作）時袖子仍往下垂', async () => {
    const { elf } = await loaded()
    elf.setVictory(true)
    for (let i = 0; i < 120; i++) elf.animate(1 / 60, 0, 'normal')
    const s1 = elf.root.getObjectByName('sleeveL')!.getWorldPosition(new THREE.Vector3())
    const s2 = elf.root.getObjectByName('sleeve2L')!.getWorldPosition(new THREE.Vector3())
    expect(s2.y).toBeLessThan(s1.y) // 第二節在第一節下方
  })

  it('跑步時裙擺被腿推開：裙擺骨尖端不會穿進腿裡', async () => {
    const { elf } = await loaded()
    const legs = ['thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'].map((n) => elf.root.getObjectByName(n)!)
    const skirt: THREE.Object3D[] = []
    elf.root.traverse((o) => /^skirt_.*[23]$/.test(o.name) && skirt.push(o))
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
          for (const [from, to, r] of [[legs[l], legs[l + 1], 0.075], [legs[l + 1], legs[l + 2], 0.055]] as const) {
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
    const feet = ['footL', 'footR'].map((n) => elf.root.getObjectByName(n)!)
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
    const head = elf.root.getObjectByName('head')!.getWorldPosition(new THREE.Vector3())
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

  it('模型尺寸與朝向：約 1.75m 高、面向 +Z、腳在地面', async () => {
    const { elf } = await loaded()
    elf.animate(0.016, 0, 'normal')
    elf.root.updateMatrixWorld(true)
    const head = elf.root.getObjectByName('head')!.getWorldPosition(new THREE.Vector3())
    const toe = elf.root.getObjectByName('footL')!
    const ankle = toe.getWorldPosition(new THREE.Vector3())
    expect(head.y).toBeGreaterThan(1.4)
    expect(head.y).toBeLessThan(1.6)
    // 腳尖骨的 +Y（骨頭方向）指向角色正面 +Z
    const toeDir = new THREE.Vector3(0, 1, 0).applyQuaternion(toe.getWorldQuaternion(new THREE.Quaternion()))
    expect(toeDir.z).toBeGreaterThan(0.5)
    expect(ankle.y).toBeLessThan(0.15)
  })
})
