import * as THREE from 'three'
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { ElfMagicFx } from './elf/ElfMagicFx'
import { CONFIG, type Role } from './config'
import { Actor, Elf, Goblin } from './entities'
import { GAP_HALF, World } from './world'
import { noOutline } from './toon'
import { updateElfAI, updateGoblinAI } from './ai'
import { sfx } from './audio'
import { FxSystem } from './fx/Effects'
import { CELL } from './fx/atlas'
import { keyLabel, loadKeybinds, sameKey } from '../keybinds'
import { t } from '../i18n'
import * as poki from '../poki'
import { lowPower, touchMode } from '../input/touch'

export interface SkillView {
  key: string
  code: string
  name: string
  icon: string
  cd: number
  max: number
  active: boolean
  usable: boolean
  used?: boolean
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'good' | 'bad' | 'warn'
}

export interface HudState {
  phase: 'countdown' | 'play' | 'over'
  countdown: number
  timeLeft: number
  role: Role
  free: number
  total: number
  skills: SkillView[]
  radar: boolean
  hint: string
  progress: number
  progressLabel: string
  toasts: Toast[]
  spectating: string
  speed: number
  pointerLocked: boolean
  result: null | { winner: Role; title: string; detail: string }
}

export function createHudState(role: Role): HudState {
  return {
    phase: 'countdown',
    countdown: CONFIG.startCountdown,
    timeLeft: CONFIG.matchDuration,
    role,
    free: CONFIG.goblinCount,
    total: CONFIG.goblinCount,
    skills: [],
    radar: false,
    hint: '',
    progress: -1,
    progressLabel: '',
    toasts: [],
    spectating: '',
    speed: 1,
    pointerLocked: false,
    result: null,
  }
}

const v1 = new THREE.Vector3()
const v2 = new THREE.Vector3()

function d2(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

export class Game {
  renderer: THREE.WebGLRenderer
  effect: OutlineEffect
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  world: World
  elf: Elf
  goblins: Goblin[] = []
  playerGoblin: Goblin | null = null
  role: Role
  hud: HudState
  elapsed = 0
  duration: number
  packId = 0
  speed = 1

  private container: HTMLElement
  private minimap: HTMLCanvasElement
  private onEnd: (winner: Role, stats: { captured: number; time: number }) => void
  private hemi: THREE.HemisphereLight
  private sun: THREE.DirectionalLight
  private clock = new THREE.Clock()
  private raf = 0
  private countdown = CONFIG.startCountdown
  private lastCount = -1
  private hudTimer = 0
  private toastId = 0
  fx: FxSystem
  elfFx: ElfMagicFx
  private envMap: THREE.Texture
  private staff: ReturnType<FxSystem['createStaff']>
  private shake = 0
  private keys = new Set<string>()
  private touchMove = new THREE.Vector2()
  private binds = loadKeybinds()
  private camYaw = 0
  private camPitch = 0.35
  private camDist = 7
  private dragging = false
  private lastMouse = { x: 0, y: 0 }
  private raycaster = new THREE.Raycaster()
  private spectateIdx = 0
  private radarWas = false
  private warned = new Set<number>()
  private marker: THREE.Mesh
  private disposed = false
  // 暫停原因（廣告、分頁隱藏）；任一存在就停止更新與繪製
  private pauses = new Set<string>()
  private listeners: [EventTarget, string, EventListener][] = []


  constructor(
    container: HTMLElement,
    minimap: HTMLCanvasElement,
    role: Role,
    hud: HudState,
    onEnd: (winner: Role, stats: { captured: number; time: number }) => void,
  ) {
    this.container = container
    this.minimap = minimap
    this.role = role
    this.hud = hud
    this.onEnd = onEnd
    const fast = new URLSearchParams(location.search).get('fast')
    this.duration = fast ? Number(fast) || 90 : CONFIG.matchDuration

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    // 手機 / 平板降低解析度與陰影品質
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, lowPower ? 1.5 : 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(this.renderer.domElement)
    this.effect = new OutlineEffect(this.renderer, { defaultThickness: 0.0035, defaultColor: [0.1, 0.07, 0.05] })

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 900)
    this.scene.fog = new THREE.Fog(0xd6eefa, 90, 300)
    this.hemi = new THREE.HemisphereLight(0xdff0ff, 0x5a7a32, 1.6)
    this.scene.add(this.hemi)
    this.sun = new THREE.DirectionalLight(0xfff0d0, 2.4)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.setScalar(lowPower ? 1024 : 2048)
    const sc = this.sun.shadow.camera
    sc.left = -45
    sc.right = 45
    sc.top = 45
    sc.bottom = -45
    sc.near = 1
    sc.far = 160
    this.sun.shadow.bias = -0.0008
    this.scene.add(this.sun, this.sun.target)

    this.world = new World(this.scene)
    this.fx = new FxSystem(this.scene)
    this.fx.fires = this.world.fires
    this.fx.caves = this.world.caves
    this.staff = this.fx.createStaff()
    this.elfFx = new ElfMagicFx(this.scene, this.fx)
    // 環境光反射只影響 PBR 材質（GLB 精靈），場景其他卡通材質不受影響
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    this.scene.environment = this.envMap
    this.scene.environmentIntensity = 0.55

    // 精靈：在草原中央、牢籠旁
    this.elf = new Elf()
    this.elf.pos.set(0, 0, 7)
    this.elf.isPlayer = role === 'elf'
    this.elf.character.setCamera(this.camera)
    this.scene.add(this.elf.root)

    // 哥布林：分散在各個山洞，玩家在第一個洞
    const caves = this.world.caves
    const names = t('goblinNames').split(',')
    const dist = [0, 0, 1, 1, 2, 2, 3, 4]
    for (let i = 0; i < CONFIG.goblinCount; i++) {
      const c = caves[dist[i] % caves.length]
      const g = new Goblin(i, names[i], c.id)
      const a = Math.random() * Math.PI * 2
      g.pos.set(c.center.x + Math.cos(a) * 4, 0, c.center.z + Math.sin(a) * 4)
      g.yaw = Math.random() * 6
      this.goblins.push(g)
      this.scene.add(g.root)
    }
    if (role === 'goblin') {
      this.playerGoblin = this.goblins[0]
      this.playerGoblin.isPlayer = true
      this.playerGoblin.name = t('you')
    }

    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.75, 32),
      noOutline(new THREE.MeshBasicMaterial({ color: role === 'elf' ? 0xffd34d : 0x9effa0, transparent: true, opacity: 0.8, depthWrite: false })),
    )
    this.marker.rotation.x = -Math.PI / 2
    this.marker.position.y = 0.06
    this.scene.add(this.marker)

    const p = this.focusActor()
    this.camYaw = p === this.elf ? Math.PI : p.yaw + Math.PI
    this.elf.yaw = Math.PI
    this.camDist = role === 'elf' ? 7.5 : 6

    this.bindInput()
    this.resize()
    ;(window as unknown as { __game: Game }).__game = this
    this.syncHud()
  }

  start() {
    this.clock.start()
    const loop = () => {
      if (this.disposed) return
      this.raf = requestAnimationFrame(loop)
      const dt = Math.min(this.clock.getDelta(), 0.05)
      if (!this.pauses.size) this.tick(dt)
    }
    loop()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    poki.gameplayStop()
    for (const [t, n, f] of this.listeners) t.removeEventListener(n, f)
    if (document.pointerLockElement) document.exitPointerLock()
    this.fx.dispose()
    this.elfFx.dispose()
    this.elf.character.dispose()
    this.envMap.dispose()
    this.staff.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  pause(reason: string) {
    if (this.disposed) return
    const first = !this.pauses.size
    this.pauses.add(reason)
    if (!first) return
    this.keys.clear()
    this.touchMove.set(0, 0)
    this.dragging = false
    if (document.pointerLockElement) document.exitPointerLock()
    if (this.hud.phase === 'play') poki.gameplayStop()
  }

  resume(reason: string) {
    if (!this.pauses.delete(reason) || this.pauses.size) return
    this.clock.getDelta() // 丟棄暫停期間累積的時間
    if (this.hud.phase === 'play') poki.gameplayStart()
  }

  setSpeed(s: number) {
    this.speed = s
    this.hud.speed = s
  }

  // ───────────────────────── 輸入 ─────────────────────────
  private on<E extends Event>(t: EventTarget, n: string, fn: (e: E) => void) {
    const f = fn as unknown as EventListener
    t.addEventListener(n, f)
    this.listeners.push([t, n, f])
  }

  private bindInput() {
    const canvas = this.renderer.domElement
    this.on(window, 'resize', () => this.resize())
    this.on(window, 'keydown', ((e: KeyboardEvent) => {
      if (e.code === 'Tab') e.preventDefault()
      if (e.repeat) return
      this.keys.add(e.code)
      this.onAction(e.code)
    }))
    this.on(window, 'keyup', (e: KeyboardEvent) => {
      this.keys.delete(e.code)
    })
    this.on(window, 'blur', () => this.keys.clear())
    this.on(document, 'visibilitychange', () => (document.hidden ? this.pause('hidden') : this.resume('hidden')))
    this.on(canvas, 'mousedown', ((e: MouseEvent) => {
      sfx.unlock()
      if (document.pointerLockElement === canvas) {
        if (e.button === 0) this.onAction('Mouse0')
        if (e.button === 2) this.onAction('Mouse2')
        return
      }
      this.dragging = true
      this.lastMouse = { x: e.clientX, y: e.clientY }
    }))
    this.on(canvas, 'dblclick', () => {
      if (!touchMode.value) void canvas.requestPointerLock?.()
    })
    this.on(canvas, 'contextmenu', ((e: Event) => e.preventDefault()))
    this.on(window, 'mouseup', () => (this.dragging = false))
    this.on(window, 'mousemove', ((e: MouseEvent) => {
      if (document.pointerLockElement === canvas) {
        this.rotateCam(e.movementX, e.movementY)
      } else if (this.dragging) {
        this.rotateCam(e.clientX - this.lastMouse.x, e.clientY - this.lastMouse.y)
        this.lastMouse = { x: e.clientX, y: e.clientY }
      }
    }))
    this.on(canvas, 'wheel', ((e: WheelEvent) => {
      this.camDist = THREE.MathUtils.clamp(this.camDist + e.deltaY * 0.005, 3.5, 14)
    }))
    this.on(document, 'pointerlockchange', () => (this.hud.pointerLocked = document.pointerLockElement === canvas))
  }

  requestPointerLock() {
    void this.renderer.domElement.requestPointerLock?.()
  }

  // ── 觸控（由 TouchControls 呼叫）──
  // x：向右、y：向前，長度 0～1（可慢走）
  setTouchMove(x: number, y: number) {
    this.touchMove.set(x, y)
  }

  touchLook(dx: number, dy: number) {
    this.rotateCam(dx * 1.6, dy * 1.6)
  }

  touchZoom(ratio: number) {
    this.camDist = THREE.MathUtils.clamp(this.camDist / ratio, 3.5, 14)
  }

  nextSpectate() {
    this.spectateIdx++
  }

  private rotateCam(dx: number, dy: number) {
    this.camYaw -= dx * 0.0035
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy * 0.0028, -0.15, 1.15)
  }

  // 由按鍵或 HUD 按鈕觸發
  onAction(code: string) {
    if (this.hud.phase !== 'play' || this.pauses.size) return
    sfx.unlock()
    // 數字鍵與滑鼠是固定的備用鍵，但若玩家把該鍵綁給其他動作則以自訂為準
    const bound = [...Object.values(this.binds.move), ...Object.values(this.role === 'elf' ? this.binds.elf : this.binds.goblin)]
    const free = !bound.some((b) => sameKey(b, code))
    const hit = (key: string, ...alt: string[]) => sameKey(key, code) || (free && alt.includes(code))
    if (this.role === 'elf') {
      const b = this.binds.elf
      if (hit(b.gaze, 'Digit1')) this.elfGaze(this.camForward())
      else if (hit(b.music, 'Digit2')) this.elf.channel >= 0 ? this.elfStopMusic() : this.elfStartMusic()
      else if (hit(b.stun, 'Digit3', 'Mouse0')) this.elfStun()
      else if (hit(b.capture, 'Digit4', 'Mouse2')) this.elfStartCapture()
    } else {
      const g = this.playerGoblin!
      const b = this.binds.goblin
      if (code === 'Tab' && g.captured) this.spectateIdx++
      if (g.captured) return
      if (hit(b.dash, 'Digit1')) this.goblinDash(g)
      else if (hit(b.interfere, 'Digit2', 'Mouse0')) this.goblinInterfere(g)
      else if (hit(b.ult, 'Digit3')) this.goblinUlt(g)
    }
  }

  private camForward() {
    return new THREE.Vector3(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw))
  }

  private readMove(out: THREE.Vector3) {
    const k = this.keys
    const m = this.binds.move
    const down = (code: string) => [...k].some((c) => sameKey(c, code))
    // 方向鍵：未被自訂使用時，↑↓ 前後移動、←→ 轉動視角
    const arrowFree = (code: string) => !Object.values(m).includes(code) && k.has(code)
    let f = 0, r = 0
    if (down(m.up) || arrowFree('ArrowUp')) f += 1
    if (down(m.down) || arrowFree('ArrowDown')) f -= 1
    if (down(m.right)) r += 1
    if (down(m.left)) r -= 1
    if (arrowFree('ArrowLeft')) this.camYaw += 0.04
    if (arrowFree('ArrowRight')) this.camYaw -= 0.04
    f += this.touchMove.y
    r += this.touchMove.x
    const sy = Math.sin(this.camYaw), cy = Math.cos(this.camYaw)
    out.set(-sy * f + cy * r, 0, -cy * f - sy * r)
    if (out.lengthSq() > 1) out.normalize()
    return out
  }

  // ───────────────────────── 精靈技能 ─────────────────────────
  private elfCanAct() {
    return !this.elf.busy && this.hud.phase === 'play'
  }

  elfGaze(dir: THREE.Vector3) {
    const elf = this.elf
    const G = CONFIG.elf.gaze
    if (!this.elfCanAct() || elf.cd.gaze > 0) return false
    elf.cd.gaze = G.cooldown
    elf.yaw = Math.atan2(dir.x, dir.z)
    elf.castT = 0.45
    elf.castPose = 'cast'
    const origin = v1.copy(elf.pos)
    const len = this.world.rayDistance(origin, dir, G.range)
    let hits = 0
    const hitPos: THREE.Vector3[] = []
    for (const g of this.goblins) {
      if (g.captured || g.held || g.grace > 0) continue
      const ox = g.pos.x - origin.x, oz = g.pos.z - origin.z
      const along = ox * dir.x + oz * dir.z
      if (along < 0 || along > len) continue
      const perp = Math.abs(ox * dir.z - oz * dir.x)
      if (perp < G.width + g.radius) {
        g.rooted = Math.max(g.rooted, G.root)
        g.attract = 0
        hits++
        hitPos.push(g.pos.clone())
        this.floatText(t('fRooted'), g.pos, '#ff7fb8')
      }
    }
    this.fx.gazeBeam(origin, dir, len, hitPos, len < G.range - 0.5)
    this.elfFx.gaze(elf.pos, dir)
    if (hits && this.playerGoblin?.rooted) this.shake = Math.max(this.shake, 0.25)
    sfx.gaze()
    if (hits && this.playerGoblin && this.playerGoblin.rooted > 0) this.toast(t('tYouRooted'), 'bad')
    return true
  }

  elfStartMusic() {
    const elf = this.elf
    if (!this.elfCanAct() || elf.cd.music > 0) return false
    elf.channel = 0
    elf.musicAffected.clear()
    elf.model.setHarp?.(true)
    this.fx.ring(elf.pos, CONFIG.elf.music.radius, 0xffe9a0, 1.4, 0.05)
    this.fx.sparkles(elf.pos, 20, 0xffe6a0, 0.6, 2.5, 1.2)
    this.elfFx.musicStart(elf.pos)
    if (this.role === 'goblin') this.toast(t('tMusicStart'), 'warn')
    return true
  }

  elfStopMusic() {
    const elf = this.elf
    if (elf.channel < 0) return
    elf.channel = -1
    elf.cd.music = CONFIG.elf.music.cooldown
    elf.model.setHarp?.(false)
  }

  elfStun() {
    const elf = this.elf
    const S = CONFIG.elf.stun
    if (!this.elfCanAct() || elf.cd.stun > 0) return false
    let best: Goblin | null = null
    let bd = S.range
    for (const g of this.goblins) {
      if (g.captured || g.held || g.grace > 0) continue
      const d = d2(g.pos, elf.pos)
      if (d < bd) {
        bd = d
        best = g
      }
    }
    elf.castT = 0.3
    elf.castPose = 'attack'
    if (!best) {
      elf.cd.stun = 0.6
      this.fx.dust(elf.pos.x + Math.sin(elf.yaw), elf.pos.z + Math.cos(elf.yaw), 4, 0.8, 0xffffff)
      this.floatText(t('fMiss'), v2.copy(elf.pos).add(new THREE.Vector3(Math.sin(elf.yaw), 0, Math.cos(elf.yaw))), '#dddddd')
      return false
    }
    elf.cd.stun = S.cooldown
    elf.yaw = Math.atan2(best.pos.x - elf.pos.x, best.pos.z - elf.pos.z)
    best.stun = S.duration
    best.rooted = 0
    best.attract = 0
    best.dashT = 0
    sfx.stun()
    this.fx.starBurst(best.pos)
    this.elfFx.stun(best.pos)
    this.fx.pow(best.pos, t('fBonk'), '#ffd23f')
    if (best.isPlayer || this.role === 'elf') this.shake = Math.max(this.shake, best.isPlayer ? 0.45 : 0.2)
    if (best.isPlayer) this.toast(t('tYouStunned'), 'bad')
    return true
  }

  elfStartCapture() {
    const elf = this.elf
    const C = CONFIG.elf.capture
    if (!this.elfCanAct() || elf.cd.capture > 0) return false
    let best: Goblin | null = null
    let bd = C.range
    for (const g of this.goblins) {
      if (g.captured || g.held || g.stun <= 0) continue
      const d = d2(g.pos, elf.pos)
      if (d < bd) {
        bd = d
        best = g
      }
    }
    if (!best) {
      if (this.role === 'elf') this.floatText(t('fNoStunned'), elf.pos, '#dddddd')
      return false
    }
    best.held = true
    this.packId++
    const total = best.charm > 0 ? C.charmedPackTime : C.packTime
    elf.packing = { g: best, t: 0, total }
    this.fx.dust(best.pos.x, best.pos.z, 10, 1.4)
    this.fx.sparkles(best.pos, 10, 0xffe6a0, 0.4, 1.5, 0.8)
    this.elfFx.capture(best.pos)
    elf.yaw =Math.atan2(best.pos.x - elf.pos.x, best.pos.z - elf.pos.z)
    if (best.isPlayer) this.toast(best.ultUsed ? t('tYouPacked') : touchMode.value ? t('tYouPackedUltTouch') : t('tYouPackedUlt', { key: keyLabel(this.binds.goblin.ult) }), 'bad')
    else if (this.role === 'goblin') this.toast(touchMode.value ? t('tAllyPackedTouch', { name: best.name }) : t('tAllyPacked', { name: best.name, key: keyLabel(this.binds.goblin.interfere) }), 'warn')
    return true
  }

  private interruptPacking(reason: 'ult' | 'interfere', by?: Goblin) {
    const elf = this.elf
    if (!elf.packing) return
    const g = elf.packing.g
    elf.packing = null
    elf.cd.capture = CONFIG.elf.capture.cooldown
    elf.stagger = reason === 'ult' ? CONFIG.elf.staggerOnInterrupt + 0.4 : CONFIG.elf.staggerOnInterrupt
    g.held = false
    g.stun = 0
    g.rooted = 0
    g.grace = CONFIG.goblin.breakFreeGrace
    v1.subVectors(g.pos, elf.pos).setY(0).normalize()
    g.pos.addScaledVector(v1, 1.2)
    if (reason === 'ult') {
      g.dashT = 1.2
      sfx.breakFree()
      this.fx.shockwave(g.pos)
      this.fx.pow(g.pos, t('fFree'), '#8ff27a')
      this.shake = Math.max(this.shake, 0.5)
      this.toast(g.isPlayer ? t('tYouBrokeFree') : t('tBrokeFree', { name: g.name }), g.isPlayer || this.role === 'goblin' ? 'good' : 'bad')
    } else {
      sfx.interfere()
      const at = by ? by.pos.clone().lerp(elf.pos, 0.5) : g.pos
      this.fx.starBurst(at, 0x9effa0)
      this.fx.pow(at, 'POW!', '#ffd23f')
      this.fx.dust(g.pos.x, g.pos.z, 10, 1.6)
      this.shake = Math.max(this.shake, 0.35)
      this.toast(t('tRescued', { by: by?.isPlayer ? t('you') : by?.name ?? t('aGoblin'), name: g.isPlayer ? t('you') : g.name }), this.role === 'goblin' ? 'good' : 'bad')
    }
  }

  private completeCapture() {
    const elf = this.elf
    const g = elf.packing!.g
    elf.packing = null
    elf.cd.capture = CONFIG.elf.capture.cooldown
    g.captured = true
    g.held = false
    g.stun = g.rooted = g.attract = g.charm = 0
    g.capturedAt = this.elapsed
    g.zone = -2
    const n = this.goblins.filter((x) => x.captured).length - 1
    const a = n * (Math.PI * 2 / CONFIG.goblinCount)
    const to = new THREE.Vector3(this.world.cagePos.x + Math.cos(a) * 1.5, 0, this.world.cagePos.z + Math.sin(a) * 1.5)
    g.flight = { from: g.pos.clone(), to, t: 0, dur: Math.min(2.2, 0.8 + g.pos.distanceTo(to) / 60) }
    g.pos.copy(to)
    g.vel.set(0, 0, 0)
    this.fx.sparkles(g.flight.from, 24, 0xffe6a0, 0.6, 3, 1)
    this.fx.ring(g.flight.from, 3, 0xffe6a0, 0.6, 0.12)
    sfx.captured()
    if (!elf.isPlayer) elf.ai.patrolWait = CONFIG.elf.aiRest
    const free = this.goblins.filter((x) => !x.captured).length
    if (g.isPlayer) {
      this.toast(t(touchMode.value ? 'tYouCapturedTouch' : 'tYouCaptured'), 'bad')
      this.setSpeed(1)
    } else this.toast(t('tCaptured', { name: g.name, n: free }), this.role === 'elf' ? 'good' : 'bad')
    if (free === 0) this.finish('elf')
  }

  // ───────────────────────── 哥布林技能 ─────────────────────────
  goblinDash(g: Goblin) {
    if (g.captured || g.disabled || g.dashCd > 0) return false
    g.dashT = CONFIG.goblin.dashDuration
    g.dashCd = CONFIG.goblin.dashCooldown
    this.fx.dust(g.pos.x, g.pos.z, 8, 1.3)
    this.fx.ring(g.pos, 1.6, 0xdff8ff, 0.35, 0.18)
    if (g.isPlayer) sfx.dash()
    return true
  }

  goblinInterfere(g: Goblin) {
    const elf = this.elf
    if (g.captured || g.disabled || g.interfereCd > 0) return false
    if (!elf.packing || elf.packing.g === g) {
      if (g.isPlayer) this.floatText(t('fNoTarget'), g.pos, '#dddddd')
      return false
    }
    if (d2(g.pos, elf.pos) > CONFIG.goblin.interfereRange) {
      if (g.isPlayer) this.floatText(t('fTooFar'), g.pos, '#dddddd')
      return false
    }
    g.interfereCd = CONFIG.goblin.interfereCooldown
    this.interruptPacking('interfere', g)
    return true
  }

  goblinUlt(g: Goblin) {
    if (g.ultUsed || !g.held || this.elf.packing?.g !== g) {
      if (g.isPlayer && !g.ultUsed) this.floatText(t('fUltOnlyHeld'), g.pos, '#dddddd')
      return false
    }
    g.ultUsed = true
    this.interruptPacking('ult')
    return true
  }

  // ───────────────────────── 導航 ─────────────────────────
  navigate(a: Actor, target: THREE.Vector3, avoid?: THREE.Vector3): THREE.Vector3 {
    const wp = this.waypoint(a.pos, target, avoid)
    const dir = new THREE.Vector3(wp.x - a.pos.x, 0, wp.z - a.pos.z)
    const len = dir.length()
    if (len < 0.3) return dir.set(0, 0, 0)
    dir.divideScalar(len)
    // 小型障礙物避讓
    const probe = 1.4
    if (this.world.blockedAt(a.pos.x + dir.x * probe, a.pos.z + dir.z * probe, a.radius)) {
      const tries = [0.6, 1.1, 1.6, 2.2]
      for (const t of tries) {
        for (const s of [a.avoidSide, -a.avoidSide]) {
          const ang = t * s
          const c = Math.cos(ang), sn = Math.sin(ang)
          const x = dir.x * c - dir.z * sn, z = dir.x * sn + dir.z * c
          if (!this.world.blockedAt(a.pos.x + x * probe, a.pos.z + z * probe, a.radius)) {
            a.avoidSide = s
            return dir.set(x, 0, z)
          }
        }
      }
    }
    return dir
  }

  private waypoint(pos: THREE.Vector3, target: THREE.Vector3, avoid?: THREE.Vector3): THREE.Vector3 {
    const world = this.world
    const zA = world.zoneOf(pos)
    const zT = world.zoneOf(target)
    if (zA === zT && zA >= 0) return target
    if (zA >= 0) {
      const cave = world.caves[zA]
      let gap = cave.gaps[0]
      let best = Infinity
      for (const gp of cave.gaps) {
        let s = d2(gp.outer, target)
        if (avoid) s -= d2(gp.inner, avoid) * 2.5
        if (s < best) {
          best = s
          gap = gp
        }
      }
      return this.aligned(pos, cave, gap.angle) ? gap.outer : gap.inner
    }
    if (zT >= 0) {
      const cave = world.caves[zT]
      let gap = cave.gaps[0]
      let best = Infinity
      for (const gp of cave.gaps) {
        let s = d2(gp.outer, pos)
        if (avoid) s -= d2(gp.outer, avoid) * 0.8
        if (s < best) {
          best = s
          gap = gp
        }
      }
      const dc = d2(pos, cave.center)
      if (this.aligned(pos, cave, gap.angle) && dc < cave.radius + 5) return dc < cave.radius - 0.5 ? target : gap.inner
      return this.detour(pos, gap.outer, zT)
    }
    return this.detour(pos, target, -1)
  }

  private aligned(pos: THREE.Vector3, cave: { center: THREE.Vector3 }, angle: number) {
    const a = Math.atan2(pos.z - cave.center.z, pos.x - cave.center.x)
    return Math.abs(Math.atan2(Math.sin(a - angle), Math.cos(a - angle))) < GAP_HALF * 0.75
  }

  // 若直線穿過山洞，改繞外圍
  private detour(pos: THREE.Vector3, target: THREE.Vector3, ignore: number): THREE.Vector3 {
    const dx = target.x - pos.x, dz = target.z - pos.z
    const len = Math.hypot(dx, dz) || 1
    const ux = dx / len, uz = dz / len
    for (const c of this.world.caves) {
      const ox = c.center.x - pos.x, oz = c.center.z - pos.z
      const t = ox * ux + oz * uz
      if (t < 0 || t > len) continue
      const px = ox - ux * t, pz = oz - uz * t
      const perp = Math.hypot(px, pz)
      const R = c.radius + 1.8
      if (perp > R) continue
      if (c.id === ignore && t > len - 1) continue
      let nx = -px, nz = -pz
      const nl = Math.hypot(nx, nz)
      if (nl < 0.01) {
        nx = -uz
        nz = ux
      } else {
        nx /= nl
        nz /= nl
      }
      return new THREE.Vector3(c.center.x + nx * (c.radius + 4.5), 0, c.center.z + nz * (c.radius + 4.5))
    }
    return target
  }

  // ───────────────────────── 主迴圈 ─────────────────────────
  private tick(rawDt: number) {
    const steps = this.speed
    for (let i = 0; i < steps; i++) this.update(rawDt)
    this.updateCamera(rawDt)
    this.world.update(rawDt)
    this.hudTimer -= rawDt
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1
      this.syncHud()
      this.drawMinimap()
    }
    this.effect.render(this.scene, this.camera)
  }

  private update(dt: number) {
    const hud = this.hud
    if (hud.phase === 'countdown') {
      this.countdown -= dt
      const c = Math.ceil(this.countdown)
      if (c !== this.lastCount) {
        this.lastCount = c
        if (c > 0) sfx.tick()
      }
      if (this.countdown <= 0) {
        hud.phase = 'play'
        poki.gameplayStart()
        this.toast(this.role === 'elf' ? t('tHuntStart') : t('tHideStart'), 'info')
      }
    } else if (hud.phase === 'play') {
      this.elapsed += dt
      const left = this.duration - this.elapsed
      for (const mark of [300, 120, 60]) {
        if (left < mark && !this.warned.has(mark) && this.duration > mark) {
          this.warned.add(mark)
          this.toast(t('tMinutesLeft', { n: mark / 60 }), 'warn')
        }
      }
      if (left <= 0) {
        this.finish('goblin')
        return
      }
    }

    const playing = hud.phase === 'play'
    const elf = this.elf

    // 狀態計時
    for (const k of ['gaze', 'music', 'stun', 'capture'] as const) elf.cd[k] = Math.max(0, elf.cd[k] - dt)
    elf.stagger = Math.max(0, elf.stagger - dt)
    elf.castT = Math.max(0, elf.castT - dt)
    for (const g of this.goblins) {
      if (!g.held) g.stun = Math.max(0, g.stun - dt)
      g.rooted = Math.max(0, g.rooted - dt)
      g.attract = Math.max(0, g.attract - dt)
      g.charm = Math.max(0, g.charm - dt)
      g.grace = Math.max(0, g.grace - dt)
      g.dashT = Math.max(0, g.dashT - dt)
      g.dashCd = Math.max(0, g.dashCd - dt)
      g.interfereCd = Math.max(0, g.interfereCd - dt)
      if (!g.captured) g.zone = this.world.zoneOf(g.pos)
    }
    elf.zone = this.world.zoneOf(elf.pos)

    // 彈奏
    if (elf.channel >= 0) {
      elf.channel += dt
      elf.musicNoteT -= dt
      if (elf.musicNoteT <= 0) {
        elf.musicNoteT = 0.22
        sfx.harpNote(elf.musicNote++)
      }
      const M = CONFIG.elf.music
      for (const g of this.goblins) {
        if (g.captured || g.held || elf.musicAffected.has(g)) continue
        if (d2(g.pos, elf.pos) < M.radius) {
          elf.musicAffected.add(g)
          g.attract = M.attractTime
          g.charm = M.charmTime
          if (g.isPlayer) this.toast(t('tYouCharmed'), 'bad')
        }
      }
      if (Math.floor(elf.channel / 1.2) !== Math.floor((elf.channel - dt) / 1.2)) this.fx.ring(elf.pos, M.radius, 0xffe9a0, 1.4, 0.05)
      this.elfFx.musicTick(dt, elf.pos, M.radius)
      if (elf.channel >= M.maxChannel) this.elfStopMusic()
    }

    // 打包
    if (elf.packing) {
      const p = elf.packing
      p.t += dt
      p.g.stun = Math.max(p.g.stun, 0.2)
      if (Math.floor(p.t * 4) !== Math.floor((p.t - dt) * 4)) sfx.pack()
      if (p.t >= p.total) this.completeCapture()
    }
    if (hud.phase === 'over') {
      // 結算畫面時精靈仍要動（勝利動作）
      elf.model.animate(dt, 0, 'normal')
      this.elfFx.update(dt)
      return
    }

    // 操控 / AI
    if (playing) {
      if (this.role === 'elf') {
        if (!elf.busy) this.readMove(elf.wish)
        else {
          // 彈奏中移動 = 解除
          if (elf.channel >= 0 && this.readMove(v2).lengthSq() > 0.1) this.elfStopMusic()
          elf.wish.set(0, 0, 0)
        }
      } else if (this.elapsed > 6) updateElfAI(this, dt)
      else elf.wish.set(0, 0, 0)

      for (const g of this.goblins) {
        if (g.captured) continue
        if (g.isPlayer) this.readMove(g.wish)
        else if (this.elapsed > 0.5) updateGoblinAI(this, g, dt)
      }
    }

    // 移動
    const elfSpeed = elf.isPlayer ? CONFIG.elf.speed : CONFIG.elf.aiSpeed
    if (elf.busy) elf.wish.set(0, 0, 0)
    this.moveActor(elf, elfSpeed * (elf.castT > 0 ? 0.35 : 1), dt, elfSpeed)
    for (const g of this.goblins) {
      if (g.captured) continue
      let sp = CONFIG.goblin.speed
      if (g.held || g.stun > 0 || g.rooted > 0) g.wish.set(0, 0, 0)
      else if (g.attract > 0) {
        const dd = d2(g.pos, elf.pos)
        if (dd > 2.2) g.wish.copy(this.navigate(g, elf.pos))
        else g.wish.set(0, 0, 0)
        sp *= 0.6
      } else if (g.dashT > 0) sp *= CONFIG.goblin.dashMultiplier
      this.moveActor(g, sp, dt, CONFIG.goblin.speed)
    }
    this.separate()

    // 姿勢與動畫
    elf.pose = elf.stagger > 0 ? 'stunned' : elf.channel >= 0 ? 'play' : elf.packing ? 'pack' : elf.castT > 0 ? elf.castPose : 'normal'
    elf.root.position.copy(elf.pos)
    elf.root.rotation.y = elf.yaw
    elf.model.animate(dt, elf.moveAmt, elf.pose)
    this.staff.update(dt, elf.channel >= 0, elf.pos)
    for (let k = 0; k < this.fx.rate('elftrail', 2 + elf.moveAmt * 14, dt); k++) this.fx.trail(elf.pos, Math.random() < 0.6 ? 0xfff0b0 : 0xc8f0ff, 0.2 + Math.random() * 1.4)
    this.elfFx.ambient(dt, elf.pos, elf.moveAmt)
    this.elfFx.update(dt)
    if (elf.packing) for (let k = 0; k < this.fx.rate('pack', 10, dt); k++) this.fx.dust(elf.packing.g.pos.x, elf.packing.g.pos.z, 1, 0.5, 0xc8a870)
    elf.fx.stunned.visible = elf.stagger > 0
    const eb = elf.fx.bar
    eb.group.visible = !!elf.packing || elf.channel >= 0
    if (elf.packing) eb.fg.scale.x = 1.16 * (elf.packing.t / elf.packing.total)
    else if (elf.channel >= 0) eb.fg.scale.x = 1.16 * (1 - elf.channel / CONFIG.elf.music.maxChannel)

    for (const g of this.goblins) {
      g.pose = g.captured || g.held ? 'held' : g.stun > 0 ? 'stunned' : g.rooted > 0 ? 'rooted' : 'normal'
      g.root.position.copy(g.pos)
      g.root.rotation.y = g.yaw
      const dElf = d2(g.pos, elf.pos)
      const scared = g.isPlayer ? (g.zone >= 0 && g.zone === elf.zone) || dElf < 7 : g.ai.fear > 0 && dElf < 12
      g.model.animate(dt, g.moveAmt, g.pose, { scared, dash: g.dashT > 0 })
      if (g.flight) {
        // 麻袋飛向牢籠
        const fl = g.flight
        fl.t += dt
        const k = Math.min(1, fl.t / fl.dur)
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
        g.root.position.lerpVectors(fl.from, fl.to, e)
        g.root.position.y = Math.sin(k * Math.PI) * (6 + fl.from.distanceTo(fl.to) * 0.15)
        g.yaw += dt * 8
        this.fx.trail(g.root.position, 0xffe6a0, 0.5)
        if (k >= 1) {
          g.flight = null
          g.root.position.copy(fl.to)
          this.fx.dust(fl.to.x, fl.to.z, 10, 1.2)
          this.fx.sparkles(fl.to, 12, 0xffe6a0, 0.5, 2, 0.6)
        }
      }
      if (!g.captured) {
        const f = this.fx
        if (g.moveAmt > 0.55 && !g.disabled) {
          g.dustT -= dt * (g.dashT > 0 ? 14 : 5 * g.moveAmt)
          if (g.dustT <= 0) {
            g.dustT = 1
            f.dust(g.pos.x, g.pos.z, 1, g.dashT > 0 ? 1 : 0.55)
          }
          if (g.dashT > 0) for (let k = 0; k < f.rate(`sl${g.id}`, 30, dt); k++) f.speedLines(g.pos, g.vel)
        }
        if (g.charm > 0)
          for (let k = 0; k < f.rate(`ch${g.id}`, 2.2, dt); k++)
            f.glow.spawn({
              x: g.pos.x + (Math.random() - 0.5) * 0.6, y: 1.4, z: g.pos.z + (Math.random() - 0.5) * 0.6, vy: 0.6,
              color: 0xffe6a0, size: 0.32, life: 1.2, cell: Math.random() < 0.5 ? CELL.note : CELL.notes, wobble: 0.5,
            })
        if (g.rooted > 0)
          for (let k = 0; k < f.rate(`rt${g.id}`, 5, dt); k++)
            f.soft.spawn({
              x: g.pos.x + (Math.random() - 0.5) * 0.7, y: 0.6 + Math.random() * 0.8, z: g.pos.z + (Math.random() - 0.5) * 0.7, vy: 0.9,
              color: 0xff6fae, size: 0.22, life: 0.9, cell: CELL.heart, wobble: 0.4,
            })
        if (g.grace > 0) for (let k = 0; k < f.rate(`gr${g.id}`, 12, dt); k++) f.trail(g.pos, 0xbfffb0, 0.7)
      }
      const radar = g.isPlayer && !g.captured && g.zone >= 0 && g.zone === elf.zone
      g.fx.radar.visible = radar
      g.fx.radar.position.y = 2.15 + Math.abs(Math.sin(this.elapsed * 5)) * 0.12
      g.fx.bar.group.visible = g.held && !!elf.packing
      if (elf.packing && elf.packing.g === g) g.fx.bar.fg.scale.x = 1.16 * (elf.packing.t / elf.packing.total)
    }

    // 雷達提示音
    const radarNow = !!this.playerGoblin && !this.playerGoblin.captured && this.playerGoblin.zone >= 0 && this.playerGoblin.zone === elf.zone
    if (radarNow && !this.radarWas) {
      sfx.alarm()
      this.toast(t('tRadar'), 'warn')
    }
    this.radarWas = radarNow

    // 洞內變暗、太陽陰影跟隨
    const focus = this.focusActor()
    const inCave = this.world.zoneOf(focus.pos) >= 0
    const k = Math.min(1, dt * 2)
    this.hemi.intensity += ((inCave ? 1.0 : 1.6) - this.hemi.intensity) * k
    this.sun.intensity += ((inCave ? 1.5 : 2.4) - this.sun.intensity) * k
    this.fx.update(dt, focus.pos, inCave)
    this.shake = Math.max(0, this.shake - dt * 1.8)
    this.sun.position.set(focus.pos.x + 30, 60, focus.pos.z + 18)
    this.sun.target.position.set(focus.pos.x, 0, focus.pos.z)
    this.marker.visible = !(this.playerGoblin?.captured ?? false)
    const me = this.playerGoblin ?? this.elf
    this.marker.position.set(me.pos.x, 0.06, me.pos.z)
  }

  private moveActor(a: Actor, speed: number, dt: number, base: number) {
    v1.copy(a.wish).multiplyScalar(speed)
    a.vel.lerp(v1, Math.min(1, dt * 12))
    a.pos.addScaledVector(a.vel, dt)
    this.world.resolve(a.pos, a.radius)
    const sp = a.vel.length()
    if (sp > 0.4) {
      const target = Math.atan2(a.vel.x, a.vel.z)
      const diff = Math.atan2(Math.sin(target - a.yaw), Math.cos(target - a.yaw))
      a.yaw += diff * Math.min(1, dt * 12)
    }
    a.moveAmt = Math.min(1.3, sp / base)
  }

  private separate() {
    const list: Actor[] = [this.elf, ...this.goblins.filter((g) => !g.captured)]
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j]
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z
        const min = a.radius + b.radius
        const dd = dx * dx + dz * dz
        if (dd < min * min && dd > 1e-6) {
          const d = Math.sqrt(dd)
          const push = (min - d) / 2
          const nx = dx / d, nz = dz / d
          const aFixed = a === this.elf && (this.elf.packing || this.elf.channel >= 0)
          const bHeld = (b as Goblin).held
          if (!aFixed) {
            a.pos.x -= nx * push
            a.pos.z -= nz * push
          }
          if (!bHeld) {
            b.pos.x += nx * push
            b.pos.z += nz * push
          }
        }
      }
  }

  private focusActor(): Actor {
    if (this.role === 'elf') return this.elf
    const pg = this.playerGoblin!
    if (!pg.captured) return pg
    const free = this.goblins.filter((g) => !g.captured)
    if (!free.length) return this.elf
    return free[this.spectateIdx % free.length]
  }

  private updateCamera(dt: number) {
    const focus = this.focusActor()
    const h = focus === this.elf ? 1.5 : 1.0
    const target = v1.set(focus.pos.x, h + 0.3, focus.pos.z)
    const cp = Math.cos(this.camPitch)
    const dir = v2.set(Math.sin(this.camYaw) * cp, Math.sin(this.camPitch) + 0.15, Math.cos(this.camYaw) * cp).normalize()
    let dist = this.camDist
    this.raycaster.set(target, dir)
    this.raycaster.far = dist
    const hit = this.raycaster.intersectObjects(this.world.occluders, false)[0]
    if (hit) dist = Math.max(1.2, hit.distance - 0.4)
    const want = new THREE.Vector3().copy(target).addScaledVector(dir, dist)
    want.y = Math.max(want.y, 0.4)
    this.camera.position.lerp(want, Math.min(1, dt * 14))
    this.camera.lookAt(target)
    if (this.shake > 0) {
      const k = this.shake * this.shake * 0.35
      this.camera.position.x += (Math.random() - 0.5) * k
      this.camera.position.y += (Math.random() - 0.5) * k
      this.camera.rotation.z += (Math.random() - 0.5) * k * 0.15
    }
  }

  private resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.fx.setViewport(h * this.renderer.getPixelRatio(), this.camera.fov)
    // 手機直拿時顯示轉向提示（App.vue），遊戲先暫停
    if (lowPower && h > w) this.pause('portrait')
    else this.resume('portrait')
  }

  // ───────────────────────── 特效 ─────────────────────────
  floatText(text: string, pos: THREE.Vector3, color: string, scale = 0.75) {
    this.fx.floatText(text, pos, color, scale)
  }

  toast(text: string, kind: Toast['kind'] = 'info') {
    const id = ++this.toastId
    this.hud.toasts.push({ id, text, kind })
    if (this.hud.toasts.length > 4) this.hud.toasts.shift()
    setTimeout(() => {
      const i = this.hud.toasts.findIndex((t) => t.id === id)
      if (i >= 0) this.hud.toasts.splice(i, 1)
    }, 3800)
  }

  private finish(winner: Role) {
    if (this.hud.phase === 'over') return
    this.hud.phase = 'over'
    poki.gameplayStop()
    this.elfStopMusic()
    if (winner === 'elf') this.elf.character.setVictory(true)
    const captured = this.goblins.filter((g) => g.captured).length
    const won = winner === this.role
    if (won) sfx.win()
    else sfx.lose()
    if (document.pointerLockElement) document.exitPointerLock()
    const mm = Math.floor(this.elapsed / 60), ss = Math.floor(this.elapsed % 60)
    this.hud.result = {
      winner,
      title: winner === 'elf' ? t('rElfWin') : t('rGoblinWin'),
      detail:
        winner === 'elf'
          ? t('rElfDetail', { mm, ss: String(ss).padStart(2, '0'), n: captured })
          : t('rGoblinDetail', { free: CONFIG.goblinCount - captured, n: captured }),
    }
    this.syncHud()
    this.onEnd(winner, { captured, time: this.elapsed })
  }

  // ───────────────────────── HUD ─────────────────────────
  private syncHud() {
    const h = this.hud
    h.countdown = Math.max(0, Math.ceil(this.countdown))
    h.timeLeft = Math.max(0, this.duration - this.elapsed)
    h.free = this.goblins.filter((g) => !g.captured).length
    const elf = this.elf
    const touch = touchMode.value
    if (this.role === 'elf') {
      const E = CONFIG.elf
      const b = this.binds.elf
      h.skills = [
        { key: keyLabel(b.gaze), code: b.gaze, name: t('skillGaze'), icon: '💗', cd: elf.cd.gaze, max: E.gaze.cooldown, active: false, usable: !elf.busy },
        { key: keyLabel(b.music), code: b.music, name: elf.channel >= 0 ? t('skillMusicStop') : t('skillMusic'), icon: '🎵', cd: elf.cd.music, max: E.music.cooldown, active: elf.channel >= 0, usable: !elf.packing && elf.stagger <= 0 },
        { key: keyLabel(b.stun), code: b.stun, name: t('skillStun'), icon: '💫', cd: elf.cd.stun, max: E.stun.cooldown, active: false, usable: !elf.busy },
        { key: keyLabel(b.capture), code: b.capture, name: t('skillCapture'), icon: '🎒', cd: elf.cd.capture, max: E.capture.cooldown, active: !!elf.packing, usable: !elf.busy },
      ]
      h.radar = false
      const near = this.goblins.filter((g) => !g.captured && !g.held && d2(g.pos, elf.pos) < E.capture.range)
      if (elf.stagger > 0) h.hint = t('hInterrupted')
      else if (elf.packing) h.hint = ''
      else if (elf.channel >= 0) h.hint = touch ? t('hPlayingTouch') : t('hPlaying', { key: keyLabel(b.music) })
      else if (near.some((g) => g.stun > 0) && elf.cd.capture <= 0) h.hint = touch ? t('hCaptureTouch') : t('hCapture', { key: keyLabel(b.capture) })
      else if (near.length && elf.cd.stun <= 0) h.hint = touch ? t('hStunTouch') : t('hStun', { key: keyLabel(b.stun) })
      else h.hint = ''
      h.progress = elf.packing ? elf.packing.t / elf.packing.total : -1
      h.progressLabel = elf.packing ? t('hPacking', { name: elf.packing.g.name }) : ''
      h.spectating = ''
    } else {
      const g = this.playerGoblin!
      const G = CONFIG.goblin
      const b = this.binds.goblin
      h.skills = [
        { key: keyLabel(b.dash), code: b.dash, name: t('skillDash'), icon: '💨', cd: g.dashCd, max: G.dashCooldown, active: g.dashT > 0, usable: !g.disabled },
        { key: keyLabel(b.interfere), code: b.interfere, name: t('skillInterfere'), icon: '🤜', cd: g.interfereCd, max: G.interfereCooldown, active: false, usable: !!elf.packing && elf.packing.g !== g && !g.disabled },
        { key: keyLabel(b.ult), code: b.ult, name: t('skillUlt'), icon: '💥', cd: 0, max: 1, active: false, usable: g.held && !g.ultUsed, used: g.ultUsed },
      ]
      h.radar = !g.captured && g.zone >= 0 && g.zone === elf.zone
      if (g.captured) h.hint = ''
      else if (g.held) h.hint = g.ultUsed ? t('hUltUsed') : touch ? t('hUltTouch') : t('hUlt', { key: keyLabel(b.ult) })
      else if (g.stun > 0) h.hint = t('hStunned')
      else if (g.rooted > 0) h.hint = t('hRooted')
      else if (g.attract > 0) h.hint = t('hCharmed')
      else if (elf.packing && d2(g.pos, elf.pos) < G.interfereRange) h.hint = touch ? t('hInterfereTouch') : t('hInterfere', { key: keyLabel(b.interfere) })
      else if (elf.packing && d2(g.pos, elf.pos) < 30) h.hint = t('hAllyPacked', { name: elf.packing.g.name })
      else h.hint = ''
      h.progress = g.held && elf.packing ? elf.packing.t / elf.packing.total : -1
      h.progressLabel = h.progress >= 0 ? t('hYouPacked') : ''
      const f = this.focusActor()
      h.spectating = g.captured ? (f instanceof Goblin ? f.name : t('elf')) : ''
    }
  }

  private drawMinimap() {
    const c = this.minimap
    const g = c.getContext('2d')
    if (!g) return
    const S = c.width
    const sc = (S / 2 - 6) / CONFIG.worldRadius
    const tx = (x: number) => S / 2 + x * sc
    const tz = (z: number) => S / 2 + z * sc
    g.clearRect(0, 0, S, S)
    g.save()
    g.beginPath()
    g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2)
    g.fillStyle = 'rgba(86,130,60,0.85)'
    g.fill()
    g.clip()
    for (const cave of this.world.caves) {
      g.beginPath()
      g.arc(tx(cave.center.x), tz(cave.center.z), cave.radius * sc, 0, Math.PI * 2)
      g.fillStyle = 'rgba(70,55,45,0.9)'
      g.fill()
      g.strokeStyle = '#2a2018'
      g.lineWidth = 2
      g.stroke()
      g.fillStyle = 'rgba(255,240,200,0.9)'
      for (const gp of cave.gaps) {
        g.beginPath()
        g.arc(tx(gp.outer.x), tz(gp.outer.z), 2.2, 0, Math.PI * 2)
        g.fill()
      }
    }
    g.fillStyle = '#c9a36a'
    g.fillRect(tx(-3), tz(-3), 6 * sc, 6 * sc)
    const elf = this.elf
    const dot = (p: THREE.Vector3, color: string, r: number) => {
      g.beginPath()
      g.arc(tx(p.x), tz(p.z), r, 0, Math.PI * 2)
      g.fillStyle = color
      g.fill()
      g.strokeStyle = '#000'
      g.lineWidth = 1
      g.stroke()
    }
    if (this.role === 'elf') {
      for (const gb of this.goblins) {
        if (gb.captured) continue
        const vis = d2(gb.pos, elf.pos) < 28 && this.world.lineOfSight(elf.pos, gb.pos)
        if (vis) dot(gb.pos, '#9effa0', 3)
      }
    } else {
      const me = this.playerGoblin!
      for (const gb of this.goblins) if (!gb.captured && gb !== me) dot(gb.pos, '#9effa0', 2.6)
      const seeElf = me.captured || (me.zone >= 0 && me.zone === elf.zone) || (d2(me.pos, elf.pos) < 30 && this.world.lineOfSight(me.pos, elf.pos))
      if (seeElf) dot(elf.pos, '#ff6fb5', 3.6)
    }
    const me = this.focusActor()
    // 玩家箭頭
    g.save()
    g.translate(tx(me.pos.x), tz(me.pos.z))
    g.rotate(-me.yaw + Math.PI)
    g.beginPath()
    g.moveTo(0, -6)
    g.lineTo(4.5, 5)
    g.lineTo(-4.5, 5)
    g.closePath()
    g.fillStyle = me === this.elf ? '#ffd34d' : '#ffffff'
    g.fill()
    g.stroke()
    g.restore()
    g.restore()
    g.beginPath()
    g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2)
    g.strokeStyle = 'rgba(255,240,200,0.9)'
    g.lineWidth = 3
    g.stroke()
  }
}
