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
  // 以下為選用（薄紗用）。不設定時空氣阻力 = drag、沒有上限，與原本的行為完全相同
  air?: number // 0~1，角色移動時迎面的風：每步把尖端往後帶「角色位移 × air」
  airMax?: number // 迎風位移的上限（每步，單位 = 骨長）：走路就飄得起來，跑步也不會被吹成水平
  flutter?: number // 移動時的抖動（與速度成正比，沿骨鏈有相位差 → 往下傳的波紋）
  // 0~1，角色速度改變（起跑、急停、衝鋒）時布料承受的慣性比例。預設 1 = 完全的慣性：
  // 遊戲裡的角色是瞬間加減速，薄紗會整片被甩到身體前面 / 甩成水平
  inertia?: number
  // 抖動 / 微風的相位各骨鏈一致（預設每條鏈各自亂數）。疊了好幾層的裙子要設 true：
  // 相鄰骨鏈各抖各的會讓內外層互相剪穿；相位一致時整件裙子是同一道由上往下傳的波紋，層與層一起動
  flutterSync?: boolean
  // 抖動幅度隨速度增加的上限（每步位移，預設 0.07 ≈ 4.2 m/s）：設成走路的速度時，奔跑不會抖得比走路更大
  flutterMax?: number
}

export const COLLIDE = { body: 1, legs: 2, arms: 4, head: 8, skirt: 16 } as const

export interface ColliderDef {
  from: string // 骨頭名稱
  to?: string // 有的話為膠囊（from → to 的骨頭位置），否則為球
  t0?: number // 膠囊起點沿 from→to 的比例
  t1?: number
  offset?: readonly [number, number, number] // 球心在 from 骨區域空間的偏移
  radius: number
  radiusEnd?: number // 膠囊末端（to / t1）的半徑：與 radius 不同時是圓錐（裙子）
  group: number
}

interface Collider {
  a: THREE.Object3D
  b: THREE.Object3D | null
  t0: number
  t1: number
  offset: THREE.Vector3
  radius: number
  radiusEnd: number
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
  ripple: number // 沿骨鏈遞增的相位（波紋）
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
const _air = new THREE.Vector3()
const _side = new THREE.Vector3()

export class SecondaryMotion {
  // 抖動 / 微風的相位來源（測試時換成固定值，量測才可重現）
  random: () => number = Math.random
  private joints: Joint[] = []
  private colliders: Collider[] = []
  private acc = 0
  private t = 0
  private initialized = false
  private lastRoot = new THREE.Vector3()
  // 角色每一步（1/60 秒）的位移：迎風與抖動用
  private rootStep = new THREE.Vector3()
  private prevRootStep = new THREE.Vector3()

  addChain(bones: THREE.Bone[], p: SpringParams) {
    const base = p.flutterSync ? 0 : this.random() * Math.PI * 2
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
        phase: p.flutterSync ? 0 : this.random() * Math.PI * 2,
        ripple: base - i * 1.1,
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
      radiusEnd: def.radiusEnd ?? def.radius,
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
    const teleport = !this.initialized || _root.distanceTo(this.lastRoot) > TELEPORT
    if (teleport) {
      this.settle()
      this.rootStep.set(0, 0, 0)
      this.prevRootStep.set(0, 0, 0)
    } else this.rootStep.subVectors(_root, this.lastRoot).multiplyScalar(STEP / dt)
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

      // Verlet。尖端的位移 = 角色的位移 + 相對位移：相對位移以 drag 衰減（布料自己的阻尼），
      // 角色的位移則有一部分（air）被空氣擋下來 → 布料往後飄。air 預設 = drag、不設上限時等同於整體乘上 (1 - drag)
      // 相對位移以「上一步的角色位移」為基準；角色速度的變化量只有 inertia 的比例轉成布料的相對運動
      _v.subVectors(j.tail, j.prev).sub(this.prevRootStep)
      if (p.inertia !== undefined) {
        // 衝擊量另設上限（衝鋒 24 m/s 的瞬間加速，否則尾端會翹過水平）
        _air.subVectors(this.prevRootStep, this.rootStep).multiplyScalar(p.inertia)
        const kick = _air.length()
        const cap = 0.22 * lenW
        if (kick > cap) _air.multiplyScalar(cap / kick)
        _v.add(_air)
      } else _v.add(this.prevRootStep).sub(this.rootStep)
      _v.multiplyScalar(1 - p.drag)
      _air.copy(this.rootStep).multiplyScalar(p.air ?? p.drag)
      const speed = this.rootStep.length()
      if (p.airMax !== undefined) {
        const push = _air.length()
        const cap = p.airMax * lenW
        if (push > cap) _air.multiplyScalar(cap / push)
      }
      _next.copy(j.tail).add(this.rootStep).add(_v).sub(_air)
      if (p.flutter && speed > 1e-4) {
        // 垂直於前進方向的抖動：左右 + 上下，頻率不同、沿骨鏈往下傳
        const f = p.flutter * Math.min(speed, p.flutterMax ?? 0.07)
        _side.set(this.rootStep.z, 0, -this.rootStep.x).divideScalar(speed)
        _next.addScaledVector(_side, Math.sin(this.t * 13 + j.ripple) * f * 0.5)
        _next.y += Math.sin(this.t * 9.1 + j.ripple * 1.4 + j.phase) * f
      }
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
          const r = c.radius + (c.radiusEnd - c.radius) * _segT + p.hitRadius
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
    this.prevRootStep.copy(this.rootStep)
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
        const m = _rest.distanceTo(_c) - (c.radius + (c.radiusEnd - c.radius) * _segT) - j.p.hitRadius
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

// 最近點在線段上的參數（0 = a、1 = b）：圓錐碰撞體依此內插半徑
let _segT = 0

function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3) {
  _ab.subVectors(b, a)
  const l2 = _ab.lengthSq()
  _segT = 0
  if (l2 < 1e-10) return out.copy(a)
  _segT = Math.min(1, Math.max(0, _ap.subVectors(p, a).dot(_ab) / l2))
  return out.copy(a).addScaledVector(_ab, _segT)
}

// 值以 1/60 秒為一步：stiffness / gravity 是每步相對骨長的位移
export const SPRINGS = {
  hair: { stiffness: 0.05, gravity: 0.02, drag: 0.16, hitRadius: 0.025, maxAngle: 1.2, wind: 0.002, colliders: COLLIDE.body | COLLIDE.arms | COLLIDE.head },
  skirt: { stiffness: 0.09, gravity: 0.012, drag: 0.2, hitRadius: 0.03, maxAngle: 0.9, wind: 0.0012, colliders: COLLIDE.legs | COLLIDE.body },
  sleeve: { stiffness: 0.035, gravity: 0.05, drag: 0.14, hitRadius: 0.03, maxAngle: 2.4, wind: 0.002, colliders: COLLIDE.body | COLLIDE.legs },
  // 紫晶精靈：薄紗長裙與垂袖——回彈弱、空氣阻力大，走動時往後飄、停下來慢慢落回
  silk: { stiffness: 0.03, gravity: 0.018, drag: 0.12, air: 0.16, airMax: 0.036, flutter: 0.045, inertia: 0.4, hitRadius: 0.035, maxAngle: 0.85, wind: 0.002, colliders: COLLIDE.legs | COLLIDE.body },
  drape: { stiffness: 0.022, gravity: 0.022, drag: 0.1, air: 0.16, airMax: 0.04, flutter: 0.06, inertia: 0.4, hitRadius: 0.035, maxAngle: 1.0, wind: 0.0025, colliders: COLLIDE.body | COLLIDE.legs },
  // 豎琴精靈的多層長裙（綠色外裙疊在白色襯裙上、下襬是一片片尖角）。
  // 走路時往後飄約 30 cm（紫晶精靈的薄紗 38 cm 的八成：這件裙子正面開衩，飄得一樣開時側面看整雙腿都露在外面）；
  // 奔跑時不再加大（airMax / maxAngle 收小），裙子維持蓋住腿、往後拖的鐘形。
  // flutterSync：各骨鏈的抖動相位一致（各抖各的時，疊在一起的幾層布互相剪穿，綠色外裙上冒出白色襯裙的碎片）；
  // hitRadius 較大：奔跑時腿擺得快，裙擺節點要離腿遠一點才不會被追上
  gown: { stiffness: 0.04, gravity: 0.022, drag: 0.12, air: 0.15, airMax: 0.026, flutter: 0.07, flutterSync: true, flutterMax: 0.04, inertia: 0.35, hitRadius: 0.05, maxAngle: 0.55, wind: 0.002, colliders: COLLIDE.legs | COLLIDE.body },
  // 豎琴精靈的寬袖：重力為主（手舉高時仍往下垂）、回彈很弱，走動時往後飄；披在裙子的圓錐外面
  veil: { stiffness: 0.02, gravity: 0.05, drag: 0.12, air: 0.16, airMax: 0.03, flutter: 0.07, flutterSync: true, flutterMax: 0.035, inertia: 0.3, hitRadius: 0.03, maxAngle: 2.6, wind: 0.002, colliders: COLLIDE.body | COLLIDE.skirt },
  // 紫晶精靈背後的長髮：比薄紗重，飄得少、落得快
  tress: { stiffness: 0.14, gravity: 0.03, drag: 0.3, air: 0.1, airMax: 0.02, flutter: 0.012, inertia: 0.3, hitRadius: 0.008, maxAngle: 0.55, wind: 0.0012, colliders: COLLIDE.body },
} satisfies Record<string, SpringParams>
