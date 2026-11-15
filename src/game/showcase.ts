import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { ElfKind, Role } from './config'
import { ElfCharacter } from './elf/ElfCharacter'
import { disposeObject } from './elf/dispose'
import { rigOf } from './elf/rigs'
import { createGoblin, type CharacterModel } from './models'
import { releaseToonGpu } from './toon'

// 選角詳情頁左側的角色展示（只在桌機版顯示）：
// 一律以最高品質呈現——LOD0、高解析貼圖、滿解析度、柔和陰影與描邊，可拖曳旋轉角色
export class CharacterShowcase {
  private renderer: THREE.WebGLRenderer
  private effect: OutlineEffect
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50)
  private controls: OrbitControls
  private model: CharacterModel
  private elf: ElfCharacter | null = null
  private env: THREE.WebGLRenderTarget
  private ground: THREE.Mesh<THREE.CircleGeometry, THREE.ShadowMaterial>
  private clock = new THREE.Clock()
  private raf = 0
  private observer: ResizeObserver
  private disposed = false
  // 載入完成：true = 角色已顯示；false = 下載失敗（重試用完）
  readonly ready: Promise<boolean>

  private host: HTMLElement

  constructor(host: HTMLElement, role: Role, kind: ElfKind = 'harp') {
    this.host = host
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 3))
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab'
    host.appendChild(this.renderer.domElement)
    this.effect = new OutlineEffect(this.renderer, { defaultThickness: 0.0035, defaultColor: [0.1, 0.07, 0.05] })

    // 與遊戲相同的打光（半球光 + 暖色主光 + 環境反射），另加一道冷色輪廓光把角色從深色背景分離出來
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.env = pmrem.fromScene(room, 0.04)
    room.dispose()
    pmrem.dispose()
    this.scene.environment = this.env.texture
    this.scene.environmentIntensity = 0.55
    this.scene.add(new THREE.HemisphereLight(0xdff0ff, 0x5a7a32, 1.6))
    const sun = new THREE.DirectionalLight(0xfff0d0, 2.4)
    sun.position.set(2.5, 5, 3.5)
    sun.castShadow = true
    sun.shadow.mapSize.setScalar(4096)
    sun.shadow.bias = -0.0005
    sun.shadow.radius = 4
    Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.5, far: 15 })
    const rim = new THREE.DirectionalLight(0xbfe8d0, 1.2)
    rim.position.set(-3, 2.5, -3)
    this.scene.add(sun, rim)

    // 只接收陰影的透明地面：角色站在詳情頁的綠灰底色上
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.ShadowMaterial({ opacity: 0.35 }))
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.ground.material.userData.outlineParameters = { visible: false }
    this.scene.add(this.ground)

    if (role === 'elf') {
      // 不放程序化替身：載入期間只顯示載入動畫，GLB 載入完成才出現角色
      this.elf = new ElfCharacter({ rig: rigOf(kind), fallback: null, lowEnd: false, blink: true })
      this.elf.forceLod(0)
      // 站定展示：停在待機動作的第一格，不隨待機動作搖晃（頭髮、裙擺的次級動畫會跟著靜止），只保留眨眼
      this.elf.holdPose(true)
      this.model = this.elf
    } else this.model = createGoblin(0)
    this.model.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true
    })
    // 稍微側身面向鏡頭
    this.model.root.rotation.y = -0.35
    this.scene.add(this.model.root)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.enablePan = false
    this.controls.minPolarAngle = Math.PI * 0.3
    this.controls.maxPolarAngle = Math.PI * 0.55
    this.controls.addEventListener('start', () => (this.renderer.domElement.style.cursor = 'grabbing'))
    this.controls.addEventListener('end', () => (this.renderer.domElement.style.cursor = 'grab'))
    this.measure()

    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
    this.resize()
    this.ready = (this.elf?.ready ?? Promise.resolve()).then(() => {
      if (this.disposed) return false
      if (this.elf && this.elf.status !== 'ready') return false
      this.model.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true
      })
      this.elf?.forceLod(0)
      this.sharpen()
      // 剛載入時骨架還是綁定姿勢（T-pose，雙臂平舉會把寬度撐大一倍）：先套用待機姿勢再量尺寸
      this.model.animate(0, 0, 'normal')
      this.measure()
      this.frame()
      return true
    })
    this.loop()
    // 開發時方便在主控台 / 自動化測試檢查（例如強制閉眼）
    if (import.meta.env.DEV) Object.assign(window, { __showcase: this })
  }

  // 貼圖以硬體支援的最高非等向過濾取樣（斜看裙擺花紋、臉部仍清晰）；高解析貼圖晚一點才換上，換上後再套一次
  private sharpened = -1
  private sharpen() {
    const max = this.renderer.capabilities.getMaxAnisotropy()
    this.model.root.traverse((o) => {
      const m = (o as THREE.Mesh).material
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        for (const tex of [(mat as THREE.MeshStandardMaterial).map, (mat as THREE.MeshStandardMaterial).normalMap]) {
          if (tex && tex.anisotropy !== max) {
            tex.anisotropy = max
            tex.needsUpdate = true
          }
        }
      }
    })
    this.sharpened = this.elf?.hiResLoaded.size ?? 0
  }

  // 角色高度與水平半徑（量測可見的網格；哥布林的大耳朵讓牠幾乎和身高一樣寬）
  private size = { h: 1.6, r: 0.5 }

  private measure() {
    // 程序化模型的關節是巢狀節點，量測前要先更新整棵樹的世界矩陣
    this.model.root.updateMatrixWorld(true)
    const box = new THREE.Box3()
    this.model.root.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) box.expandByObject(o, true)
    })
    if (box.isEmpty()) return
    const r = Math.max(Math.hypot(box.min.x, box.min.z), Math.hypot(box.max.x, box.max.z), Math.hypot(box.min.x, box.max.z), Math.hypot(box.max.x, box.min.z))
    this.size = { h: Math.max(0.5, box.max.y), r: Math.max(0.2, r) }
  }

  // 全身入鏡、略微俯視：高度與寬度（任意旋轉角度下的水平半徑）都要放得下
  private frame() {
    const { h, r } = this.size
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const fit = Math.max((h * 0.53) / tan, (r * 1.05) / (tan * this.camera.aspect)) + r * 0.6
    this.camera.position.set(0, h * 0.58, fit)
    this.controls.target.set(0, h * 0.505, 0)
    this.controls.minDistance = fit * 0.6
    this.controls.maxDistance = fit * 1.4
    this.controls.update()
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    // 窄長的區域：拉寬垂直視角，角色不會被切到
    this.camera.fov = w / h < 0.6 ? 40 : 30
    this.camera.updateProjectionMatrix()
    this.frame()
  }

  private loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(this.clock.getDelta(), 0.05)
    this.model.animate(dt, 0, 'normal')
    if (this.elf && this.sharpened >= 0 && this.elf.hiResLoaded.size !== this.sharpened) this.sharpen()
    this.controls.update()
    this.effect.render(this.scene, this.camera)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.observer.disconnect()
    this.controls.dispose()
    if (this.elf) this.elf.dispose()
    // 程序化哥布林的材質來自 toon() 快取、與遊戲共用，只釋放幾何
    else disposeObject(this.model.root, { materials: false })
    this.ground.geometry.dispose()
    this.ground.material.dispose()
    this.env.dispose()
    // 共用的卡通材質也要讓這個 renderer 放手，否則舊 renderer 會一直被參照（見 toon.ts）
    releaseToonGpu()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}
