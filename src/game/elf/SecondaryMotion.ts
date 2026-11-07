import * as THREE from 'three'

// 布料 / 頭髮的次級動畫：世界空間的 Verlet 彈簧骨（與 VRM SpringBone 同一類做法）。
// 每根骨頭的尖端是一個有慣性的質點：
//   - 慣性：上一步的位移 ×(1 - drag)，所以角色走路、轉身、上下起伏、腿擺動都會自然帶動布料
//   - 彈性：拉回「動作中的 rest 方向」（父骨目前姿勢下的原始方向）
//   - 重力：往世界下方（袖子在手舉起時下垂、頭髮在彎腰時垂落）
//   - 碰撞：骨頭上的球 / 膠囊（腿推開裙擺、頭髮貼著背、袖子不穿進身體）
// 在 AnimationMixer 之後呼叫；只寫入彈簧骨自己的 quaternion，不會跟動作互相累積。

export interface SpringParams {
  stiffness: number // 拉回 rest 方向的強度（每 1/60 秒的位移，單位 = 骨長）
  gravity: number // 重力強度（同上）
  drag: number // 0~1，速度衰減
  hitRadius: number // 尖端碰撞半徑（m）
  maxAngle: number // 與 rest 方向的最大夾角（rad），避免極端翻轉
  wind: number // 待機時的微風擾動
  colliders: number // 碰撞群組位元遮罩（COLLIDE.*）
}

export const COLLIDE = { body: 1, legs: 2, arms: 4, head: 8 } as const

export interface ColliderDef {
  from: string // 骨頭名稱
  to?: string // 有的話為膠囊（from → to 的骨頭位置），否則為球
  t0?: number // 膠囊起點沿 from→to 的比例
  t1?: number
  offset?: readonly [number, number, number] // 球心在 from 骨區域空間的偏移
  radius: number
  group: number
}

interface Collider {
  a: THREE.Object3D
  b: THREE.Object3D | null
  t0: number
  t1: number
  offset: THREE.Vector3
  radius: number
  group: number
  pa: THREE.Vector3 // 本步的世界座標（每步更新一次）
  pb: THREE.Vector3
}

interface Joint {
  bone: THREE.Bone
  restQ: THREE.Quaternion
  axis: THREE.Vector3 // 骨頭區域空間中指向尖端的方向
  len: number // 區域空間長度
  tail: THREE.Vector3 // 世界座標
  prev: THREE.Vector3
  p: SpringParams
  phase: number
}

const STEP = 1 / 60
const MAX_STEPS = 4
const TELEPORT = 1.5 // 一幀移動超過這個距離視為瞬移，重設

const _head = new THREE.Vector3()
const _rest = new THREE.Vector3()
const _next = new THREE.Vector3()
const _v = new THREE.Vector3()
const _d0 = new THREE.Vector3()
const _d1 = new THREE.Vector3()
const _c = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _pq = new THREE.Quaternion()
const _pqInv = new THREE.Quaternion()
const _gravity = new THREE.Vector3(0, -1, 0)
const _root = new THREE.Vector3()

export class SecondaryMotion {
  private joints: Joint[] = []
  private colliders: Collider[] = []
  private acc = 0
  private t = 0
  private initialized = false
  private lastRoot = new THREE.Vector3()

  addChain(bones: THREE.Bone[], p: SpringParams) {
    bones.forEach((bone, i) => {
      const child = bones[i + 1] ?? (bone.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined)
      let axis: THREE.Vector3
      let len: number
      if (child && child.parent === bone) {
        axis = child.position.clone()
        len = axis.length()
        axis.normalize()
      } else {
        // 末端骨沒有子骨：Blender / glTF 的骨頭沿區域 +Y，長度沿用上一節
        axis = new THREE.Vector3(0, 1, 0)
        len = i > 0 ? this.joints[this.joints.length - 1].len : 0.2
      }
      this.joints.push({
        bone,
        restQ: bone.quaternion.clone(),
        axis,
        len,
        tail: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        p,
        phase: Math.random() * Math.PI * 2,
      })
    })
  }

  addCollider(def: ColliderDef, find: (name: string) => THREE.Object3D | undefined) {
    const a = find(def.from)
    if (!a) return
    const b = def.to ? (find(def.to) ?? null) : null
    this.colliders.push({
      a,
      b,
      t0: def.t0 ?? 0,
      t1: def.t1 ?? 1,
      offset: new THREE.Vector3(...(def.offset ?? [0, 0, 0])),
      radius: def.radius,
      group: def.group,
      pa: new THREE.Vector3(),
      pb: new THREE.Vector3(),
    })
  }

  get count() {
    return this.joints.length
  }

  get colliderCount() {
    return this.colliders.length
  }

  // root：角色根節點（已設定好世界位置與朝向，且已 updateMatrixWorld）
  update(dt: number, root: THREE.Object3D) {
    if (dt <= 0 || !this.joints.length) return
    root.getWorldPosition(_root)
    if (!this.initialized || _root.distanceTo(this.lastRoot) > TELEPORT) this.settle()
    this.lastRoot.copy(_root)
    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS)
    while (this.acc >= STEP) {
      this.acc -= STEP
      this.t += STEP
      this.step()
    }
    // 不足一步時仍要把骨頭寫回（mixer 不會動彈簧骨，但保險起見維持上一步的結果即可）
  }

  // 尖端放回 rest（第一次 / 瞬移 / 重設）
  private settle() {
    for (const j of this.joints) {
      j.bone.quaternion.copy(j.restQ)
      j.bone.updateWorldMatrix(true, false)
      j.bone.localToWorld(j.tail.copy(j.axis).multiplyScalar(j.len))
      j.prev.copy(j.tail)
    }
    this.initialized = true
  }

  private step() {
    for (const c of this.colliders) {
      c.a.updateWorldMatrix(true, false)
      if (c.b) {
        c.b.updateWorldMatrix(true, false)
        c.a.getWorldPosition(_v)
        c.b.getWorldPosition(_c)
        c.pa.lerpVectors(_v, _c, c.t0)
        c.pb.lerpVectors(_v, _c, c.t1)
      } else {
        c.a.localToWorld(c.pa.copy(c.offset))
        c.pb.copy(c.pa)
      }
    }

    for (const j of this.joints) {
      const { bone, p } = j
      const parent = bone.parent!
      // 動作中的 rest：父骨目前的世界姿勢 × 原始區域旋轉
      bone.quaternion.copy(j.restQ)
      bone.updateWorldMatrix(false, false)
      bone.getWorldPosition(_head)
      bone.localToWorld(_rest.copy(j.axis).multiplyScalar(j.len))
      const lenW = _rest.distanceTo(_head)
      if (lenW < 1e-6) continue
      _d0.subVectors(_rest, _head).divideScalar(lenW)

      // Verlet
      _v.subVectors(j.tail, j.prev).multiplyScalar(1 - p.drag)
      _next.copy(j.tail).add(_v)
      _next.addScaledVector(_d0, p.stiffness * lenW)
      _next.addScaledVector(_gravity, p.gravity * lenW)
      if (p.wind > 0) {
        const w = p.wind * lenW
        _next.x += Math.sin(this.t * 1.3 + j.phase) * w
        _next.z += Math.sin(this.t * 0.9 + j.phase * 1.7) * w * 0.6
      }
      // 長度約束
      _d1.subVectors(_next, _head).normalize()
      // 角度限制
      const cos = _d0.dot(_d1)
      if (cos < Math.cos(p.maxAngle)) {
        _v.copy(_d1).addScaledVector(_d0, -cos).normalize()
        _d1.copy(_d0).multiplyScalar(Math.cos(p.maxAngle)).addScaledVector(_v, Math.sin(p.maxAngle))
      }
      _next.copy(_head).addScaledVector(_d1, lenW)
      // 碰撞
      // 兩輪：推出一個碰撞體並恢復骨長後，可能又碰到相鄰的（例如大腿與小腿膠囊交界）
      for (let pass = 0; pass < (p.colliders ? 2 : 0); pass++) {
        for (const c of this.colliders) {
          if (!(c.group & p.colliders)) continue
          closestOnSegment(_next, c.pa, c.pb, _c)
          const r = c.radius + p.hitRadius
          _v.subVectors(_next, _c)
          const d2 = _v.lengthSq()
          if (d2 < r * r) {
            const d = Math.sqrt(d2)
            if (d > 1e-6) _next.copy(_c).addScaledVector(_v, r / d)
            _d1.subVectors(_next, _head).normalize()
            _next.copy(_head).addScaledVector(_d1, lenW)
          }
        }
      }
      j.prev.copy(j.tail)
      j.tail.copy(_next)

      // 世界空間的旋轉差 → 區域 quaternion：parent⁻¹ · Δ · parent · rest
      _q.setFromUnitVectors(_d0, _d1)
      parent.getWorldQuaternion(_pq)
      _pqInv.copy(_pq).invert()
      bone.quaternion.copy(_pqInv).multiply(_q).multiply(_pq).multiply(j.restQ)
      bone.updateWorldMatrix(false, false)
    }
  }

  reset() {
    for (const j of this.joints) j.bone.quaternion.copy(j.restQ)
    this.initialized = false
    this.acc = 0
  }

  // 除錯 / 測試：rest pose 下各尖端與碰撞體的最小餘裕（負值代表 rest 就已穿入）
  restClearance(root: THREE.Object3D) {
    this.reset()
    root.updateMatrixWorld(true)
    this.settle()
    this.step()
    let worst = Infinity
    let name = ''
    for (const j of this.joints) {
      for (const c of this.colliders) {
        if (!(c.group & j.p.colliders)) continue
        j.bone.quaternion.copy(j.restQ)
        j.bone.updateWorldMatrix(true, false)
        j.bone.localToWorld(_rest.copy(j.axis).multiplyScalar(j.len))
        closestOnSegment(_rest, c.pa, c.pb, _c)
        const m = _rest.distanceTo(_c) - c.radius - j.p.hitRadius
        if (m < worst) {
          worst = m
          name = `${j.bone.name}↔${c.a.name}`
        }
      }
    }
    this.reset()
    return { worst, name }
  }
}

const _ab = new THREE.Vector3()
const _ap = new THREE.Vector3()

function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3) {
  _ab.subVectors(b, a)
  const l2 = _ab.lengthSq()
  if (l2 < 1e-10) return out.copy(a)
  const t = Math.min(1, Math.max(0, _ap.subVectors(p, a).dot(_ab) / l2))
  return out.copy(a).addScaledVector(_ab, t)
}

// 值以 1/60 秒為一步：stiffness / gravity 是每步相對骨長的位移
export const SPRINGS = {
  hair: { stiffness: 0.05, gravity: 0.02, drag: 0.16, hitRadius: 0.025, maxAngle: 1.2, wind: 0.002, colliders: COLLIDE.body | COLLIDE.arms | COLLIDE.head },
  skirt: { stiffness: 0.09, gravity: 0.012, drag: 0.2, hitRadius: 0.03, maxAngle: 0.9, wind: 0.0012, colliders: COLLIDE.legs | COLLIDE.body },
  sleeve: { stiffness: 0.035, gravity: 0.05, drag: 0.14, hitRadius: 0.03, maxAngle: 2.4, wind: 0.002, colliders: COLLIDE.body | COLLIDE.legs },
} satisfies Record<string, SpringParams>
