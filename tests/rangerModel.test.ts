// 遊俠精靈（長笛遊俠）的 GLB：動作、節點、LOD、長笛掛點與握持、步態儀態（tools/blender/build_ranger.py 的輸出）
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ElfCharacter } from '../src/game/elf/ElfCharacter'
import { RANGER_ANIM, RANGER_CLIPS, RANGER_FLUTE, RANGER_RIG, rigOf } from '../src/game/elf/rigs'
import { RANGER_GLB, fileLoad, parseGlb } from './helpers'

const loaded = async () => {
  const elf = new ElfCharacter({ rig: RANGER_RIG, load: fileLoad, lowEnd: false, random: () => 0.37 })
  await elf.ready
  return elf
}
const world = (o: THREE.Object3D, local: readonly number[] = [0, 0, 0]) => {
  o.updateWorldMatrix(true, false)
  return new THREE.Vector3(local[0], local[1], local[2]).applyMatrix4(o.matrixWorld)
}

describe('遊俠精靈 GLB', () => {
  it('rigOf：ranger 對應遊俠的規格', () => {
    expect(rigOf('ranger')).toBe(RANGER_RIG)
    expect(RANGER_RIG.kind).toBe('ranger')
  })

  it('包含所有動作，長度與規格一致', async () => {
    const gltf = await parseGlb(RANGER_GLB)
    const dur = Object.fromEntries(gltf.animations.map((a) => [a.name, a.duration]))
    expect(Object.keys(dur).sort()).toEqual([...RANGER_CLIPS].sort())
    for (const c of RANGER_CLIPS) expect(RANGER_ANIM.clips[c], c).toBeDefined()
    for (const c of Object.values(RANGER_ANIM.poseClip)) expect(RANGER_CLIPS).toContain(c)
    expect(dur.Run).toBeCloseTo(10 / 24, 2)
    expect(dur.Walk).toBeCloseTo(16 / 24, 2)
    expect(dur.Shoot).toBeCloseTo(20 / 24, 2)
    expect(dur.Plant).toBeCloseTo(14 / 24, 2)
    expect(dur.Leap).toBeCloseTo(12 / 24, 2)
  })

  it('節點：兩個 LOD、長笛掛在 prop_flute、手指骨、Mixamo 命名的軀幹骨', async () => {
    const gltf = await parseGlb(RANGER_GLB)
    const s = gltf.scene
    for (const n of [...RANGER_RIG.lod, 'prop_flute', 'Flute', 'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'RightHand',
      'LeftFingers1', 'LeftFingers2', 'RightFingers1', 'RightFingers2'])
      expect(s.getObjectByName(n), n).toBeTruthy()
    const flute = s.getObjectByName('Flute')!
    let p: THREE.Object3D | null = flute.parent
    while (p && p.name !== 'prop_flute') p = p.parent
    expect(p?.name).toBe('prop_flute')
    expect(s.getObjectByName('prop_flute')!.parent!.name).toBe('RightHand')
    let mat = false
    s.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined
      if (m && m.name === RANGER_RIG.atlasMaterial) mat = true
    })
    expect(mat).toBe(true)
  })

  it('角色身高約 1.7 m、腳底在地面；LOD1 的面數明顯少於 LOD0', async () => {
    const gltf = await parseGlb(RANGER_GLB)
    const tris = (n: string) => {
      let t = 0
      gltf.scene.getObjectByName(n)!.traverse((o) => {
        const g = (o as THREE.Mesh).geometry
        if (g) t += (g.index ? g.index.count : g.attributes.position.count) / 3
      })
      return t
    }
    const t0 = tris('RangerMesh_LOD0'), t1 = tris('RangerMesh_LOD1')
    expect(t0).toBeGreaterThan(30000)
    expect(t1).toBeLessThan(t0 * 0.4)
    let lo = Infinity, hi = -Infinity
    gltf.scene.getObjectByName('RangerMesh_LOD0')!.traverse((o) => {
      const g = (o as THREE.Mesh).geometry
      if (!g) return
      g.computeBoundingBox()
      lo = Math.min(lo, g.boundingBox!.min.y)
      hi = Math.max(hi, g.boundingBox!.max.y)
    })
    expect(lo).toBeGreaterThan(-0.02)
    expect(lo).toBeLessThan(0.02)
    expect(hi).toBeGreaterThan(1.65)
    expect(hi).toBeLessThan(1.75)
  })

  it('RANGER_FLUTE：喇叭口 / 吹口的區域座標落在長笛網格的兩端（全長 0.6 m）', async () => {
    const gltf = await parseGlb(RANGER_GLB)
    const socket = gltf.scene.getObjectByName(RANGER_FLUTE.socket)!
    const flute = gltf.scene.getObjectByName('Flute')!
    gltf.scene.updateMatrixWorld(true)
    const pts: THREE.Vector3[] = []
    flute.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.geometry) return
      const pos = m.geometry.attributes.position
      for (let i = 0; i < pos.count; i += 3) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld))
    })
    const tip = world(socket, RANGER_FLUTE.tip), mouth = world(socket, RANGER_FLUTE.mouth)
    expect(tip.distanceTo(mouth)).toBeCloseTo(0.6, 2)
    const axis = tip.clone().sub(mouth).normalize()
    const ts = pts.map((p) => p.clone().sub(mouth).dot(axis))
    expect(Math.min(...ts)).toBeGreaterThan(-0.01)
    expect(Math.min(...ts)).toBeLessThan(0.01)
    expect(Math.max(...ts)).toBeGreaterThan(0.59)
    expect(Math.max(...ts)).toBeLessThan(0.61)
  })
})

describe('遊俠精靈：動作', () => {
  it('姿勢對應的動作：射箭 / 陷阱 / 後躍 / 收網 / 暈眩', async () => {
    const elf = await loaded()
    for (const [pose, clip] of [['shoot', 'Shoot'], ['cast', 'Shoot'], ['plant', 'Plant'], ['attack', 'Plant'], ['leap', 'Leap'], ['dash', 'Leap'], ['pack', 'Capture'], ['play', 'Play'], ['stunned', 'Stunned']] as const) {
      elf.animate(1 / 60, 0, pose)
      expect(elf.anim.current, pose).toBe(clip)
    }
    elf.animate(1 / 60, 0, 'normal')
    expect(elf.anim.current).toBe('Idle')
    elf.animate(1 / 60, 1, 'normal')
    expect(elf.anim.current).toBe('Run')
    elf.dispose()
  })

  it('長笛一直握在右手裡：每個動作中，握點（prop_flute 原點）離右手掌心不到 5 cm', async () => {
    const elf = await loaded()
    const hand = elf.root.getObjectByName('RightHand')!, f1 = elf.root.getObjectByName('RightFingers1')!, socket = elf.root.getObjectByName('prop_flute')!
    for (const [pose, move] of [['normal', 0], ['normal', 1], ['play', 0], ['shoot', 0], ['plant', 0], ['leap', 0], ['pack', 0], ['stunned', 0]] as const) {
      let worst = 0
      for (let i = 0; i < 90; i++) {
        elf.animate(1 / 60, move, pose)
        elf.root.updateMatrixWorld(true)
        // 掌心：手腕與指根之間
        const palm = world(hand).lerp(world(f1), 0.7)
        worst = Math.max(worst, palm.distanceTo(world(socket)))
      }
      expect(worst, `${pose}/${move}`).toBeLessThan(0.05)
    }
    elf.dispose()
  })

  it('吹奏（Play / Capture）：吹口端在嘴邊、左手也握在笛身上', async () => {
    const elf = await loaded()
    const head = elf.root.getObjectByName('Head')!, socket = elf.root.getObjectByName('prop_flute')!
    const lh = elf.root.getObjectByName('LeftHand')!, lf = elf.root.getObjectByName('LeftFingers1')!
    for (const pose of ['play', 'pack'] as const) {
      for (let i = 0; i < 60; i++) elf.animate(1 / 60, 0, pose)
      for (let i = 0; i < 120; i++) {
        elf.animate(1 / 60, 0, pose)
        elf.root.updateMatrixWorld(true)
        const tip = world(socket, RANGER_FLUTE.tip), mouth = world(socket, RANGER_FLUTE.mouth)
        const axis = tip.clone().sub(mouth).normalize()
        // 嘴唇（頭骨原點上方 3 cm、前方 9 cm）離笛身軸線不到 4 cm，而且在吹口端 5～10 cm 處
        const lips = world(head, [0, 0.028, 0.09])
        const t = lips.clone().sub(mouth).dot(axis)
        const off = lips.clone().sub(mouth).addScaledVector(axis, -t).length()
        expect(off, pose).toBeLessThan(0.04)
        expect(t).toBeGreaterThan(0.04)
        expect(t).toBeLessThan(0.11)
        // 左手掌心離笛身軸線不到 5 cm
        const palm = world(lh).lerp(world(lf), 0.7)
        const tp = palm.clone().sub(mouth).dot(axis)
        expect(palm.clone().sub(mouth).addScaledVector(axis, -tp).length(), pose).toBeLessThan(0.05)
        // 笛身大致水平、往角色右方伸出去（角色面向 +Z，右方是 -X）
        expect(axis.x).toBeLessThan(-0.8)
      }
    }
    elf.dispose()
  })

  it('儀態：奔跑 / 走路時骨盆維持高度、上下起伏只有幾公分，雙腳不陷進地面', async () => {
    const elf = await loaded()
    const hips = elf.root.getObjectByName('Hips')!
    const feet = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'].map((n) => elf.root.getObjectByName(n)!)
    for (const [move, speed, limit] of [[0.27, 2, 0.045], [1, 7.4, 0.06]] as const) {
      let lo = Infinity, hi = -Infinity, toe = Infinity
      for (let i = 0; i < 240; i++) {
        elf.root.position.z += speed / 60
        elf.animate(1 / 60, move, 'normal')
        if (i < 120) continue
        elf.root.updateMatrixWorld(true)
        const y = world(hips).y
        lo = Math.min(lo, y)
        hi = Math.max(hi, y)
        for (const f of feet) toe = Math.min(toe, world(f).y)
      }
      expect(hi - lo).toBeGreaterThan(0.005)
      expect(hi - lo).toBeLessThan(limit)
      // 站姿骨盆高 1.025 m：跑步時也不壓低超過 9 cm（不是弓箭步）
      expect(lo).toBeGreaterThan(0.93)
      expect(toe).toBeGreaterThan(0.0)
    }
    elf.dispose()
  })

  it('奔跑不滑步：支撐腳相對地面幾乎不動（玩家速度 7.4 m/s）', async () => {
    const elf = await loaded()
    const foot = elf.root.getObjectByName('LeftFoot')!
    let slide = 0, n = 0
    let prev: THREE.Vector3 | null = null
    for (let i = 0; i < 300; i++) {
      elf.root.position.z += 7.4 / 60
      elf.animate(1 / 60, 1, 'normal')
      if (i < 120) continue
      elf.root.updateMatrixWorld(true)
      const p = world(foot)
      // 腳踝在最低點附近（支撐期中段）時量水平位移
      if (prev && p.y < 0.165 && prev.y < 0.165) {
        slide += Math.abs(p.z - prev.z)
        n++
      }
      prev = p
    }
    expect(n).toBeGreaterThan(5)
    // 每格（1/60 s）角色前進 12.3 cm；支撐腳的位移遠小於此
    expect(slide / n).toBeLessThan(0.035)
    elf.dispose()
  })

  it('後躍：動作本身不水平位移（由遊戲移動角色），騰空時骨盆抬高', async () => {
    const elf = await loaded()
    const hips = elf.root.getObjectByName('Hips')!
    for (let i = 0; i < 30; i++) elf.animate(1 / 60, 0, 'normal')
    const y0 = world(hips).y
    let hi = -Infinity, drift = 0
    for (let i = 0; i < 30; i++) {
      elf.animate(1 / 60, 0, 'leap')
      elf.root.updateMatrixWorld(true)
      const p = world(hips)
      hi = Math.max(hi, p.y)
      drift = Math.max(drift, Math.hypot(p.x, p.z))
    }
    expect(hi - y0).toBeGreaterThan(0.2)
    expect(hi - y0).toBeLessThan(0.5)
    expect(drift).toBeLessThan(0.08)
    elf.dispose()
  })
})
