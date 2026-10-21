import * as THREE from 'three'

export interface SpringParams {
  stiffness: number
  damping: number
  drag: number // 移動時往後飄的強度
  flare: number // 移動時往外張開的強度（裙擺）
  gravity: number // 讓骨頭在手臂舉起時依然下垂（袖子）
  sway: number // 待機時的輕微飄動
  maxAngle: number
}

interface SpringBone {
  bone: THREE.Bone
  rest: THREE.Quaternion
  restDir: THREE.Vector3 // 骨頭在父空間的方向（rest pose）
  offset: THREE.Vector3 // 角色空間的尖端偏移（彈簧狀態）
  vel: THREE.Vector3
  p: SpringParams
  depth: number
  phase: number
}

const _v = new THREE.Vector3()
const _target = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qInv = new THREE.Quaternion()
const _local = new THREE.Vector3()
const _down = new THREE.Vector3()
const _rootInv = new THREE.Quaternion()

// 以骨頭為單位的彈簧次級動畫（頭髮、裙擺、紗袖）。
// 在 AnimationMixer 更新之後呼叫：以 rest pose 為基準疊加旋轉，所以不會跟動作互相累積。
export class SecondaryMotion {
  private bones: SpringBone[] = []
  private t = 0
  private prevPos = new THREE.Vector3()
  private prevYaw = 0
  private hasPrev = false
  private velLocal = new THREE.Vector3()
  private turn = 0

  addChain(bones: THREE.Bone[], p: SpringParams) {
    bones.forEach((bone, i) => {
      // Blender / glTF 的骨頭沿區域 +Y 延伸；末端骨沒有子骨可參考，所以一律用 +Y
      const restDir = new THREE.Vector3(0, 1, 0).applyQuaternion(bone.quaternion)
      this.bones.push({
        bone,
        rest: bone.quaternion.clone(),
        restDir,
        offset: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        p,
        depth: i,
        phase: Math.random() * 6.28,
      })
    })
  }

  get count() {
    return this.bones.length
  }

  // root：角色根節點（已設定好世界位置與朝向）
  update(dt: number, root: THREE.Object3D) {
    if (dt <= 0) return
    this.t += dt
    const yaw = root.rotation.y
    if (this.hasPrev) {
      _v.subVectors(root.position, this.prevPos).divideScalar(dt)
      _rootInv.setFromAxisAngle(_axis.set(0, 1, 0), -yaw)
      _v.applyQuaternion(_rootInv)
      this.velLocal.lerp(_v, Math.min(1, dt * 10))
      const dy = Math.atan2(Math.sin(yaw - this.prevYaw), Math.cos(yaw - this.prevYaw)) / dt
      this.turn += (dy - this.turn) * Math.min(1, dt * 8)
    }
    this.prevPos.copy(root.position)
    this.prevYaw = yaw
    this.hasPrev = true
    const speed = Math.min(8, Math.hypot(this.velLocal.x, this.velLocal.z))

    for (const s of this.bones) {
      const { p } = s
      // 角色空間中的目標偏移
      _target.set(-this.velLocal.x, 0, -this.velLocal.z).multiplyScalar(p.drag * 0.12)
      _target.x += this.turn * p.drag * 0.05
      if (p.flare > 0) {
        _dir.copy(s.restDir).setY(0)
        if (_dir.lengthSq() > 1e-4) _target.addScaledVector(_dir.normalize(), speed * p.flare * 0.04)
      }
      const sw = p.sway * (1 + s.depth * 0.5)
      _target.x += Math.sin(this.t * 1.7 + s.phase) * sw
      _target.z += Math.sin(this.t * 1.3 + s.phase * 1.7) * sw * 0.6
      _target.y += speed * p.drag * 0.01
      // 彈簧積分
      _v.subVectors(_target, s.offset).multiplyScalar(p.stiffness)
      _v.addScaledVector(s.vel, -p.damping)
      s.vel.addScaledVector(_v, dt)
      s.offset.addScaledVector(s.vel, dt)
      if (s.offset.lengthSq() > p.maxAngle * p.maxAngle) s.offset.setLength(p.maxAngle)

      // 把角色空間的偏移轉到父骨頭空間：parentWorld⁻¹ · rootWorld
      const parent = s.bone.parent!
      parent.getWorldQuaternion(_qInv).invert()
      root.getWorldQuaternion(_q)
      _local.copy(s.offset).applyQuaternion(_q).applyQuaternion(_qInv)
      // 重力：世界向下轉到父空間
      if (p.gravity > 0) {
        _down.set(0, -1, 0).applyQuaternion(_qInv)
        _local.addScaledVector(_down, p.gravity)
      }
      // 將 rest 方向往（rest 方向 + 偏移）旋轉
      _dir.copy(s.restDir).add(_local).normalize()
      _q.setFromUnitVectors(s.restDir, _dir)
      s.bone.quaternion.copy(_q).multiply(s.rest)
      s.bone.updateMatrixWorld(true)
    }
  }

  reset() {
    for (const s of this.bones) {
      s.offset.set(0, 0, 0)
      s.vel.set(0, 0, 0)
      s.bone.quaternion.copy(s.rest)
    }
    this.hasPrev = false
  }
}

export const SPRINGS = {
  hair: { stiffness: 38, damping: 7, drag: 1.0, flare: 0, gravity: 0, sway: 0.03, maxAngle: 0.9 },
  skirt: { stiffness: 70, damping: 10, drag: 0.55, flare: 1.0, gravity: 0, sway: 0.012, maxAngle: 0.5 },
  sleeve: { stiffness: 45, damping: 6, drag: 0.7, flare: 0, gravity: 0.7, sway: 0.03, maxAngle: 1.2 },
} satisfies Record<string, SpringParams>
