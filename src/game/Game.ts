import * as THREE from 'three'
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { ElfMagicFx } from './elf/ElfMagicFx'
import { ViolinFx } from './elf/ViolinFx'
import { RangerFx } from './elf/RangerFx'
import { GHOST_OPACITY, RANGER_FLUTE } from './elf/rigs'
import { CONFIG, type ElfKind, type MapId, type Role } from './config'
import { Actor, Elf, Goblin, setBarProgress, type ChargePhase, type ElfAction } from './entities'
import { behindSpot, fearTargets, nearestTarget, sweepHit, targetable } from './violin'
import { TRAP_GONE, arrowEffect, canPlantAt, pressured, reelRange, type ArrowEffect, type Trap } from './ranger'
import { GAP_HALF, World, type Warp } from './world'
import { groundAt, setGround } from './ground'
import { makeSprite, noOutline, releaseToonGpu } from './toon'
import { updateElfAI, updateGoblinAI } from './ai'
import { sfx } from './audio'
import { FxSystem, releasePowGpu } from './fx/Effects'
import { CELL, releaseAtlasGpu } from './fx/atlas'
import { disposeObject } from './elf/dispose'
import { keyLabel, loadKeybinds, sameKey } from '../keybinds'
import { t, type TKey } from '../i18n'
import type { IconName } from '../icons'
import * as crazygames from '../crazygames'
import { isEmbedded } from '../platform'
import { lowPower, touchMode } from '../input/touch'
import type { Pose } from './models'
import type { NetLink } from '../net/room'
import type { Slot } from '../net/assign'

// ── 多人連線 ──
// 房主執行整場模擬（AI、技能判定、勝負），每 1/15 秒廣播快照；技能等事件即時以可靠通道廣播，
// 各端再依自己的視角播放特效 / 音效 / 提示（present）。加入者只回傳自己角色的位置與技能請求。
type V2 = [number, number]
export type GameEvent =
  | { e: 'go' }
  | { e: 'gaze'; o: V2; d: V2; len: number; hits: number[] }
  | { e: 'music'; on: boolean }
  | { e: 'miss'; o: V2; yaw: number }
  | { e: 'stun'; g: number }
  | { e: 'pack'; g: number }
  | { e: 'free'; g: number; by: number; ult: boolean }
  | { e: 'caught'; g: number; from: V2; to: V2; free: number }
  | { e: 'dash'; g: number }
  | { e: 'charm'; g: number }
  | { e: 'say'; s: Slot; k: TKey }
  // 紫晶精靈：開始拉琴、隱身 / 現身（fear＝被嚇到的哥布林）、刺客之眼、瞬移、衝鋒前搖、衝鋒結束（g＝命中的哥布林）
  | { e: 'vcast' }
  | { e: 'stealth'; on: boolean; p: V2; fear: number[] }
  | { e: 'eye'; on: boolean }
  | { e: 'blink'; from: V2; to: V2; yaw: number }
  | { e: 'charge'; o: V2; d: V2; g?: number }
  | { e: 'chargeEnd'; p: V2; g: number }
  // 遊俠精靈：開始吹笛放陷阱、陷阱出現 / 消失（why＝TRAP_GONE，g＝踩到或拆掉的哥布林）、開始吹笛召喚箭、箭射出、箭命中、後躍 / 落地
  | { e: 'rplant' }
  | { e: 'trap'; id: number; p: V2; arm: number }
  | { e: 'trapGone'; id: number; p: V2; why: number; g: number }
  | { e: 'draw'; d: V2 }
  | { e: 'arrow'; id: number; o: V2; d: V2; len: number }
  | { e: 'arrowHit'; id: number; p: V2; g: number; k: ArrowEffect }
  | { e: 'leap'; o: V2; d: V2 }
  | { e: 'leapEnd'; p: V2 }
  | { e: 'left'; name: string }
  // 蘑菇秘境：角色 s 走進傳送門 / 踩到彈跳蘑菇 w
  | { e: 'warp'; s: Slot; w: number }
  | { e: 'end'; w: Role; c: number; time: number }
// 真人玩家名單：[角色, 暱稱, 玩家編號]
type Roster = [Slot, string, number][]
type Act = 'gaze' | 'music' | 'musicStop' | 'stun' | 'capture' | 'dash' | 'interfere' | 'ult' | 'stealth' | 'eye' | 'charge' | 'trap' | 'arrow' | 'leap'
const HARP_ACTS: Act[] = ['gaze', 'music', 'musicStop', 'stun', 'capture']
const VIOLIN_ACTS: Act[] = ['stealth', 'eye', 'charge', 'capture']
const RANGER_ACTS: Act[] = ['trap', 'arrow', 'leap', 'capture']
const ACTS: Record<ElfKind, Act[]> = { harp: HARP_ACTS, violin: VIOLIN_ACTS, ranger: RANGER_ACTS }
const CHARGE_PHASES: ChargePhase[] = ['windup', 'dash', 'recover']
interface Snapshot {
  t: 's'
  q: number
  ph: number
  cd: number
  el: number
  du: number
  pk: number
  e: number[]
  g: number[][]
  // 遊俠精靈的陷阱：[編號, x, z, 還要幾秒生效, 剩餘秒數]（其他精靈沒有這個欄位）
  tr?: number[][]
}
// 加入者回報位置的位移額度上限（公尺）
const IN_BUDGET_CAP = 4
const PHASES: HudState['phase'][] = ['countdown', 'play', 'over']
// 瀏覽器收得到的媒體鍵（系統層級的靜音 / 音量鍵由 macOS 直接處理，網頁攔不到）
const MEDIA_KEYS = new Set(['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaTrackNext', 'MediaTrackPrevious', 'AudioVolumeMute'])
const CAST_POSES: Pose[] = ['normal', 'cast', 'attack', 'shoot']
// 精靈動作狀態 → 姿勢（硬直優先；空閒時看施法動作）
const ELF_ACTION_POSE: Record<ElfAction, Pose | null> = {
  windup: 'windup', dash: 'dash', recover: 'recover', channel: 'play', stealthCast: 'play', packing: 'pack', idle: null,
  draw: 'shoot', plant: 'plant', leap: 'leap',
}
// 精靈模型載入的等待上限（毫秒）：寧可載入畫面久一點，也不要以程序化替身開局（會破壞遊戲體驗）。
// 下載失敗（重試用完）時 ready 會立刻完成、改用替身；這個上限只防網路卡住永遠不回應
const LOAD_TIMEOUT = 60000
// 左鍵「點擊」的判定：放開時離按下的位置不到 6px、按住不到 0.35 秒（超過就當成拖曳轉視角）
const CLICK_SLOP = 6
const CLICK_MS = 350
// 加入者：房主已經結束衝鋒、本機卻還停在突刺 / 收招超過這個秒數時（漏掉事件），以快照為準清掉
const STALE_CHARGE = 0.6
// 小地圖：精靈視線內看到的哥布林
const MAP_SEEN = '#9effa0'
const r2 = (v: number) => Math.round(v * 100) / 100
// 彈跳蘑菇的飛行時間（秒，畫面上的拋物線）
const HOP_TIME = 0.75
// 遊俠精靈：箭矢的輔助瞄準（準星方向這個夾角內的哥布林，cos 值）、後躍時這個距離內有哥布林就往遠離牠的方向跳、
// 後躍留下的陷阱多久後生效（直線追上來的哥布林會踩到，往旁邊閃就躲得掉）
const AIM_CONE = Math.cos((7 * Math.PI) / 180)
const LEAP_AWAY = 8
const LEAP_TRAP_ARM = 0.4
// 加入者：房主已經沒有這個動作、本機卻還停在吹笛 / 後躍超過這個秒數時（漏掉事件），以快照為準清掉
const STALE_RANGER = 0.8

export interface SkillView {
  key: string
  code: string
  name: string
  icon: IconName
  cd: number
  max: number
  active: boolean
  usable: boolean
  used?: boolean
  // 充能制的技能（遊俠的陷阱）：剩餘層數
  count?: number
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
  elfKind: ElfKind
  // 紫晶精靈玩家：刺客之眼開圖中（畫面加上紫色暈影）／隱身中
  eye: boolean
  stealth: boolean
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

export function createHudState(role: Role, elfKind: ElfKind = 'harp'): HudState {
  return {
    phase: 'countdown',
    countdown: CONFIG.startCountdown,
    timeLeft: CONFIG.matchDuration,
    role,
    elfKind,
    eye: false,
    stealth: false,
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

// 網路傳來的方向 [x, z]：只接受有限數值。`Number(x) || 0` 擋不住 1e400 → Infinity，正規化後會變成 NaN 污染位置與快照
function finite(v: unknown) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function vec2(d: unknown) {
  return Array.isArray(d) ? new THREE.Vector3(finite(d[0]), 0, finite(d[1])) : new THREE.Vector3()
}

// 每隻哥布林的出生山洞。8 隻沿用原本的 [0,0,1,1,2,2,3,4]（玩家的 0 號洞有同伴）；
// 其他數量先每個洞放一隻，多的再從 0 號洞開始補，讓每座洞都有人
export function goblinCaves(count: number, caves: number) {
  if (count === 8 && caves === 5) return [0, 0, 1, 1, 2, 2, 3, 4]
  return Array.from({ length: count }, (_, i) => i % caves)
}

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
  violinFx: ViolinFx
  rangerFx: RangerFx
  // 環境光反射貼圖（PMREM 的 render target）：WebGL context 遺失後內容會清空，恢復時要重新產生
  private envTarget: THREE.WebGLRenderTarget | null = null
  // 可以開始倒數了：精靈模型載入完成（或逾時改用替身）；多人加入者另外等到房主的第一個快照
  readonly ready: Promise<void>
  private gotSnapshot: () => void = () => {}
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
  // 左鍵按下的位置與時間：放開時移動很少、時間很短才算點擊（施放技能），否則是拖曳轉視角
  private press: { x: number; y: number; at: number } | null = null
  private raycaster = new THREE.Raycaster()
  private spectateIdx = 0
  private radarWas = false
  private warned = new Set<number>()
  private marker: THREE.Mesh
  private disposed = false
  // 暫停原因（廣告、分頁隱藏）；任一存在就停止更新與繪製
  private pauses = new Set<string>()
  // 房主：每位加入者的位移額度（見 applyInput）
  private inBudget = new Map<Actor, { budget: number; at: number }>()
  private listeners: [EventTarget, string, EventListener][] = []
  // 多人連線（單機時為 null）；me＝本機操控的角色
  net: NetLink | null
  me: Slot
  // 離開時要解除的訂閱（網路連線、廣告狀態）
  private netOff: (() => void)[] = []
  private evQueue: GameEvent[] = []
  private netT = 0
  private seq = 0
  private lastSeq = -1
  private musicStopT = 0
  private bgTimer = 0
  // 真人玩家頭上的暱稱
  private tags = new Map<Slot, THREE.Sprite>()
  private defaultNames: string[] = []
  // 紫晶精靈：刺客之眼的哥布林輪廓（穿牆可見）、拉琴音符計時
  private xray = new Map<Goblin, THREE.Object3D[]>()
  private xrayMat: THREE.MeshBasicMaterial | null = null
  private xrayOn = false
  private violinNoteT = 0

  constructor(
    container: HTMLElement,
    minimap: HTMLCanvasElement,
    role: Role,
    hud: HudState,
    onEnd: (winner: Role, stats: { captured: number; time: number }) => void,
    net: NetLink | null = null,
    elfKind: ElfKind = 'harp',
    map: MapId = 'meadow',
  ) {
    this.container = container
    this.minimap = minimap
    this.role = role
    this.hud = hud
    this.onEnd = onEnd
    this.net = net
    this.me = net ? net.me : role === 'elf' ? 'elf' : 0
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
    // 地圖：多人時由房主投票決定（NetLink），單機為玩家選的地形
    this.world = new World(this.scene, net?.map ?? map)
    setGround(this.world.heightAt)
    const theme = this.world.theme
    this.scene.fog = new THREE.Fog(theme.fog, theme.fogNear, theme.fogFar)
    this.hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, theme.hemi)
    this.scene.add(this.hemi)
    this.sun = new THREE.DirectionalLight(theme.sunColor, theme.sun)
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

    this.fx = new FxSystem(this.scene)
    this.fx.fires = this.world.fires
    this.fx.caves = this.world.caves
    this.fx.ambientStyle = theme.ambient
    this.staff = this.fx.createStaff()
    this.elfFx = new ElfMagicFx(this.scene, this.fx)
    this.violinFx = new ViolinFx(this.scene, this.fx, this.elfFx)
    this.rangerFx = new RangerFx(this.scene, this.fx, this.elfFx)
    // 環境光反射只影響 PBR 材質（GLB 精靈），場景其他卡通材質不受影響
    this.buildEnv()
    this.scene.environmentIntensity = 0.55

    // 精靈：在草原中央、牢籠旁
    const kind = net?.elfKind ?? elfKind
    this.hud.elfKind = kind
    this.elf = new Elf(kind)
    this.elf.pos.set(0, 0, 7)
    this.elf.isPlayer = this.me === 'elf'
    this.elf.character.setCamera(this.camera)
    this.scene.add(this.elf.root)
    // 遊俠：音符、繩索從笛子的喇叭口出來
    if (kind === 'ranger') this.rangerFx.tip = (out) => this.elf.character.nodeWorld(RANGER_FLUTE.socket, RANGER_FLUTE.tip, out)

    // 哥布林：分散在各個山洞，玩家在第一個洞
    const caves = this.world.caves
    const names = (this.defaultNames = t('goblinNames').split(','))
    const dist = goblinCaves(CONFIG.goblinCount, caves.length)
    for (let i = 0; i < CONFIG.goblinCount; i++) {
      const c = caves[dist[i]]
      const g = new Goblin(i, names[i], c.id)
      const a = Math.random() * Math.PI * 2
      g.pos.set(c.center.x + Math.cos(a) * 4, 0, c.center.z + Math.sin(a) * 4)
      g.yaw = Math.random() * 6
      this.goblins.push(g)
      this.scene.add(g.root)
    }
    if (this.me !== 'elf') {
      this.playerGoblin = this.goblins[this.me]
      this.playerGoblin.isPlayer = true
      this.playerGoblin.name = t('you')
    }
    if (net) {
      this.applyRoster([...net.numbers.keys()].map((slot) => [slot, net.names.get(slot) ?? '', net.numbers.get(slot) ?? 0]))
      if (net.host) for (const slot of net.peers.values()) this.actorOf(slot).netDriven = true
      else for (const a of [this.elf, ...this.goblins]) a.netDriven = !a.isPlayer
      this.netOff.push(
        net.listen((from, m) => this.onNet(from, m)),
        net.onLeave((peer) => this.onPeerLeave(peer)),
      )
      if (net.host) this.netOff.push(net.onRejoin((peer, prev, name, n) => this.onPeerRejoin(peer, prev, name, n)))
    }

    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.75, 32),
      noOutline(new THREE.MeshBasicMaterial({ color: role === 'elf' ? 0xffd34d : 0x9effa0, transparent: true, opacity: 0.8, depthWrite: false })),
    )
    this.marker.rotation.x = -Math.PI / 2
    this.marker.position.y = 0.06
    this.scene.add(this.marker)

    // 鏡頭從角色背後開始（精靈面向牢籠；鏡頭若在精靈正面會卡進牢籠裡，畫面被屋頂擋住）
    this.elf.yaw = Math.PI
    const p = this.focusActor()
    this.camYaw = p.yaw + Math.PI
    this.camDist = role === 'elf' ? 7.5 : 6

    this.bindInput()
    this.resize()
    // 插頁廣告播放中暫停（廣告晚於等待時間才開始時，對局可能已經在進行）
    this.netOff.push(crazygames.onAdPlaying((on) => (on ? this.pause('ad') : this.resume('ad'))))
    ;(window as unknown as { __game: Game }).__game = this
    this.syncHud()

    const loaded = Promise.race([this.elf.character.ready, new Promise<void>((r) => setTimeout(r, LOAD_TIMEOUT))])
    const synced = net && !net.host ? new Promise<void>((r) => (this.gotSnapshot = r)) : null
    this.ready = Promise.all([loaded, synced]).then(() => {})
  }

  // 產生環境光反射貼圖（建立時、以及 WebGL context 恢復後）
  private buildEnv() {
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const room = new RoomEnvironment()
    this.envTarget?.dispose()
    this.envTarget = pmrem.fromScene(room, 0.04)
    room.dispose()
    pmrem.dispose()
    this.scene.environment = this.envTarget.texture
  }

  // 等角色載入完成才開始倒數與繪製（載入期間由 GameView 顯示載入畫面）
  start() {
    void this.ready.then(() => {
      if (!this.disposed) this.run()
    })
  }

  private run() {
    this.clock.start()
    // 多人連線時不能因為暫停（分頁隱藏、直拿手機）而停止模擬，否則房主會卡住整個房間；只停止本機輸入
    const loop = () => {
      if (this.disposed) return
      this.raf = requestAnimationFrame(loop)
      const dt = Math.min(this.clock.getDelta(), this.net ? 1 : 0.05)
      if (!this.pauses.size || this.net) this.tick(dt)
    }
    loop()
    // 背景分頁不會觸發 requestAnimationFrame，改用計時器繼續模擬（瀏覽器約每秒觸發一次，tick 內會切成小步）
    if (this.net)
      this.bgTimer = window.setInterval(() => {
        if (document.hidden && !this.disposed) this.tick(Math.min(this.clock.getDelta(), 1), false)
      }, 100)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    clearInterval(this.bgTimer)
    for (const off of this.netOff) off()
    this.syncGameplay()
    for (const [t, n, f] of this.listeners) t.removeEventListener(n, f)
    if (document.pointerLockElement) document.exitPointerLock()
    this.fx.dispose()
    this.elfFx.dispose()
    this.violinFx.dispose()
    this.rangerFx.dispose()
    this.xrayMat?.dispose()
    this.elf.character.dispose()
    this.envTarget?.dispose()
    this.staff.dispose()
    // 釋放場景裡所有幾何 / 材質 / 貼圖（含與下一局共用的卡通材質，下一局會重新上傳），以及陰影貼圖。
    // 共用資源若不 dispose，three 掛在上面的監聽會一直參照這個 renderer，整個 WebGL context 每局殘留一份
    disposeObject(this.scene)
    this.sun.dispose()
    releaseToonGpu()
    releaseAtlasGpu()
    releasePowGpu()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
    setGround(null)
    const w = window as unknown as { __game?: Game }
    if (w.__game === this) delete w.__game
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
    this.syncGameplay()
  }

  // 暫停選單裡改了按鍵設定：立刻套用到這一局
  reloadKeybinds() {
    this.binds = loadKeybinds()
  }

  resume(reason: string) {
    if (!this.pauses.delete(reason) || this.pauses.size) return
    this.clock.getDelta() // 丟棄暫停期間累積的時間
    this.syncGameplay()
  }

  // 回報 CrazyGames 是否正在遊玩：只有對局進行中、沒有暫停、還沒離開時才算。
  // 由對局階段與暫停原因推導，不在各處各自呼叫（多人連線暫停時模擬仍在跑，倒數可能在暫停中結束）
  private syncGameplay() {
    if (!this.disposed && this.hud.phase === 'play' && !this.pauses.size) crazygames.gameplayStart()
    else crazygames.gameplayStop()
  }

  // 最終狩獵（短局版）：倒數最後 CONFIG.finalHunt 秒，精靈感知到所有哥布林
  get finalHunt() {
    return CONFIG.finalHunt > 0 && this.hud.phase === 'play' && this.duration - this.elapsed <= CONFIG.finalHunt
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
      // 遊戲用到的按鍵不交給瀏覽器（避免觸發瀏覽器 / 系統的預設行為）；Cmd / Ctrl 組合鍵照常（重新整理、關分頁等）
      if (!e.metaKey && !e.ctrlKey && (this.isGameKey(e.code) || MEDIA_KEYS.has(e.key))) e.preventDefault()
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
      // 不需要鎖定滑鼠也能用滑鼠施放技能：右鍵直接施放；左鍵拖曳轉視角，沒拖動的短按放開時施放
      if (e.button === 2) {
        this.onAction('Mouse2')
        return
      }
      this.dragging = true
      this.lastMouse = { x: e.clientX, y: e.clientY }
      this.press = e.button === 0 ? { x: e.clientX, y: e.clientY, at: performance.now() } : null
    }))
    // 雙擊鎖定滑鼠（像 FPS 一樣轉視角）。鎖定只能用 Esc 解除，而 CrazyGames／itch.io 上 Esc 也會退出平台的全螢幕，
    // 所以入口站版本不提供鎖定（滑鼠技能已經不需要鎖定）
    if (!isEmbedded)
      this.on(canvas, 'dblclick', () => {
        if (!touchMode.value) void canvas.requestPointerLock?.()
      })
    this.on(canvas, 'contextmenu', ((e: Event) => e.preventDefault()))
    this.on(window, 'mouseup', ((e: MouseEvent) => {
      this.dragging = false
      const p = this.press
      this.press = null
      if (!p || e.button !== 0 || document.pointerLockElement === canvas) return
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < CLICK_SLOP && performance.now() - p.at < CLICK_MS) this.onAction('Mouse0')
    }))
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
    // 手機切到背景（尤其 iOS）時 WebGL context 可能被系統回收：three 會自動重建資源，但 render target 的內容不會回來
    this.on(canvas, 'webglcontextrestored', () => this.buildEnv())
    this.on(document, 'pointerlockchange', () => (this.hud.pointerLocked = document.pointerLockElement === canvas))
  }

  // 移動鍵、目前角色的技能鍵、固定的備用鍵（數字 1～4）
  private isGameKey(code: string) {
    const b = this.binds
    const keys = [...Object.values(b.move), ...Object.values(this.role === 'elf' ? b.elf : b.goblin)]
    return keys.some((k) => sameKey(k, code)) || /^Digit[1-4]$/.test(code)
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
    let act: Act | null = null
    if (this.role === 'elf') {
      const b = this.binds.elf
      // 紫晶精靈沿用同一組四個技能鍵：隱身 / 刺客之眼 / 衝鋒擊暈 / 捕獲
      // 遊俠精靈也是同一組鍵：藤蔓陷阱 / 後躍撤步 / 召喚箭矢 / 收網
      const k = this.elf.kind
      const pick = (harp: Act, violin: Act, ranger: Act) => (k === 'violin' ? violin : k === 'ranger' ? ranger : harp)
      if (hit(b.gaze, 'Digit1')) act = pick('gaze', 'stealth', 'trap')
      else if (hit(b.music, 'Digit2')) act = pick('music', 'eye', 'leap')
      else if (hit(b.stun, 'Digit3', 'Mouse0')) act = pick('stun', 'charge', 'arrow')
      else if (hit(b.capture, 'Digit4', 'Mouse2')) act = 'capture'
    } else {
      const g = this.playerGoblin!
      const b = this.binds.goblin
      if (code === 'Tab' && g.captured) this.spectateIdx++
      if (g.captured) return
      if (hit(b.dash, 'Digit1')) act = 'dash'
      else if (hit(b.interfere, 'Digit2', 'Mouse0')) act = 'interfere'
      else if (hit(b.ult, 'Digit3')) act = 'ult'
    }
    if (act) this.act(act)
  }

  // 本機玩家的技能：房主 / 單機直接執行，加入者送給房主判定
  private act(act: Act) {
    // 凝視、箭矢朝畫面正前方；衝鋒朝角色面向
    const d = act === 'gaze' || act === 'arrow' ? this.camForward() : act === 'charge' ? new THREE.Vector3(Math.sin(this.elf.yaw), 0, Math.cos(this.elf.yaw)) : null
    const dir: V2 | undefined = d ? [r2(d.x), r2(d.z)] : undefined
    if (this.authority) this.perform(this.me, act, dir)
    else this.net!.send({ t: 'act', a: act, d: dir }, true)
  }

  private perform(slot: Slot, act: Act, d?: V2) {
    if (this.hud.phase !== 'play') return
    if (slot === 'elf') {
      const elf = this.elf
      if (!ACTS[elf.kind].includes(act)) return
      // 擊暈鍵兼打包鍵：在房主端判定，加入者送來的 stun / charge / arrow 也會照當下狀態轉成打包（收網）
      if ((act === 'stun' || act === 'charge' || act === 'arrow') && this.packReady()) act = 'capture'
      const dirOf = () => {
        const dir = vec2(d)
        if (dir.lengthSq() < 1e-4) dir.set(Math.sin(elf.yaw), 0, Math.cos(elf.yaw))
        return dir.normalize()
      }
      if (act === 'trap') this.rangerTrap()
      else if (act === 'arrow') this.rangerArrow(dirOf())
      else if (act === 'leap') this.rangerLeap()
      else if (act === 'stealth') this.violinStealth()
      else if (act === 'eye') this.violinEye()
      else if (act === 'charge') this.violinCharge(dirOf())
      else if (act === 'gaze') {
        const dir = vec2(d)
        if (dir.lengthSq() < 1e-4) dir.set(Math.sin(elf.yaw), 0, Math.cos(elf.yaw))
        this.elfGaze(dir.normalize())
      } else if (act === 'music') elf.channel >= 0 ? this.elfStopMusic() : this.elfStartMusic()
      else if (act === 'musicStop') this.elfStopMusic()
      else if (act === 'stun') this.elfStun()
      else if (act === 'capture') this.elfStartCapture()
      return
    }
    const g = this.goblins[slot]
    if (!g) return
    if (act === 'dash') this.goblinDash(g)
    else if (act === 'interfere') this.goblinInterfere(g)
    else if (act === 'ult') this.goblinUlt(g)
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
  // 技能判定只在房主 / 單機執行；結果以事件呈現（present），加入者收到相同事件後播放特效
  private elfCanAct() {
    return this.authority && !this.elf.busy && this.hud.phase === 'play'
  }

  elfGaze(dir: THREE.Vector3) {
    const elf = this.elf
    const G = CONFIG.elf.gaze
    if (!this.elfCanAct() || elf.cd.gaze > 0) return false
    elf.cd.gaze = G.cooldown
    elf.yaw = Math.atan2(dir.x, dir.z)
    const origin = v1.copy(elf.pos)
    const len = this.world.rayDistance(origin, dir, G.range)
    const inBeam: { g: Goblin; along: number }[] = []
    for (const g of this.goblins) {
      if (g.captured || g.held || g.grace > 0) continue
      const ox = g.pos.x - origin.x, oz = g.pos.z - origin.z
      const along = ox * dir.x + oz * dir.z
      if (along < 0 || along > len) continue
      const perp = Math.abs(ox * dir.z - oz * dir.x)
      if (perp < G.width + g.radius) inBeam.push({ g, along })
    }
    inBeam.sort((a, b) => a.along - b.along)
    const hits: number[] = []
    inBeam.forEach(({ g }, i) => {
      g.rooted = Math.max(g.rooted, G.root[Math.min(i, G.root.length - 1)])
      g.attract = 0
      hits.push(g.id)
    })
    this.emit({ e: 'gaze', o: [r2(origin.x), r2(origin.z)], d: [dir.x, dir.z], len: r2(len), hits })
    return true
  }

  elfStartMusic() {
    const elf = this.elf
    if (!this.elfCanAct() || elf.cd.music > 0) return false
    elf.startChannel()
    this.emit({ e: 'music', on: true })
    return true
  }

  elfStopMusic() {
    const elf = this.elf
    if (!this.authority || elf.channel < 0) return
    elf.stopChannel()
    this.emit({ e: 'music', on: false })
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
    if (!best) {
      elf.cd.stun = 0.6
      this.emit({ e: 'miss', o: [r2(elf.pos.x), r2(elf.pos.z)], yaw: r2(elf.yaw) })
      return false
    }
    elf.cd.stun = S.cooldown
    best.stun = S.duration
    best.rooted = 0
    best.attract = 0
    best.dashT = 0
    this.emit({ e: 'stun', g: best.id })
    return true
  }

  // 身邊有可打包的暈眩哥布林、捕獲冷卻已好：此時擊暈 / 衝鋒鍵改成打包
  // （手機上擊暈後來不及換按鈕，同一顆鍵連點就能打包）
  private packReady() {
    const elf = this.elf
    if (elf.packing || elf.cd.capture > 0) return false
    if (elf.ranger) return !!this.reelTarget()
    const R = CONFIG.elf.capture.range
    return this.goblins.some((g) => !g.captured && !g.held && g.stun > 0 && d2(g.pos, elf.pos) < R)
  }

  elfStartCapture() {
    const elf = this.elf
    const C = CONFIG.elf.capture
    if (elf.ranger) return this.rangerReel()
    // 紫晶精靈：捕獲可以取消衝鋒的收招（暈眩只有 1.5 秒，收招 0.4 秒不該吃掉捕獲時間）
    if (elf.charge?.phase === 'recover' && this.authority && elf.cd.capture <= 0 && this.goblins.some((g) => !g.captured && !g.held && g.stun > 0 && d2(g.pos, elf.pos) < C.range))
      elf.cancelCharge()
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
      this.say(elf, 'elf', 'fNoStunned')
      return false
    }
    this.breakStealth()
    this.packId++
    elf.startPacking(best, best.charm > 0 ? C.charmedPackTime : C.packTime)
    this.emit({ e: 'pack', g: best.id })
    return true
  }

  // ───────────────────────── 紫晶精靈技能 ─────────────────────────
  // 隱身：隱身中再按一次＝現身（嚇到身邊的哥布林）；否則拉琴 castTime 秒後隱身
  violinStealth() {
    const elf = this.elf
    if (!this.authority || this.hud.phase !== 'play') return false
    if (elf.stealthed) {
      this.breakStealth()
      return true
    }
    if (!this.elfCanAct() || elf.cd.stealth > 0) return false
    elf.startStealthCast()
    this.emit({ e: 'vcast' })
    return true
  }

  // 結束隱身。fear：手動取消 / 施放其他技能時嚇到身邊的哥布林；時間到自然現身則不會
  breakStealth(fear = true) {
    const elf = this.elf
    if (!this.authority || !elf.stealthed) return
    const S = CONFIG.violin.stealth
    elf.exitStealth()
    const hits = fear ? fearTargets(elf.pos, this.goblins, S.fearRadius).filter((g) => this.sameRegion(g, elf)) : []
    for (const g of hits) {
      g.terror = S.fearTime
      g.attract = 0
      g.dashT = 0
    }
    this.emit({ e: 'stealth', on: false, p: [r2(elf.pos.x), r2(elf.pos.z)], fear: hits.map((g) => g.id) })
  }

  // 刺客之眼：第一次按＝開圖 7 秒；開圖中再按＝瞬移到最近的哥布林身後並進入冷卻
  violinEye() {
    const elf = this.elf
    if (!this.elfCanAct()) return false
    if (elf.eye > 0) return this.violinBlink()
    if (elf.cd.eye > 0) return false
    this.breakStealth()
    elf.openEye()
    elf.castT = 0.45
    elf.castPose = 'cast'
    this.emit({ e: 'eye', on: true })
    return true
  }

  private violinBlink() {
    const elf = this.elf
    const E = CONFIG.violin.eye
    const g = nearestTarget(elf.pos, this.goblins, E.blinkRange)
    if (!g) {
      this.say(elf, 'elf', 'fNoBlink')
      return false
    }
    const from = elf.pos.clone()
    // 身後被牆擋住時改試左右兩側、最後才站在原地附近
    const to = new THREE.Vector3()
    const tries = [0, 0.9, -0.9, 1.8, -1.8, Math.PI]
    const region = this.world.regionOf(g.pos)
    for (const a of tries) {
      behindSpot({ pos: g.pos, yaw: g.yaw + a }, E.behind, to)
      // 台地邊緣的哥布林：身後可能是懸崖外，落點要和哥布林在同一層
      if (!this.world.blockedAt(to.x, to.z, elf.radius) && this.world.regionOf(to) === region) break
    }
    this.world.resolve(to, elf.radius)
    elf.pos.copy(to)
    elf.vel.set(0, 0, 0)
    elf.yaw = Math.atan2(g.pos.x - to.x, g.pos.z - to.z)
    elf.corr++
    elf.closeEye()
    // 瞬移後短時間內的衝鋒會自動鎖定最近的哥布林（見 violinCharge）
    elf.blinkLock = E.lockTime
    this.emit({ e: 'blink', from: [r2(from.x), r2(from.z)], to: [r2(to.x), r2(to.z)], yaw: r2(elf.yaw) })
    this.emit({ e: 'eye', on: false })
    return true
  }

  // 衝鋒擊暈：前搖 → 朝 dir（角色面向）衝刺中距離，撞到的第一隻哥布林暈眩。
  // 刺客之眼瞬移後 lockTime 秒內施放＝鎖定衝鋒：不看 dir，直接朝衝鋒距離內最近的哥布林突刺，前搖與突刺途中持續追蹤
  violinCharge(dir: THREE.Vector3) {
    const elf = this.elf
    if (!this.elfCanAct() || elf.cd.charge > 0) return false
    dir = dir.clone()
    let target = -1
    if (elf.blinkLock > 0) {
      const g = nearestTarget(elf.pos, this.goblins.filter((x) => targetable(x) && this.sameRegion(x, elf)), CONFIG.violin.charge.distance)
      if (g) {
        target = g.id
        v2.copy(g.pos).sub(elf.pos).setY(0)
        if (v2.lengthSq() > 1e-4) dir.copy(v2).normalize()
      }
    }
    // 隱身中前搖仍保持隱身，突刺發動時才現身（見 updateCharge）
    elf.yaw = Math.atan2(dir.x, dir.z)
    elf.startCharge(dir, target)
    elf.vel.set(0, 0, 0)
    this.emit({ e: 'charge', o: [r2(elf.pos.x), r2(elf.pos.z)], d: [r2(dir.x), r2(dir.z)], g: target })
    return true
  }

  // 每個子步驟：前搖 → 突刺 → 收招。移動由房主 / 單機計算（精靈玩家是加入者時也在本機預測，結束時以房主位置為準）
  private updateCharge(dt: number) {
    const elf = this.elf
    const c = elf.charge
    if (!c) return
    const C = CONFIG.violin.charge
    c.t += dt
    // 鎖定衝鋒：前搖與突刺途中持續對準目標（目標被抓 / 打包 / 掙脫無敵後就維持最後的方向）
    const tg = c.target >= 0 && c.phase !== 'recover' ? this.goblins[c.target] : undefined
    if (tg && targetable(tg)) {
      v2.copy(tg.pos).sub(elf.pos).setY(0)
      if (v2.lengthSq() > 1e-4) c.dir.copy(v2).normalize()
    }
    elf.yaw = Math.atan2(c.dir.x, c.dir.z)
    if (c.phase === 'windup') {
      // 隱身中的前搖：哥布林看不到聚集的星塵
      if (!this.elfHiddenFromViewer()) this.violinFx.windupTick(dt, elf.pos)
      elf.vel.set(0, 0, 0)
      if (c.t >= C.windup) {
        // 突刺發動的同時解除隱身（嚇到身邊的哥布林）
        if (this.authority) this.breakStealth()
        c.phase = 'dash'
        c.t = 0
        sfx.charge()
        this.violinFx.dashStart(elf.pos, c.dir)
      }
      return
    }
    if (c.phase === 'dash') {
      const moves = this.authority || elf.isPlayer
      // 鎖定衝鋒：目標在前搖中衝刺逃開時，最多多追到 1.5 倍距離，「自動鎖定」才不會常常落空
      const limit = tg && targetable(tg) ? Math.min(C.distance * 1.5, Math.max(C.distance, c.done + d2(elf.pos, tg.pos))) : C.distance
      const left = limit - c.done
      if (moves && left > 0) {
        const step = Math.min(C.speed * dt, left)
        const from = v1.copy(elf.pos)
        elf.pos.addScaledVector(c.dir, step)
        this.world.resolve(elf.pos, elf.radius)
        const moved = d2(from, elf.pos)
        c.done += step
        elf.vel.copy(c.dir).multiplyScalar(C.speed)
        if (this.authority) {
          const g = sweepHit(from, elf.pos, this.goblins, C.hitRadius + 0.3)
          if (g) {
            // 停在哥布林面前
            elf.pos.copy(g.pos).addScaledVector(c.dir, -(elf.radius + g.radius + 0.1))
            this.world.resolve(elf.pos, elf.radius)
            g.stun = C.stun
            g.rooted = g.attract = g.dashT = g.terror = 0
            this.endCharge(g.id)
          } else if (moved < step * 0.4 || c.done >= limit - 1e-4) this.endCharge(-1)
        }
      } else elf.vel.set(0, 0, 0)
      this.violinFx.dashTick(dt, elf.pos, c.dir)
      return
    }
    elf.vel.set(0, 0, 0)
    if (c.t >= C.recover) elf.cancelCharge()
  }

  private endCharge(hit: number) {
    const elf = this.elf
    if (!elf.charge) return
    elf.recoverCharge(hit)
    elf.vel.set(0, 0, 0)
    elf.corr++
    this.emit({ e: 'chargeEnd', p: [r2(elf.pos.x), r2(elf.pos.z)], g: hit })
  }

  // 隱身中的精靈對目前的觀看者（哥布林玩家、觀戰者）是否看不見
  private elfHiddenFromViewer() {
    return this.elf.stealthed && this.me !== 'elf'
  }

  // 刺客之眼：哥布林的穿牆輪廓（只有精靈玩家看得到）
  private updateXray(on: boolean) {
    if (on === this.xrayOn && !on) return
    this.xrayOn = on
    if (on && !this.xrayMat)
      this.xrayMat = noOutline(
        new THREE.MeshBasicMaterial({ color: 0xc08cff, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }),
      )
    if (this.xrayMat) this.xrayMat.opacity = 0.38 + Math.sin(this.elapsed * 6) * 0.12
    for (const g of this.goblins) {
      let list = this.xray.get(g)
      const show = on && !g.captured
      if (!list && show) {
        list = []
        const meshes: THREE.Mesh[] = []
        g.model.root.traverse((o) => {
          const m = o as THREE.Mesh
          if (m.isMesh && !(o as unknown as THREE.Sprite).isSprite && m.visible) meshes.push(m)
        })
        for (const m of meshes) {
          const x = new THREE.Mesh(m.geometry, this.xrayMat!)
          x.renderOrder = 30
          x.frustumCulled = false
          x.userData.xray = true
          m.add(x)
          list.push(x)
        }
        this.xray.set(g, list)
      }
      if (list) for (const x of list) x.visible = show
    }
  }

  // ───────────────────────── 遊俠精靈技能 ─────────────────────────
  // 所有技能都是吹笛施放：召喚藤蔓陷阱、召喚箭矢、收網的繩索。沒有暈眩 / 定身，只能讓哥布林「受困」再從遠處收網。
  // 貼身干擾：有行動自如的哥布林貼在身邊時，吹笛（召喚箭、收網）的速度乘上 pressureRate
  rangerRate() {
    const R = CONFIG.ranger
    return this.elf.ranger && pressured(this.elf.pos, this.goblins, R.pressureRadius) ? R.pressureRate : 1
  }

  // 陷阱長出來的位置：面前 1.3 公尺；被牆擋住就放在腳邊
  private trapSpot(out = new THREE.Vector3()) {
    const elf = this.elf
    out.set(elf.pos.x + Math.sin(elf.yaw) * 1.3, 0, elf.pos.z + Math.cos(elf.yaw) * 1.3)
    if (this.world.blockedAt(out.x, out.z, 0.4) || this.world.regionOf(out) !== this.world.regionOf(elf.pos)) out.copy(elf.pos)
    return out
  }

  // 藤蔓陷阱：吹一小段笛音（castTime 秒）後藤蔓從面前的地上長出來，再過 armTime 秒生效
  rangerTrap() {
    const elf = this.elf
    const r = elf.ranger
    if (!r || !this.elfCanAct()) return false
    if (r.charges <= 0) {
      this.say(elf, 'elf', 'fNoCharge')
      return false
    }
    if (!canPlantAt(this.trapSpot(v2), this.goblins)) {
      this.say(elf, 'elf', 'fTrapTooClose')
      return false
    }
    r.plant = 0
    elf.vel.set(0, 0, 0)
    this.emit({ e: 'rplant' })
    return true
  }

  private addTrap(pos: THREE.Vector3, arm: number) {
    const r = this.elf.ranger!
    const T = CONFIG.ranger.trap
    const tr: Trap = { id: ++r.seq, pos: pos.clone().setY(0), arm, life: T.life, region: this.world.regionOf(pos) }
    r.traps.push(tr)
    this.emit({ e: 'trap', id: tr.id, p: [r2(pos.x), r2(pos.z)], arm })
    while (r.traps.length > T.maxActive) this.removeTrap(r.traps[0], TRAP_GONE.old, -1)
  }

  private removeTrap(tr: Trap, why: number, g: number) {
    const r = this.elf.ranger!
    const i = r.traps.indexOf(tr)
    if (i < 0) return
    r.traps.splice(i, 1)
    this.emit({ e: 'trapGone', id: tr.id, p: [r2(tr.pos.x), r2(tr.pos.z)], why, g })
  }

  // 受困：被藤蔓纏住不能動，精靈可以從遠處收網
  private snareGoblin(g: Goblin, secs: number) {
    g.snare = Math.max(g.snare, secs)
    g.mark = g.slow = 0
    g.attract = g.dashT = g.terror = 0
  }

  // 召喚箭矢：朝 dir 吹笛 draw 秒後射出。aim＝鎖定的目標（AI 指定；玩家則是準星附近 AIM_CONE 內的哥布林），
  // 射出時會瞄準目標屆時的位置；目標在吹奏途中改變方向仍然躲得掉
  rangerArrow(dir: THREE.Vector3, aim: Goblin | null = null) {
    const elf = this.elf
    const r = elf.ranger
    const A = CONFIG.ranger.arrow
    if (!r || !this.elfCanAct() || r.cd.arrow > 0) return false
    dir = dir.clone()
    if (!aim) {
      let best = AIM_CONE
      for (const g of this.goblins) {
        if (!targetable(g)) continue
        v2.subVectors(g.pos, elf.pos).setY(0)
        const d = v2.length()
        if (d < 0.5 || d > A.range) continue
        const cos = v2.dot(dir) / d
        if (cos > best && this.world.lineOfSight(elf.pos, g.pos)) {
          best = cos
          aim = g
        }
      }
    }
    r.cd.arrow = A.cooldown
    r.draw = { t: 0, dir, aim: aim ? aim.id : -1 }
    elf.yaw = Math.atan2(dir.x, dir.z)
    elf.vel.set(0, 0, 0)
    this.emit({ e: 'draw', d: [r2(dir.x), r2(dir.z)] })
    return true
  }

  private fireArrow() {
    const elf = this.elf
    const r = elf.ranger!
    const A = CONFIG.ranger.arrow
    const dir = r.draw!.dir
    const g = this.goblins[r.draw!.aim]
    if (g && targetable(g)) {
      // 瞄準目標在箭飛到時的位置
      const lead = d2(g.pos, elf.pos) / A.speed
      v2.copy(g.pos).addScaledVector(g.vel, lead).sub(elf.pos).setY(0)
      if (v2.lengthSq() > 1e-4) dir.copy(v2).normalize()
    }
    r.draw = null
    elf.yaw = Math.atan2(dir.x, dir.z)
    const len = this.world.rayDistance(elf.pos, dir, A.range)
    const id = ++r.seq
    r.arrows.push({ id, from: elf.pos.clone(), pos: elf.pos.clone(), dir: dir.clone(), done: 0, len })
    this.emit({ e: 'arrow', id, o: [r2(elf.pos.x), r2(elf.pos.z)], d: [dir.x, dir.z], len: r2(len) })
  }

  // 後躍撤步：朝遠離最近哥布林的方向跳開（附近沒有哥布林就往背後跳），在起跳位置留下一個不佔充能的陷阱
  rangerLeap() {
    const elf = this.elf
    const r = elf.ranger
    const L = CONFIG.ranger.leap
    if (!r || !this.elfCanAct() || r.cd.leap > 0) return false
    const dir = new THREE.Vector3(-Math.sin(elf.yaw), 0, -Math.cos(elf.yaw))
    const near = nearestTarget(elf.pos, this.goblins.filter((g) => !g.disabled && this.sameRegion(g, elf)), LEAP_AWAY)
    if (near) {
      v2.subVectors(elf.pos, near.pos).setY(0)
      if (v2.lengthSq() > 1e-4) dir.copy(v2).normalize()
    }
    r.cd.leap = L.cooldown
    r.leap = { t: 0, dir, done: 0 }
    elf.yaw = Math.atan2(-dir.x, -dir.z)
    elf.vel.set(0, 0, 0)
    const from = elf.pos.clone()
    this.emit({ e: 'leap', o: [r2(from.x), r2(from.z)], d: [r2(dir.x), r2(dir.z)] })
    if (canPlantAt(from, this.goblins)) this.addTrap(from, LEAP_TRAP_ARM)
    return true
  }

  // 可以收網的哥布林：受困中、距離在 minRange～maxRange、視線可及；取最近的
  reelTarget(): Goblin | null {
    const elf = this.elf
    let best: Goblin | null = null
    let bd = Infinity
    for (const g of this.goblins) {
      if (g.captured || g.held || g.snare <= 0) continue
      const d = d2(g.pos, elf.pos)
      if (d < bd && reelRange(d) === 'ok' && this.world.lineOfSight(elf.pos, g.pos)) {
        bd = d
        best = g
      }
    }
    return best
  }

  // 收網（遊俠的捕獲）：吹笛把繩索套上遠處受困的哥布林，收網完成就抓進牢籠。隊友要跑到被困者身邊割斷繩索
  private rangerReel() {
    const elf = this.elf
    const R = CONFIG.ranger.reel
    if (!this.elfCanAct() || elf.cd.capture > 0) return false
    const g = this.reelTarget()
    if (!g) {
      const close = this.goblins.some((x) => !x.captured && !x.held && x.snare > 0 && d2(x.pos, elf.pos) < R.minRange)
      this.say(elf, 'elf', close ? 'fReelTooClose' : 'fNoSnared')
      return false
    }
    this.packId++
    elf.startPacking(g, R.time)
    elf.vel.set(0, 0, 0)
    this.emit({ e: 'pack', g: g.id })
    return true
  }

  // 哥布林對遊俠精靈的攪局：在被收網的隊友身邊＝割斷繩索；否則拆掉身邊的陷阱
  private goblinCut(g: Goblin) {
    const elf = this.elf
    const R = CONFIG.ranger
    const p = elf.packing
    if (p && p.g !== g && d2(g.pos, p.g.pos) <= R.reel.cutRange) {
      g.interfereCd = CONFIG.goblin.interfereCooldown
      const freed = p.g
      this.interruptPacking('interfere', g)
      // 割斷的藤蔓還纏在身上：割繩的哥布林與被救的同伴都被標記（再中一箭就受困），救人有風險
      if (R.reel.cutMark > 0) {
        g.mark = Math.max(g.mark, R.reel.cutMark)
        if (R.reel.freedMark) freed.mark = Math.max(freed.mark, R.reel.cutMark)
      }
      return true
    }
    const region = this.world.regionOf(g.pos)
    let best: Trap | null = null
    let bd = R.trap.disarmRange
    for (const tr of elf.ranger!.traps) {
      const d = d2(tr.pos, g.pos)
      if (d < bd && tr.region === region) {
        bd = d
        best = tr
      }
    }
    if (best) {
      g.interfereCd = CONFIG.goblin.interfereCooldown
      this.removeTrap(best, TRAP_GONE.cut, g.id)
      return true
    }
    this.say(g, g.id, p && p.g !== g ? 'fCutTooFar' : 'fNoTarget')
    return false
  }

  // 每個子步驟：充能、吹笛放陷阱 / 召喚箭、箭矢飛行、後躍的位移、陷阱觸發
  private updateRanger(dt: number) {
    const elf = this.elf
    const r = elf.ranger!
    const R = CONFIG.ranger
    const auth = this.authority
    r.cd.arrow = Math.max(0, r.cd.arrow - dt)
    r.cd.leap = Math.max(0, r.cd.leap - dt)
    if (r.charges < R.trap.charges) {
      r.recharge -= dt
      if (r.recharge <= 0 && auth) {
        r.charges++
        r.recharge = r.charges < R.trap.charges ? R.trap.recharge : 0
      }
    }
    if (r.plant >= 0) {
      r.plant += dt
      if (r.plant >= R.trap.castTime && auth) {
        r.plant = -1
        if (r.charges === R.trap.charges) r.recharge = R.trap.recharge
        r.charges--
        this.addTrap(this.trapSpot(), R.trap.armTime)
      }
    }
    if (r.draw) {
      r.draw.t += dt * this.rangerRate()
      this.rangerFx.drawTick(dt, elf.pos, elf.yaw, Math.min(1, r.draw.t / R.arrow.draw))
      if (r.draw.t >= R.arrow.draw && auth) this.fireArrow()
    }
    if (r.leap) {
      const l = r.leap
      const L = R.leap
      l.t += dt
      if (auth || elf.isPlayer) {
        const step = Math.min((L.distance / L.time) * dt, Math.max(0, L.distance - l.done))
        elf.pos.addScaledVector(l.dir, step)
        this.world.resolve(elf.pos, elf.radius)
        l.done += step
      }
      elf.vel.set(0, 0, 0)
      if (l.t >= L.time && auth) {
        r.leap = null
        elf.corr++
        this.emit({ e: 'leapEnd', p: [r2(elf.pos.x), r2(elf.pos.z)] })
      }
    }
    if (!auth) return
    // 箭矢：掃掠判定，碰到的第一隻哥布林依飛行距離決定效果
    for (let i = r.arrows.length - 1; i >= 0; i--) {
      const a = r.arrows[i]
      const step = Math.min(R.arrow.speed * dt, a.len - a.done)
      const from = v1.copy(a.pos)
      a.pos.addScaledVector(a.dir, step)
      a.done += step
      const g = sweepHit(from, a.pos, this.goblins, R.arrow.hitRadius)
      if (g) {
        const k = arrowEffect(d2(a.from, g.pos), g)
        if (k === 'snare') this.snareGoblin(g, R.arrow.snare)
        else if (k === 'mark') g.mark = R.arrow.markTime
        else g.slow = R.arrow.slowTime
        r.cd.arrow = Math.min(r.cd.arrow, R.arrow.hitCooldown)
        r.arrows.splice(i, 1)
        this.emit({ e: 'arrowHit', id: a.id, p: [r2(g.pos.x), r2(g.pos.z)], g: g.id, k })
      } else if (a.done >= a.len - 1e-4) {
        r.arrows.splice(i, 1)
        this.emit({ e: 'arrowHit', id: a.id, p: [r2(a.pos.x), r2(a.pos.z)], g: -1, k: 'slow' })
      }
    }
    // 陷阱：生效計時、存在時間、觸發
    for (let i = r.traps.length - 1; i >= 0; i--) {
      const tr = r.traps[i]
      tr.arm = Math.max(0, tr.arm - dt)
      tr.life -= dt
      if (tr.life <= 0) {
        this.removeTrap(tr, TRAP_GONE.old, -1)
        continue
      }
      if (tr.arm > 0) continue
      for (const g of this.goblins) {
        if (g.captured || g.held || g.grace > 0 || g.snare > 0) continue
        if (d2(g.pos, tr.pos) > R.trap.triggerRadius || this.world.regionOf(g.pos) !== tr.region) continue
        this.snareGoblin(g, R.trap.snare)
        g.reveal = R.trap.minimapTime
        this.removeTrap(tr, TRAP_GONE.snap, g.id)
        break
      }
    }
  }

  // 遊俠精靈的常駐特效：腳邊的葉片、陷阱（依觀看者決定看不看得到）、收網的繩索
  private updateRangerFx(dt: number) {
    const elf = this.elf
    const r = elf.ranger!
    for (let k = 0; k < this.fx.rate('elftrail', 1.5 + elf.moveAmt * 10, dt); k++) this.fx.trail(elf.pos, Math.random() < 0.6 ? 0xc8f5a0 : 0xfff6c8, 0.2 + Math.random() * 1.4)
    this.rangerFx.ambient(dt, elf.pos, elf.moveAmt)
    this.rangerFx.syncTraps(r.traps, this.me === 'elf' ? null : this.focusActor().pos, CONFIG.ranger.trap.revealRadius)
    const p = elf.packing
    if (p) this.rangerFx.rope(dt, elf.pos, elf.yaw, p.g.pos, p.t / p.total)
    else this.rangerFx.ropeOff()
  }

  // 目前的觀看者看不看得到這個位置的陷阱：精靈玩家都看得到；哥布林（含觀戰）要靠近到 revealRadius 內
  private trapVisible(p: THREE.Vector3) {
    return this.me === 'elf' || d2(p, this.focusActor().pos) < CONFIG.ranger.trap.revealRadius
  }

  private interruptPacking(reason: 'ult' | 'interfere', by?: Goblin) {
    const elf = this.elf
    if (!elf.packing) return
    // 遊俠的收網有自己的進度保留比例（reel.keep / keepMax / keepTime）
    const C = elf.ranger ? CONFIG.ranger.reel : CONFIG.elf.capture
    const p = elf.packing
    const g = elf.endPacking()
    // 攪局：保留這次新增進度的一部分；大招掙脫：進度歸零
    if (reason === 'interfere') {
      const done = Math.min(1, p.t / p.total)
      g.packSaved = Math.min(C.keepMax, g.packSaved + Math.max(0, done - g.packSaved) * C.keep)
      g.packSavedT = C.keepTime
    } else g.packSaved = g.packSavedT = 0
    // 遊俠站在遠處，繩索被割斷只會短暫踉蹌（cutStagger）；被大招掙脫則和其他精靈一樣
    elf.stagger = reason === 'ult' ? CONFIG.elf.staggerOnInterrupt + 0.4 : elf.ranger ? CONFIG.ranger.reel.cutStagger : CONFIG.elf.staggerOnInterrupt
    g.stun = 0
    g.rooted = 0
    g.snare = 0
    g.grace = CONFIG.goblin.breakFreeGrace
    v1.subVectors(g.pos, elf.pos).setY(0).normalize()
    g.pos.addScaledVector(v1, 1.2)
    g.corr++
    if (reason === 'ult') g.dashT = 1.2
    this.emit({ e: 'free', g: g.id, by: by ? by.id : -1, ult: reason === 'ult' })
  }

  private completeCapture() {
    const elf = this.elf
    const g = elf.endPacking()
    const n = this.goblins.filter((x) => x.captured).length
    g.capture()
    g.stun = g.rooted = g.attract = g.charm = 0
    g.snare = g.mark = g.slow = g.reveal = 0
    g.capturedAt = this.elapsed
    g.zone = -2
    g.corr++
    const a = n * (Math.PI * 2 / CONFIG.goblinCount)
    const to = new THREE.Vector3(this.world.cagePos.x + Math.cos(a) * 1.5, 0, this.world.cagePos.z + Math.sin(a) * 1.5)
    if (!elf.isPlayer) elf.ai.patrolWait = CONFIG.elf.aiRest
    const free = this.goblins.filter((x) => !x.captured).length
    this.emit({ e: 'caught', g: g.id, from: [r2(g.pos.x), r2(g.pos.z)], to: [r2(to.x), r2(to.z)], free })
    if (free === 0) this.finish('elf')
  }

  // ───────────────────────── 哥布林技能 ─────────────────────────
  goblinDash(g: Goblin) {
    if (!this.authority || g.captured || g.disabled || g.dashCd > 0) return false
    g.dashT = CONFIG.goblin.dashDuration
    g.dashCd = CONFIG.goblin.dashCooldown
    this.emit({ e: 'dash', g: g.id })
    return true
  }

  goblinInterfere(g: Goblin) {
    const elf = this.elf
    if (!this.authority || g.captured || g.disabled || g.interfereCd > 0) return false
    if (g.attract > 0) {
      this.say(g, g.id, 'fLured')
      return false
    }
    if (elf.ranger) return this.goblinCut(g)
    if (!elf.packing || elf.packing.g === g) {
      this.say(g, g.id, 'fNoTarget')
      return false
    }
    if (d2(g.pos, elf.pos) > CONFIG.goblin.interfereRange) {
      this.say(g, g.id, 'fTooFar')
      return false
    }
    g.interfereCd = CONFIG.goblin.interfereCooldown
    this.interruptPacking('interfere', g)
    return true
  }

  goblinUlt(g: Goblin) {
    if (!this.authority) return false
    if (g.ultUsed || !g.held || this.elf.packing?.g !== g) {
      if (!g.ultUsed) this.say(g, g.id, 'fUltOnlyHeld')
      return false
    }
    g.ultUsed = true
    this.interruptPacking('ult')
    return true
  }

  // 只給操控該角色的真人看的小提示（AI 角色不送）
  private say(a: Actor, s: Slot, k: TKey) {
    if (a.isPlayer || a.netDriven) this.emit({ e: 'say', s, k })
  }

  // ───────────────────────── 事件呈現（各端依自己的視角） ─────────────────────────
  private emit(ev: GameEvent) {
    this.present(ev)
    if (this.net?.host) this.evQueue.push(ev)
  }

  private present(ev: GameEvent) {
    const elf = this.elf
    const me = this.playerGoblin
    switch (ev.e) {
      case 'go':
        if (this.hud.phase !== 'countdown') return
        this.hud.phase = 'play'
        this.syncGameplay()
        this.toast(this.role === 'elf' ? t('tHuntStart') : t('tHideStart'), 'info')
        return
      case 'gaze': {
        const G = CONFIG.elf.gaze
        const origin = new THREE.Vector3(ev.o[0], 0, ev.o[1])
        const dir = new THREE.Vector3(ev.d[0], 0, ev.d[1])
        elf.yaw = Math.atan2(dir.x, dir.z)
        elf.castT = 0.45
        elf.castPose = 'cast'
        const hitPos: THREE.Vector3[] = []
        for (const id of ev.hits) {
          const g = this.goblins[id]
          hitPos.push(g.pos.clone())
          this.floatText(t('fRooted'), g.pos, '#ff7fb8')
        }
        this.fx.gazeBeam(origin, dir, ev.len, hitPos, ev.len < G.range - 0.5)
        this.elfFx.gaze(origin, dir)
        sfx.gaze()
        if (me && ev.hits.includes(me.id)) {
          this.shake = Math.max(this.shake, 0.25)
          this.toast(t('tYouRooted'), 'bad')
        }
        return
      }
      case 'music':
        if (!this.authority) elf.channel = ev.on ? Math.max(elf.channel, 0) : -1
        elf.model.setHarp?.(ev.on)
        if (!ev.on) return
        this.fx.ring(elf.pos, CONFIG.elf.music.radius, 0xffe9a0, 1.4, 0.05)
        this.fx.sparkles(elf.pos, 20, 0xffe6a0, 0.6, 2.5, 1.2)
        this.elfFx.musicStart(elf.pos)
        if (this.role === 'goblin') this.toast(t('tMusicStart'), 'warn')
        // 彈奏期間精靈的小地圖顯示所有哥布林（剩一兩隻躲在視野外時找得到）
        else if (this.role === 'elf') this.toast(t('tMusicScan'), 'good')
        return
      case 'miss': {
        elf.castT = 0.3
        elf.castPose = 'attack'
        const at = new THREE.Vector3(ev.o[0] + Math.sin(ev.yaw), 0, ev.o[1] + Math.cos(ev.yaw))
        this.fx.dust(at.x, at.z, 4, 0.8, 0xffffff)
        this.floatText(t('fMiss'), at, '#dddddd')
        return
      }
      case 'stun': {
        const g = this.goblins[ev.g]
        elf.castT = 0.3
        elf.castPose = 'attack'
        elf.yaw = Math.atan2(g.pos.x - elf.pos.x, g.pos.z - elf.pos.z)
        sfx.stun()
        this.fx.starBurst(g.pos)
        this.elfFx.stun(g.pos)
        this.fx.pow(g.pos, t('fBonk'), '#ffd23f')
        if (g.isPlayer || this.role === 'elf') this.shake = Math.max(this.shake, g.isPlayer ? 0.45 : 0.2)
        if (g.isPlayer) this.toast(t('tYouStunned'), 'bad')
        return
      }
      case 'pack': {
        const g = this.goblins[ev.g]
        elf.cancelCharge()
        this.fx.dust(g.pos.x, g.pos.z, 10, 1.4)
        this.fx.sparkles(g.pos, 10, 0xffe6a0, 0.4, 1.5, 0.8)
        elf.yaw = Math.atan2(g.pos.x - elf.pos.x, g.pos.z - elf.pos.z)
        if (elf.ranger) {
          // 遊俠：繩索從笛子飛向遠處的哥布林；救人要跑到被困的隊友身邊
          elf.ranger.cancel()
          this.rangerFx.reelStart(elf.pos, g.pos)
          sfx.reel()
          if (g.isPlayer) this.toast(g.ultUsed ? t('tYouReeled') : touchMode.value ? t('tYouPackedUltTouch') : t('tYouPackedUlt', { key: keyLabel(this.binds.goblin.ult) }), 'bad')
          else if (this.role === 'goblin') this.toast(touchMode.value ? t('tAllyReeledTouch', { name: g.name }) : t('tAllyReeled', { name: g.name, key: keyLabel(this.binds.goblin.interfere) }), 'warn')
          return
        }
        this.elfFx.capture(g.pos)
        if (g.isPlayer) this.toast(g.ultUsed ? t('tYouPacked') : touchMode.value ? t('tYouPackedUltTouch') : t('tYouPackedUlt', { key: keyLabel(this.binds.goblin.ult) }), 'bad')
        else if (this.role === 'goblin') this.toast(touchMode.value ? t('tAllyPackedTouch', { name: g.name }) : t('tAllyPacked', { name: g.name, key: keyLabel(this.binds.goblin.interfere) }), 'warn')
        return
      }
      case 'free': {
        const g = this.goblins[ev.g]
        const by = ev.by >= 0 ? this.goblins[ev.by] : undefined
        if (ev.ult) {
          sfx.breakFree()
          this.fx.shockwave(g.pos)
          this.fx.pow(g.pos, t('fFree'), '#8ff27a')
          this.shake = Math.max(this.shake, 0.5)
          this.toast(g.isPlayer ? t('tYouBrokeFree') : t('tBrokeFree', { name: g.name }), g.isPlayer || this.role === 'goblin' ? 'good' : 'bad')
        } else {
          sfx.interfere()
          const at = by && !elf.ranger ? by.pos.clone().lerp(elf.pos, 0.5) : g.pos
          this.fx.starBurst(at, 0x9effa0)
          this.fx.pow(at, 'POW!', '#ffd23f')
          this.fx.dust(g.pos.x, g.pos.z, 10, 1.6)
          this.shake = Math.max(this.shake, 0.35)
          this.toast(t('tRescued', { by: by?.isPlayer ? t('you') : by?.name ?? t('aGoblin'), name: g.isPlayer ? t('you') : g.name }), this.role === 'goblin' ? 'good' : 'bad')
          // 遊俠：割斷的藤蔓反纏上來，割繩的哥布林被標記
          if (elf.ranger && by && CONFIG.ranger.reel.cutMark > 0) {
            this.floatText(t('fMarked'), by.pos, '#d8ff9a')
            if (by.isPlayer) this.toast(t('tYouCutMarked'), 'warn')
          }
        }
        return
      }
      case 'caught': {
        const g = this.goblins[ev.g]
        const from = new THREE.Vector3(ev.from[0], 0, ev.from[1])
        const to = new THREE.Vector3(ev.to[0], 0, ev.to[1])
        g.capture()
        g.zone = -2
        g.net = null
        g.pos.copy(to)
        g.vel.set(0, 0, 0)
        g.flight = { from, to, t: 0, dur: Math.min(2.2, 0.8 + from.distanceTo(to) / 60) }
        this.fx.sparkles(from, 24, 0xffe6a0, 0.6, 3, 1)
        this.fx.ring(from, 3, 0xffe6a0, 0.6, 0.12)
        sfx.captured()
        if (g.isPlayer) {
          this.toast(t(touchMode.value ? 'tYouCapturedTouch' : 'tYouCaptured'), 'bad')
          this.setSpeed(1)
        } else this.toast(t('tCaptured', { name: g.name, n: ev.free }), this.role === 'elf' ? 'good' : 'bad')
        return
      }
      case 'dash': {
        const g = this.goblins[ev.g]
        this.fx.dust(g.pos.x, g.pos.z, 8, 1.3)
        this.fx.ring(g.pos, 1.6, 0xdff8ff, 0.35, 0.18)
        if (g.isPlayer) sfx.dash()
        return
      }
      case 'charm':
        if (this.goblins[ev.g]?.isPlayer) this.toast(t('tYouCharmed'), 'bad')
        return
      case 'vcast':
        if (!this.authority) elf.startStealthCast()
        this.violinNoteT = 0
        this.violinFx.castStart(elf.pos)
        return
      case 'stealth': {
        const p = new THREE.Vector3(ev.p[0], 0, ev.p[1])
        const S = CONFIG.violin.stealth
        if (ev.on) {
          if (!this.authority) elf.enterStealth()
          // 隱身的瞬間：紫霧所有人都看得到，然後迅速散去
          this.violinFx.vanish(p)
          sfx.vanish()
          if (this.role === 'elf') this.toast(t('tStealthOn'), 'good')
          else this.toast(t('tElfVanished'), 'warn')
          return
        }
        if (!this.authority) {
          elf.exitStealth()
          for (const id of ev.fear) if (this.goblins[id]) this.goblins[id].terror = S.fearTime
        }
        this.violinFx.reveal(p, ev.fear.length ? S.fearRadius : 0)
        sfx.reveal(ev.fear.length > 0)
        for (const id of ev.fear) {
          const g = this.goblins[id]
          if (!g) continue
          this.floatText(t('fFear'), g.pos, '#c89bff')
          if (g.isPlayer) {
            this.shake = Math.max(this.shake, 0.4)
            this.toast(t('tYouFeared'), 'bad')
          }
        }
        if (this.role === 'elf') this.toast(ev.fear.length ? t('tFeared', { n: ev.fear.length }) : t('tStealthOff'), ev.fear.length ? 'good' : 'info')
        else if (!me?.captured) this.toast(t('tElfRevealed'), 'warn')
        return
      }
      case 'eye':
        if (!this.authority) elf.eye = ev.on ? CONFIG.violin.eye.duration : 0
        if (!ev.on) return
        elf.castT = 0.45
        elf.castPose = 'cast'
        this.violinFx.eyeCast(elf.pos)
        if (this.role === 'elf') {
          sfx.eye()
          this.toast(touchMode.value ? t('tEyeOnTouch') : t('tEyeOn', { key: keyLabel(this.binds.elf.music) }), 'good')
        } else if (me && !me.captured) {
          sfx.eyeWarn()
          this.toast(t('tEyeWarn'), 'warn')
        }
        return
      case 'blink': {
        const from = new THREE.Vector3(ev.from[0], 0, ev.from[1])
        const to = new THREE.Vector3(ev.to[0], 0, ev.to[1])
        if (!this.authority) {
          if (!elf.isPlayer) {
            elf.pos.copy(to)
            if (elf.net) Object.assign(elf.net, { x: to.x, z: to.z, yaw: ev.yaw, t: 0 })
          }
          elf.yaw = ev.yaw
          elf.blinkLock = CONFIG.violin.eye.lockTime
        }
        this.violinFx.blink(from, to)
        sfx.blink()
        if (me && !me.captured && d2(me.pos, to) < 4) {
          this.shake = Math.max(this.shake, 0.3)
          this.toast(t('tBlinkBehind'), 'bad')
        }
        return
      }
      case 'charge': {
        const dir = new THREE.Vector3(ev.d[0], 0, ev.d[1]).normalize()
        if (!this.authority) {
          elf.startCharge(dir, Number.isInteger(ev.g) && this.goblins[ev.g!] ? ev.g! : -1)
          if (elf.isPlayer) elf.pos.set(ev.o[0], 0, ev.o[1])
        }
        elf.yaw = Math.atan2(dir.x, dir.z)
        if (!this.elfHiddenFromViewer()) {
          this.violinFx.windupStart(elf.pos)
          sfx.windup()
        }
        return
      }
      case 'chargeEnd': {
        if (!this.authority) {
          // 漏收了開始衝鋒的事件：以目前面向補一個衝鋒狀態
          if (!elf.charge) elf.startCharge(new THREE.Vector3(Math.sin(elf.yaw), 0, Math.cos(elf.yaw)))
          elf.recoverCharge(ev.g)
        }
        const g = ev.g >= 0 ? this.goblins[ev.g] : undefined
        if (!g) {
          const at = new THREE.Vector3(ev.p[0], 0, ev.p[1])
          this.fx.dust(at.x, at.z, 6, 1)
          this.floatText(t('fMiss'), at, '#dddddd')
          return
        }
        if (!this.authority) g.stun = CONFIG.violin.charge.stun
        sfx.chargeHit()
        this.violinFx.chargeHit(g.pos)
        this.fx.starBurst(g.pos, 0xd8a8ff)
        this.fx.pow(g.pos, t('fBonk'), '#d8a8ff')
        if (g.isPlayer || this.role === 'elf') this.shake = Math.max(this.shake, g.isPlayer ? 0.5 : 0.28)
        if (g.isPlayer) this.toast(t('tYouCharged'), 'bad')
        return
      }
      case 'rplant': {
        const r = elf.ranger
        if (!r) return
        if (!this.authority) r.plant = Math.max(r.plant, 0)
        this.rangerFx.plantStart(elf.pos, elf.yaw)
        sfx.fluteNote(0, 0.3)
        return
      }
      case 'trap': {
        const r = elf.ranger
        if (!r) return
        const p = new THREE.Vector3(ev.p[0], 0, ev.p[1])
        if (!this.authority) {
          r.plant = -1
          if (!r.traps.some((x) => x.id === ev.id)) r.traps.push({ id: ev.id, pos: p.clone(), arm: ev.arm, life: CONFIG.ranger.trap.life, region: this.world.regionOf(p) })
        }
        if (this.trapVisible(p)) {
          this.rangerFx.trapSprout(p)
          sfx.trapSet()
        }
        return
      }
      case 'trapGone': {
        const r = elf.ranger
        if (!r) return
        const p = new THREE.Vector3(ev.p[0], 0, ev.p[1])
        const seen = this.trapVisible(p)
        if (!this.authority) {
          const i = r.traps.findIndex((x) => x.id === ev.id)
          if (i >= 0) r.traps.splice(i, 1)
        }
        const g = this.goblins[ev.g]
        if (ev.why === TRAP_GONE.snap && g) {
          if (!this.authority) {
            g.snare = CONFIG.ranger.trap.snare
            g.reveal = CONFIG.ranger.trap.minimapTime
          }
          this.rangerFx.snareBurst(g.pos)
          sfx.trapSnap()
          this.floatText(t('fSnared'), g.pos, '#a8f08a')
          if (g.isPlayer) {
            this.shake = Math.max(this.shake, 0.4)
            this.toast(t('tYouSnared'), 'bad')
          } else if (this.role === 'elf') this.toast(t('tTrapSprung', { name: g.name }), 'good')
          else if (!me?.captured) this.toast(t('tAllySnared', { name: g.name }), 'warn')
        } else if (ev.why === TRAP_GONE.cut) {
          this.rangerFx.trapWither(p)
          sfx.interfere()
          this.floatText(t('fDisarmed'), p, '#dddddd', 0.6)
          if (this.role === 'elf') this.toast(t('tTrapCut', { name: g?.name ?? t('aGoblin') }), 'warn')
        } else if (seen) this.rangerFx.trapWither(p)
        return
      }
      case 'draw': {
        const r = elf.ranger
        if (!r) return
        const dir = new THREE.Vector3(ev.d[0], 0, ev.d[1]).normalize()
        if (!this.authority) r.draw = { t: 0, dir, aim: -1 }
        elf.yaw = Math.atan2(dir.x, dir.z)
        sfx.fluteNote(elf.musicNote++, 0.3)
        return
      }
      case 'arrow': {
        const r = elf.ranger
        if (!r) return
        const o = new THREE.Vector3(ev.o[0], 0, ev.o[1])
        const dir = new THREE.Vector3(ev.d[0], 0, ev.d[1]).normalize()
        if (!this.authority) r.draw = null
        elf.yaw = Math.atan2(dir.x, dir.z)
        // 放箭後的收勢：短暫放慢腳步，動作播完
        elf.castT = 0.3
        elf.castPose = 'shoot'
        this.rangerFx.arrowSpawn(ev.id, o, dir, ev.len, CONFIG.ranger.arrow.speed)
        sfx.arrow()
        return
      }
      case 'arrowHit': {
        const p = new THREE.Vector3(ev.p[0], 0, ev.p[1])
        const g = this.goblins[ev.g]
        this.rangerFx.arrowEnd(ev.id, p, !!g)
        if (!g) return
        const A = CONFIG.ranger.arrow
        if (!this.authority) {
          if (ev.k === 'snare') {
            g.snare = A.snare
            g.mark = g.slow = 0
          } else if (ev.k === 'mark') g.mark = A.markTime
          else g.slow = A.slowTime
        }
        sfx.arrowHit(ev.k === 'snare')
        if (ev.k === 'snare') {
          this.rangerFx.snareBurst(g.pos)
          this.floatText(t('fSnared'), g.pos, '#a8f08a')
          if (g.isPlayer) {
            this.shake = Math.max(this.shake, 0.4)
            this.toast(t('tYouSnared'), 'bad')
          } else if (this.role === 'elf') {
            // 收網有距離限制：太遠 / 太近時直接告訴玩家該怎麼做
            const where = reelRange(d2(g.pos, elf.pos))
            if (where === 'far') this.toast(t('tSnaredFar', { name: g.name, m: CONFIG.ranger.reel.maxRange }), 'good')
            else if (where === 'near') this.toast(t('tSnaredNear', { name: g.name }), 'good')
            else this.toast(touchMode.value ? t('tSnaredTouch', { name: g.name }) : t('tSnared', { name: g.name, key: keyLabel(this.binds.elf.capture) }), 'good')
          } else if (!me?.captured) this.toast(t('tAllySnared', { name: g.name }), 'warn')
        } else if (ev.k === 'mark') {
          this.floatText(t('fMarked'), g.pos, '#d8ff9a')
          if (g.isPlayer) {
            this.shake = Math.max(this.shake, 0.25)
            this.toast(t('tYouMarked'), 'bad')
          }
        } else {
          this.floatText(t('fSlowed'), g.pos, '#bfe8ff')
          if (g.isPlayer) this.toast(t('tYouSlowed'), 'warn')
        }
        return
      }
      case 'leap': {
        const r = elf.ranger
        if (!r) return
        const o = new THREE.Vector3(ev.o[0], 0, ev.o[1])
        const dir = new THREE.Vector3(ev.d[0], 0, ev.d[1]).normalize()
        if (!this.authority) {
          r.leap = { t: 0, dir, done: 0 }
          if (elf.isPlayer) elf.pos.copy(o)
        }
        elf.yaw = Math.atan2(-dir.x, -dir.z)
        this.rangerFx.leap(o, dir)
        sfx.leap()
        return
      }
      case 'leapEnd':
        if (!this.authority && elf.ranger) elf.ranger.leap = null
        this.fx.dust(ev.p[0], ev.p[1], 6, 0.9)
        return
      case 'say':
        if (ev.s === this.me) this.floatText(t(ev.k), this.actorOf(this.me).pos, '#dddddd', 0.6, 0.25)
        return
      case 'left':
        this.toast(t('tPlayerLeft', { name: ev.name }), 'warn')
        return
      case 'warp': {
        const w = this.world.warps[ev.w]
        if (!w || !this.validSlot(ev.s)) return
        const a = this.actorOf(ev.s)
        const hidden = a === elf && this.elfHiddenFromViewer()
        // 彈跳蘑菇：從起跳點畫一道拋物線到落點（遊戲邏輯已在落點）
        if (w.kind === 'bounce') {
          a.hop = { from: new THREE.Vector3(w.from.x, groundAt(w.from.x, w.from.z), w.from.z), t: 0, dur: HOP_TIME, peak: 7 }
          this.world.bounce(w.id)
        } else a.hop = null
        if (!hidden) {
          this.fx.ring(w.from, 2.2, w.color, 0.5, 0.15)
          this.fx.sparkles(w.from, 16, w.color, 0.6, 2.5, 1)
          if (w.kind === 'portal') {
            this.fx.ring(w.to, 2.2, w.color, 0.5, 0.15)
            this.fx.sparkles(w.to, 18, w.color, 0.6, 2.5, 1)
          }
        }
        if (a.isPlayer || (!hidden && d2(a.pos, this.focusActor().pos) < 14)) w.kind === 'portal' ? sfx.blink() : sfx.dash()
        return
      }
      case 'end':
        this.showResult(ev.w, ev.c, ev.time)
        return
    }
  }

  // ───────────────────────── 網路同步 ─────────────────────────
  // 房主或單機：負責判定；加入者只顯示房主的結果
  get authority() {
    return !this.net || this.net.host
  }

  // 多人連線時的玩家名稱：暱稱，沒填則為「玩家N」
  private playerName(slot: Slot) {
    const net = this.net!
    return net.names.get(slot) || t('playerN', { n: net.numbers.get(slot) ?? 0 })
  }

  actorOf(slot: Slot): Actor {
    return slot === 'elf' ? this.elf : this.goblins[slot]
  }

  private onNet(from: string, m: { t: string }) {
    const net = this.net!
    if (net.host) {
      const slot = net.peers.get(from)
      if (slot === undefined) return
      if (m.t === 'in') this.applyInput(this.actorOf(slot), m as unknown as { p: number[]; c: number })
      else if (m.t === 'act') {
        const a = m as unknown as { a: Act; d?: V2 }
        this.perform(slot, a.a, a.d)
      }
    } else if (m.t === 's') this.applySnapshot(m as Snapshot)
    else if (m.t === 'roster') {
      const l = (m as unknown as { l: unknown }).l
      if (Array.isArray(l)) this.applyRoster(l.filter((x): x is Roster[number] => Array.isArray(x) && this.validSlot(x[0]) && typeof x[1] === 'string' && Number.isFinite(x[2])))
    }
    else if (m.t === 'ev') for (const ev of (m as unknown as { l: GameEvent[] }).l) this.present(ev)
  }

  // 房主：真人玩家回報的位置（移動由各自的瀏覽器計算，手感才不會有延遲）
  private applyInput(a: Actor, m: { p: number[]; c: number }) {
    const p = m.p
    if (!a.netDriven || !Array.isArray(p) || p.length < 5 || !p.every(Number.isFinite)) return
    // 被控制住、或房主剛強制移動過但對方還沒收到時，忽略回報
    const locked = a === this.elf ? this.elf.busy : (a as Goblin).disabled
    if (locked || m.c !== a.corr || this.hud.phase !== 'play') return
    // 防瞬移：位移額度每秒累積「最高速度 × 1.25」公尺（上限 IN_BUDGET_CAP，吸收網路延遲造成的封包堆積），
    // 每次回報的位移扣額度，超過的部分截掉。正常玩家用不完額度；改過的客戶端最多只能以 1.25 倍速移動。
    // 每位玩家開局（或重新連線）後的第一筆回報直接採用：加入者的出生點是在自己那端決定的，和房主這邊不同
    const max = this.maxSpeedOf(a)
    const b = this.inBudget.get(a)
    if (!b) {
      this.inBudget.set(a, { budget: IN_BUDGET_CAP, at: this.elapsed })
      a.pos.set(p[0], 0, p[1])
    } else {
      b.budget = Math.min(IN_BUDGET_CAP, b.budget + (this.elapsed - b.at) * max * 1.25)
      b.at = this.elapsed
      v1.set(p[0] - a.pos.x, 0, p[1] - a.pos.z)
      const d = v1.length()
      if (d <= b.budget) {
        b.budget -= d
        a.pos.set(p[0], 0, p[1])
      } else {
        a.pos.addScaledVector(v1, b.budget / d)
        b.budget = 0
      }
    }
    this.world.resolve(a.pos, a.radius)
    a.yaw = p[2]
    // 速度只用來預測與內插；限制在合法的最高速度內（精靈以衝鋒計），避免灌入極大值讓其他玩家畫面上的角色亂飛
    const vmax = (a === this.elf ? Math.max(CONFIG.elf.speed, CONFIG.violin.charge.speed) : this.maxSpeedOf(a)) * 1.3
    a.vel.set(p[3], 0, p[4])
    // 只在超過時才縮放（clampLength 即使沒超過也會除再乘，產生浮點誤差）
    if (a.vel.lengthSq() > vmax * vmax) a.vel.setLength(vmax)
  }

  // 該角色可能的最高移動速度（哥布林以衝刺計；精靈的衝鋒期間不採用回報的位置，見 applyInput 的 locked）
  private maxSpeedOf(a: Actor) {
    return a === this.elf ? CONFIG.elf.speed : CONFIG.goblin.speed * CONFIG.goblin.dashMultiplier
  }

  // 房主：玩家離線後改由 AI 接手
  private onPeerLeave(peer: string) {
    const net = this.net!
    const slot = net.peers.get(peer)
    if (slot === undefined) return
    net.peers.delete(peer)
    const a = this.actorOf(slot)
    this.inBudget.delete(a)
    a.netDriven = false
    a.net = null
    this.emit({ e: 'left', name: this.playerName(slot) })
    net.names.delete(slot)
    net.numbers.delete(slot)
    this.syncRoster()
  }

  // 房主：斷線的玩家用房號連回來。精靈只還給原本的精靈（斷線期間由 AI 接手）；
  // 哥布林可接手任一隻沒有真人操作的哥布林，優先原本那隻、其次還沒被抓的
  private onPeerRejoin(peer: string, prev: Slot, name: string, n: number): Slot | null {
    const net = this.net!
    if (this.hud.phase === 'over') return null
    const taken = new Set<Slot>([this.me, ...net.peers.values()])
    let slot: Slot | undefined
    if (prev === 'elf') slot = taken.has('elf') ? undefined : 'elf'
    else {
      const rank = (g: Goblin) => (g.captured ? 2 : 0) + (g.id === prev ? 0 : 1)
      slot = this.goblins.filter((g) => !taken.has(g.id)).sort((a, b) => rank(a) - rank(b))[0]?.id
    }
    if (slot === undefined) return null
    net.peers.set(peer, slot)
    net.names.set(slot, name)
    net.numbers.set(slot, n)
    const a = this.actorOf(slot)
    a.netDriven = true
    a.net = null
    // 讓重新連線的玩家以房主這邊的位置為準
    a.corr++
    this.syncRoster()
    return slot
  }

  private validSlot(v: unknown): v is Slot {
    return v === 'elf' || (Number.isInteger(v) && (v as number) >= 0 && (v as number) < this.goblins.length)
  }

  // 房主：玩家離開 / 回來後，把目前的真人玩家名單同步給所有人
  private syncRoster() {
    const net = this.net!
    const l: Roster = [...net.numbers.keys()].map((slot) => [slot, net.names.get(slot) ?? '', net.numbers.get(slot) ?? 0])
    net.send({ t: 'roster', l }, true)
    this.applyRoster(l)
  }

  // 依真人玩家名單更新名稱與頭上的暱稱（自己用金色）；只有文字、沒有底框
  private applyRoster(list: Roster) {
    for (const tag of this.tags.values()) {
      tag.removeFromParent()
      tag.material.map?.dispose()
      tag.material.dispose()
    }
    this.tags.clear()
    this.goblins.forEach((g, i) => (g.name = g.isPlayer ? t('you') : this.defaultNames[i]))
    for (const [slot, nick, n] of list) {
      const name = nick || t('playerN', { n })
      if (slot !== 'elf' && slot !== this.me) this.goblins[slot].name = name
      const tag = makeSprite(name, 0.32, { w: 384, h: 96, font: 54, shadow: true, fg: slot === this.me ? '#ffd23f' : '#ffffff' })
      tag.position.y = slot === 'elf' ? 2.5 : 2.45
      this.actorOf(slot).root.add(tag)
      this.tags.set(slot, tag)
    }
  }

  private snapshot(): Snapshot {
    const e = this.elf
    const p = e.packing
    const rg = e.ranger
    return {
      t: 's',
      q: ++this.seq,
      ph: PHASES.indexOf(this.hud.phase),
      cd: r2(this.countdown),
      el: r2(this.elapsed),
      du: this.duration,
      pk: this.packId,
      e: [
        r2(e.pos.x), r2(e.pos.z), r2(e.yaw), r2(e.vel.x), r2(e.vel.z),
        r2(e.cd.gaze), r2(e.cd.music), r2(e.cd.stun), r2(e.cd.capture),
        r2(e.channel), r2(e.stagger), r2(e.castT), Math.max(0, CAST_POSES.indexOf(e.castPose)),
        p ? p.g.id : -1, p ? r2(p.t) : 0, p ? p.total : 0, e.corr,
        // 17~24：紫晶精靈
        r2(e.cd.stealth), r2(e.cd.eye), r2(e.cd.charge), r2(e.stealthCast), r2(e.stealth), r2(e.eye),
        e.charge ? CHARGE_PHASES.indexOf(e.charge.phase) : -1, e.charge ? r2(e.charge.t) : 0,
        // 25~31：遊俠精靈（其他精靈不送）
        ...(rg ? [rg.charges, r2(rg.recharge), r2(rg.cd.arrow), r2(rg.cd.leap), rg.draw ? r2(rg.draw.t) : -1, r2(rg.plant), rg.leap ? r2(rg.leap.t) : -1] : []),
      ],
      g: this.goblins.map((g) => [
        r2(g.pos.x), r2(g.pos.z), r2(g.yaw), r2(g.vel.x), r2(g.vel.z),
        (g.captured ? 1 : 0) | (g.held ? 2 : 0) | (g.ultUsed ? 4 : 0),
        r2(g.stun), r2(g.rooted), r2(g.attract), r2(g.charm), r2(g.grace), r2(g.dashT), r2(g.dashCd), r2(g.interfereCd), g.corr,
        r2(g.terror),
        // 16~19：遊俠精靈的受困 / 標記 / 減速 / 小地圖顯示
        ...(rg ? [r2(g.snare), r2(g.mark), r2(g.slow), r2(g.reveal)] : []),
      ]),
      ...(rg ? { tr: rg.traps.map((x) => [x.id, r2(x.pos.x), r2(x.pos.z), r2(x.arm), r2(x.life)]) } : {}),
    }
  }

  // 加入者：套用房主快照（無序通道，舊的直接丟棄）
  private applySnapshot(m: Snapshot) {
    this.gotSnapshot()
    if (m.q <= this.lastSeq) return
    this.lastSeq = m.q
    if (PHASES[m.ph] === 'play' && this.hud.phase === 'countdown') this.present({ e: 'go' })
    if (this.hud.phase !== 'over') {
      this.countdown = m.cd
      this.duration = m.du
      if (Math.abs(this.elapsed - m.el) > 0.25) this.elapsed = m.el
    }
    this.packId = m.pk
    const elf = this.elf
    const E = m.e
    elf.cd.gaze = E[5]
    elf.cd.music = E[6]
    elf.cd.stun = E[7]
    elf.cd.capture = E[8]
    if (E[9] >= 0 !== elf.channel >= 0) elf.model.setHarp?.(E[9] >= 0)
    elf.channel = E[9]
    elf.stagger = E[10]
    elf.castT = E[11]
    elf.castPose = CAST_POSES[E[12]] ?? 'normal'
    elf.packing = E[13] >= 0 && this.goblins[E[13]] ? { g: this.goblins[E[13]], t: E[14], total: E[15] } : null
    if (E.length > 24) {
      elf.cd.stealth = E[17]
      elf.cd.eye = E[18]
      elf.cd.charge = E[19]
      elf.stealthCast = E[20]
      elf.stealth = E[21]
      elf.eye = E[22]
      // 衝鋒由事件驅動（本機預測移動）；房主已經結束、本機卻還在衝鋒時（漏掉事件）才清掉
      if (E[23] < 0 && elf.charge && elf.charge.phase !== 'windup' && elf.charge.t > STALE_CHARGE) elf.cancelCharge()
    }
    const rg = elf.ranger
    if (rg && E.length > 31) {
      rg.charges = E[25]
      rg.recharge = E[26]
      rg.cd.arrow = E[27]
      rg.cd.leap = E[28]
      // 吹笛 / 後躍由事件驅動；房主已經結束、本機卻還停著（漏掉事件）才清掉
      if (E[29] < 0 && rg.draw && rg.draw.t > CONFIG.ranger.arrow.draw / CONFIG.ranger.pressureRate + STALE_RANGER) rg.draw = null
      if (E[30] < 0 && rg.plant > CONFIG.ranger.trap.castTime + STALE_RANGER) rg.plant = -1
      if (E[31] < 0 && rg.leap && rg.leap.t > CONFIG.ranger.leap.time + STALE_RANGER) rg.leap = null
      if (Array.isArray(m.tr)) {
        const old = new Map(rg.traps.map((x) => [x.id, x]))
        rg.traps = m.tr.filter((x) => Array.isArray(x) && x.every(Number.isFinite)).map((x) => {
          const tr = old.get(x[0]) ?? { id: x[0], pos: new THREE.Vector3(x[1], 0, x[2]), arm: x[3], life: x[4], region: this.world.regionOf(v1.set(x[1], 0, x[2])) }
          tr.arm = x[3]
          tr.life = x[4]
          return tr
        })
      }
    }
    // 衝鋒中的精靈玩家（加入者）由本機預測位置，結束時房主會 corr++ 讓位置一致
    this.follow(elf, E, E[16], elf.busy && !elf.charge && !rg?.leap)
    m.g.forEach((G, i) => {
      const g = this.goblins[i]
      if (!g) return
      g.syncLife(!!(G[5] & 1), !!(G[5] & 2))
      g.ultUsed = !!(G[5] & 4)
      ;[g.stun, g.rooted, g.attract, g.charm, g.grace, g.dashT, g.dashCd, g.interfereCd] = G.slice(6, 14)
      g.terror = G[15] ?? 0
      if (rg) [g.snare, g.mark, g.slow, g.reveal] = [G[16] ?? 0, G[17] ?? 0, G[18] ?? 0, G[19] ?? 0]
      if (g.captured) {
        g.zone = -2
        g.net = null
        g.pos.set(G[0], 0, G[1])
        g.corr = G[14]
      } else this.follow(g, G, G[14], g.disabled)
    })
  }

  private follow(a: Actor, s: number[], corr: number, locked: boolean) {
    if (a.isPlayer) {
      // 自己的位置由本機計算；被控制住、或被房主強制移動（掙脫推開等）時以房主為準
      if (locked || corr !== a.corr) {
        a.pos.set(s[0], 0, s[1])
        if (locked) a.vel.set(0, 0, 0)
        a.corr = corr
      }
      return
    }
    if (a.net) Object.assign(a.net, { x: s[0], z: s[1], yaw: s[2], t: 0 })
    else {
      a.net = { x: s[0], z: s[1], yaw: s[2], t: 0 }
      a.pos.set(s[0], 0, s[1])
      a.yaw = s[2]
    }
    a.vel.set(s[3], 0, s[4])
  }

  // 網路驅動的角色：平滑地追上最新位置，並依速度短暫推算（快照之間）
  private netFollow(a: Actor, dt: number, base: number) {
    const n = a.net
    if (n) {
      n.t += dt
      if (n.t < 0.25) {
        n.x += a.vel.x * dt
        n.z += a.vel.z * dt
      }
      const dx = n.x - a.pos.x, dz = n.z - a.pos.z
      if (dx * dx + dz * dz > 36) a.pos.set(n.x, 0, n.z)
      else {
        const k = Math.min(1, dt * 10)
        a.pos.x += dx * k
        a.pos.z += dz * k
      }
      const dy = Math.atan2(Math.sin(n.yaw - a.yaw), Math.cos(n.yaw - a.yaw))
      a.yaw += dy * Math.min(1, dt * 10)
    }
    a.moveAmt = Math.min(1.3, a.vel.length() / base)
  }

  private netSync(dt: number) {
    const net = this.net!
    if (net.host && this.evQueue.length) {
      net.send({ t: 'ev', l: this.evQueue }, true)
      this.evQueue = []
    }
    this.netT -= dt
    if (this.netT > 0) return
    this.netT = net.host ? 1 / 15 : 1 / 20
    if (net.host) {
      net.send(this.snapshot(), false)
      return
    }
    const a = this.actorOf(this.me)
    if (a instanceof Goblin && a.captured) return
    net.send({ t: 'in', p: [r2(a.pos.x), r2(a.pos.z), r2(a.yaw), r2(a.vel.x), r2(a.vel.z)], c: a.corr }, false)
  }

  // ───────────────────────── 導航 ─────────────────────────
  navigate(a: Actor, target: THREE.Vector3, avoid?: THREE.Vector3): THREE.Vector3 {
    a.routeWarp = -1
    const wp = this.waypoint(a.pos, target, avoid, a)
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

  private waypoint(pos: THREE.Vector3, target: THREE.Vector3, avoid?: THREE.Vector3, actor?: Actor): THREE.Vector3 {
    const world = this.world
    // 不同區域（地面 / 各個台地）：先走向路線上的第一個傳送門 / 彈跳蘑菇
    if (world.warps.length) {
      const rA = world.regionOf(pos)
      const rT = world.regionOf(target)
      if (rA !== rT) {
        const w = world.route(pos, rA, target, rT, avoid)
        if (w) {
          target = w.from
          if (actor) actor.routeWarp = w.id
        }
      }
    }
    // 山洞的洞口導航只用在真的山洞（台地沒有洞口，在同一個區域裡直線就到得了）
    const cave = (z: number) => (z >= 0 && world.caves[z].kind === 'cave' ? z : -1)
    const zA = cave(world.zoneOf(pos))
    const zT = cave(world.zoneOf(target))
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
    for (const c of this.obstacles(pos)) {
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

  // 繞行時要避開的大型障礙：山洞；在地面上時還有台地的崖壁
  private obstacles(pos: THREE.Vector3): { id: number; center: THREE.Vector3; radius: number }[] {
    const caves = this.world.caves
    if (!this.world.plateaus.length) return caves
    const out: { id: number; center: THREE.Vector3; radius: number }[] = caves.filter((c) => c.kind === 'cave')
    if (this.world.regionOf(pos) === 0) for (const p of this.world.plateaus) out.push({ id: -10 - p.region, center: p.center, radius: p.radius })
    return out
  }

  // 是否在同一個區域（地面 / 同一座台地）：琴聲、恐懼等範圍效果不會跨過崖壁
  sameRegion(a: Actor, b: Actor) {
    return !this.world.plateaus.length || this.world.regionOf(a.pos) === this.world.regionOf(b.pos)
  }

  // ───────────────────────── 傳送門 / 彈跳蘑菇（房主 / 單機判定）─────────────────────────
  private checkWarps(dt: number) {
    const elf = this.elf
    const actors: [Actor, Slot][] = [[elf, 'elf'], ...this.goblins.map((g) => [g, g.id] as [Actor, Slot])]
    for (const [a, slot] of actors) {
      a.warpCd = Math.max(0, a.warpCd - dt)
      if (a.warpCd > 0) continue
      // 打包、彈奏、拉琴、衝鋒中的精靈，被打包 / 已捕獲 / 暈眩定身的哥布林不會被傳送
      if (a === elf ? elf.busy : (a as Goblin).captured || (a as Goblin).held || (a as Goblin).stun > 0 || (a as Goblin).rooted > 0 || (a as Goblin).snare > 0) continue
      const w = this.warpAt(a.pos)
      // 真人玩家走進去就傳送；AI 只走進自己路線上的傳送點
      if (w && (a.isPlayer || a.netDriven || a.routeWarp === w.id)) this.warp(a, slot, w)
    }
  }

  private warpAt(p: THREE.Vector3): Warp | null {
    const r = this.world.regionOf(p)
    for (const w of this.world.warps) if (w.region === r && d2(p, w.from) < w.radius) return w
    return null
  }

  private warp(a: Actor, slot: Slot, w: Warp) {
    a.pos.set(w.to.x, 0, w.to.z)
    this.world.resolve(a.pos, a.radius)
    a.warpCd = 0.6
    // 彈跳蘑菇：飛行的那一下哥布林抓不到（與畫面上的拋物線一致）
    if (w.kind === 'bounce' && a instanceof Goblin) a.grace = Math.max(a.grace, HOP_TIME)
    a.corr++
    this.emit({ e: 'warp', s: slot, w: w.id })
  }

  // 角色模型的位置：地面高度＋彈跳蘑菇的拋物線（純畫面效果，遊戲邏輯已經在落點）
  private placeRoot(a: Actor, dt: number) {
    const hop = a.hop
    if (hop) {
      hop.t += dt
      const k = Math.min(1, hop.t / hop.dur)
      a.root.position.set(hop.from.x + (a.pos.x - hop.from.x) * k, 0, hop.from.z + (a.pos.z - hop.from.z) * k)
      a.root.position.y = hop.from.y + (groundAt(a.pos.x, a.pos.z) - hop.from.y) * k + Math.sin(k * Math.PI) * hop.peak
      if (k >= 1) a.hop = null
      return
    }
    a.root.position.set(a.pos.x, groundAt(a.pos.x, a.pos.z), a.pos.z)
  }

  // ───────────────────────── 主迴圈 ─────────────────────────
  private tick(rawDt: number, render = true) {
    // 多人連線時 rawDt 可能長達 1 秒（背景分頁），切成 ≤0.05 秒的小步模擬
    const sub = Math.max(1, Math.ceil(rawDt / 0.05 - 1e-6))
    const steps = this.speed * sub
    for (let i = 0; i < steps; i++) this.update(rawDt / sub)
    if (this.net) this.netSync(rawDt)
    if (!render) return
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
    const auth = this.authority
    this.world.simTime = this.elapsed
    this.musicStopT -= dt
    if (hud.phase === 'countdown') {
      this.countdown -= dt
      const c = Math.ceil(this.countdown)
      if (c !== this.lastCount) {
        this.lastCount = c
        if (c > 0) sfx.tick()
      }
      if (this.countdown <= 0 && auth) this.emit({ e: 'go' })
    } else if (hud.phase === 'play') {
      this.elapsed += dt
      const left = this.duration - this.elapsed
      for (const mark of [300, 120, 60]) {
        if (left < mark && !this.warned.has(mark) && this.duration > mark) {
          this.warned.add(mark)
          // 最終狩獵開始的那一刻改成最終狩獵的提示
          if (mark !== CONFIG.finalHunt) this.toast(t('tMinutesLeft', { n: mark / 60 }), 'warn')
        }
      }
      if (CONFIG.finalHunt > 0 && left <= CONFIG.finalHunt && !this.warned.has(-1)) {
        this.warned.add(-1)
        this.toast(this.role === 'elf' ? t('tFinalHuntElf') : t('tFinalHuntGoblin'), 'warn')
      }
      if (left <= 0 && auth) {
        this.finish('goblin')
        return
      }
    }

    const playing = hud.phase === 'play'
    const elf = this.elf

    // 狀態計時
    for (const k of ['gaze', 'music', 'stun', 'capture', 'stealth', 'eye', 'charge'] as const) elf.cd[k] = Math.max(0, elf.cd[k] - dt)
    elf.stagger = Math.max(0, elf.stagger - dt)
    elf.castT = Math.max(0, elf.castT - dt)
    elf.blinkLock = Math.max(0, elf.blinkLock - dt)
    for (const g of this.goblins) {
      if (!g.held) g.stun = Math.max(0, g.stun - dt)
      g.rooted = Math.max(0, g.rooted - dt)
      g.terror = Math.max(0, g.terror - dt)
      if (!g.held) g.snare = Math.max(0, g.snare - dt)
      g.mark = Math.max(0, g.mark - dt)
      g.slow = Math.max(0, g.slow - dt)
      g.reveal = Math.max(0, g.reveal - dt)
      g.attract = Math.max(0, g.attract - dt)
      g.charm = Math.max(0, g.charm - dt)
      g.grace = Math.max(0, g.grace - dt)
      g.dashT = Math.max(0, g.dashT - dt)
      g.dashCd = Math.max(0, g.dashCd - dt)
      g.interfereCd = Math.max(0, g.interfereCd - dt)
      if (g.packSavedT > 0 && !g.held && (g.packSavedT -= dt) <= 0) g.packSaved = g.packSavedT = 0
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
      if (auth)
        for (const g of this.goblins) {
          if (g.captured || g.held) continue
          // 已被吸引、仍在範圍內：彈奏中持續刷新，「不能攪局」的 attractTime 秒從彈奏結束才開始算
          // （否則彈奏本身就把時間耗掉，彈完擊暈＋打包時早已能攪局，琴聲對抱團無效）
          if (elf.musicAffected.has(g)) {
            if (g.attract > 0 && d2(g.pos, elf.pos) < M.radius) g.attract = M.attractTime
            continue
          }
          if (d2(g.pos, elf.pos) < M.radius && this.sameRegion(g, elf)) {
            elf.musicAffected.add(g)
            g.attract = M.attractTime
            g.charm = M.charmTime
            if (g.isPlayer || g.netDriven) this.emit({ e: 'charm', g: g.id })
          }
        }
      if (Math.floor(elf.channel / 1.2) !== Math.floor((elf.channel - dt) / 1.2)) this.fx.ring(elf.pos, M.radius, 0xffe9a0, 1.4, 0.05)
      this.elfFx.musicTick(dt, elf.pos, M.radius)
      if (elf.channel >= M.maxChannel) this.elfStopMusic()
    }

    // 紫晶精靈：拉琴準備隱身 → 隱身 → 自然現身；刺客之眼計時；衝鋒
    if (elf.kind === 'violin' && hud.phase === 'play') {
      const V = CONFIG.violin
      if (elf.stealthCast >= 0) {
        elf.stealthCast += dt
        this.violinNoteT -= dt
        if (this.violinNoteT <= 0) {
          this.violinNoteT = 0.2
          sfx.violinNote(elf.musicNote++)
        }
        this.violinFx.castTick(dt, elf.pos, Math.min(1, elf.stealthCast / V.stealth.castTime))
        if (elf.stealthCast >= V.stealth.castTime && auth) {
          elf.enterStealth()
          this.emit({ e: 'stealth', on: true, p: [r2(elf.pos.x), r2(elf.pos.z)], fear: [] })
        }
      }
      if (elf.stealth > 0) {
        // 時間到自然現身（不嚇人）；breakStealth 要在隱身狀態下呼叫，所以先判斷再扣時間
        if (elf.stealth - dt <= 0 && auth) this.breakStealth(false)
        else elf.stealth = Math.max(0, elf.stealth - dt)
      }
      if (elf.eye > 0) {
        elf.eye = Math.max(0, elf.eye - dt)
        if (elf.eye <= 0 && auth) {
          elf.closeEye()
          this.emit({ e: 'eye', on: false })
        }
      }
      if (elf.charge) this.updateCharge(dt)
    }

    if (elf.ranger && hud.phase === 'play') this.updateRanger(dt)

    // 打包（遊俠＝收網：哥布林維持受困，貼身干擾時進度走得慢）
    if (elf.packing) {
      const p = elf.packing
      const step = dt * this.rangerRate()
      p.t += step
      if (elf.ranger) {
        p.g.snare = Math.max(p.g.snare, 0.2)
        // 收網：把哥布林拖向精靈（房主判定；被拖的玩家以房主位置為準）
        const P = CONFIG.ranger.reel
        const d = d2(p.g.pos, elf.pos)
        if (auth && P.pull > 0 && d > P.pullTo) {
          v2.subVectors(elf.pos, p.g.pos).setY(0).normalize()
          p.g.pos.addScaledVector(v2, Math.min(P.pull * step, d - P.pullTo))
          this.world.resolve(p.g.pos, p.g.radius)
        }
      } else p.g.stun = Math.max(p.g.stun, 0.2)
      if (Math.floor(p.t * 4) !== Math.floor((p.t - step) * 4)) elf.ranger ? sfx.fluteNote(elf.musicNote++, 0.22) : sfx.pack()
      if (p.t >= p.total && auth) this.completeCapture()
    }
    if (hud.phase === 'over') {
      // 結算畫面時精靈仍要動（勝利動作）
      elf.model.animate(dt, 0, 'normal')
      this.elfFx.update(dt)
      return
    }

    // 操控 / AI
    if (playing) {
      if (elf.isPlayer) {
        if (!elf.busy) this.readMove(elf.wish)
        else {
          // 彈奏中移動 = 解除（加入者送請求給房主，避免連續重送）
          if (elf.channel >= 0 && this.readMove(v2).lengthSq() > 0.1 && this.musicStopT <= 0) {
            this.musicStopT = 0.3
            this.act('musicStop')
          }
          elf.wish.set(0, 0, 0)
        }
      } else if (elf.netDriven) {
        /* 由網路驅動 */
      } else if (this.elapsed > 6) updateElfAI(this, dt)
      else elf.wish.set(0, 0, 0)

      for (const g of this.goblins) {
        if (g.captured) continue
        if (g.isPlayer) this.readMove(g.wish)
        else if (!g.netDriven && this.elapsed > 0.5) updateGoblinAI(this, g, dt)
      }
    }

    // 移動
    const elfSpeed = elf.isPlayer || elf.netDriven ? CONFIG.elf.speed : elf.kind === 'violin' ? CONFIG.violin.aiSpeed : elf.kind === 'ranger' ? CONFIG.ranger.aiSpeed : CONFIG.elf.aiSpeed
    if (elf.charge && (auth || elf.isPlayer)) {
      // 衝鋒的位移在 updateCharge 處理
      elf.wish.set(0, 0, 0)
      elf.moveAmt = elf.charge.phase === 'dash' ? 1.3 : 0
    } else if (elf.ranger?.leap && (auth || elf.isPlayer)) {
      // 後躍的位移在 updateRanger 處理
      elf.wish.set(0, 0, 0)
      elf.moveAmt = 0
    } else if (elf.netDriven) this.netFollow(elf, dt, elfSpeed)
    else {
      if (elf.busy) elf.wish.set(0, 0, 0)
      this.moveActor(elf, elfSpeed * (elf.castT > 0 ? 0.35 : 1), dt, elfSpeed)
    }
    for (const g of this.goblins) {
      if (g.captured) continue
      // 恐懼中的真人哥布林由房主移動（操控者端以房主位置為準）
      if (g.netDriven && !(auth && g.terror > 0 && !g.held && g.stun <= 0 && g.rooted <= 0)) {
        this.netFollow(g, dt, CONFIG.goblin.speed)
        continue
      }
      let sp = CONFIG.goblin.speed
      if (g.held || g.stun > 0 || g.rooted > 0 || g.snare > 0) g.wish.set(0, 0, 0)
      else if (g.terror > 0) {
        // 恐懼：不受控制，緩慢遠離精靈
        v2.subVectors(g.pos, elf.pos).setY(0)
        if (v2.lengthSq() < 1e-4) v2.set(Math.sin(g.yaw), 0, Math.cos(g.yaw))
        v2.normalize().multiplyScalar(6).add(g.pos)
        g.wish.copy(this.navigate(g, v2))
        sp *= CONFIG.violin.stealth.fearSpeed
      } else if (g.attract > 0) {
        const dd = d2(g.pos, elf.pos)
        if (dd > 2.2) g.wish.copy(this.navigate(g, elf.pos))
        else g.wish.set(0, 0, 0)
        sp *= 0.6
      } else if (g.dashT > 0) sp *= CONFIG.goblin.dashMultiplier
      // 遊俠的箭：近距離命中的減速；被標記時腳上纏著藤蔓，也會慢一點
      if (g.slow > 0) sp *= CONFIG.ranger.arrow.slow
      else if (g.mark > 0) sp *= CONFIG.ranger.arrow.markSlow
      this.moveActor(g, sp, dt, CONFIG.goblin.speed)
    }
    this.separate()
    if (auth && playing && this.world.warps.length) this.checkWarps(dt)

    // 姿勢與動畫
    elf.pose = elf.stagger > 0 ? 'stunned' : ELF_ACTION_POSE[elf.action] ?? (elf.castT > 0 ? elf.castPose : 'normal')
    this.placeRoot(elf, dt)
    elf.root.rotation.y = elf.yaw
    // 隱身：哥布林（含觀戰中）看不見；精靈玩家自己看到半透明
    const viewerIsElf = this.me === 'elf'
    const hidden = elf.stealthed && !viewerIsElf
    elf.character.setOpacity(hidden ? 0 : elf.stealthed ? GHOST_OPACITY : 1)
    elf.model.animate(dt, elf.moveAmt, elf.pose)
    this.staff.update(dt, elf.channel >= 0, elf.pos)
    if (elf.kind === 'violin') {
      if (!hidden) {
        for (let k = 0; k < this.fx.rate('elftrail', elf.stealthed ? 0 : 1 + elf.moveAmt * 8, dt); k++) this.fx.trail(elf.pos, Math.random() < 0.6 ? 0xd8b8ff : 0xffc8f0, 0.2 + Math.random() * 1.4)
        this.violinFx.ghostTick(dt, elf.pos, elf.stealthed ? elf.moveAmt : elf.moveAmt * 0.3)
      }
    } else if (elf.ranger) this.updateRangerFx(dt)
    else {
      for (let k = 0; k < this.fx.rate('elftrail', 2 + elf.moveAmt * 14, dt); k++) this.fx.trail(elf.pos, Math.random() < 0.6 ? 0xfff0b0 : 0xc8f0ff, 0.2 + Math.random() * 1.4)
      this.elfFx.ambient(dt, elf.pos, elf.moveAmt)
    }
    this.elfFx.update(dt)
    this.violinFx.update(dt)
    this.rangerFx.update(dt)
    this.updateXray(viewerIsElf && elf.eye > 0)
    if (elf.packing) for (let k = 0; k < this.fx.rate('pack', 10, dt); k++) this.fx.dust(elf.packing.g.pos.x, elf.packing.g.pos.z, 1, 0.5, 0xc8a870)
    elf.fx.stunned.visible = elf.stagger > 0
    const eb = elf.fx.bar
    eb.group.visible = !!elf.packing || elf.channel >= 0
    if (elf.packing) setBarProgress(eb, elf.packing.t / elf.packing.total)
    else if (elf.channel >= 0) setBarProgress(eb, 1 - elf.channel / CONFIG.elf.music.maxChannel)

    for (const g of this.goblins) {
      g.pose = g.captured || g.held ? 'held' : g.stun > 0 ? 'stunned' : g.snare > 0 ? 'snared' : g.rooted > 0 ? 'rooted' : 'normal'
      this.placeRoot(g, dt)
      g.root.rotation.y = g.yaw
      const dElf = d2(g.pos, elf.pos)
      // 操控的哥布林察覺精靈時會露出害怕的樣子；隱身中的精靈察覺不到（不能透過動作洩漏位置）
      const scared = g.terror > 0 || (g.isPlayer ? !elf.stealthed && ((g.zone >= 0 && g.zone === elf.zone) || dElf < 7) : g.ai.fear > 0 && dElf < 12)
      g.model.animate(dt, g.moveAmt, g.pose, { scared, dash: g.dashT > 0 })
      if (g.flight) {
        // 麻袋飛向牢籠
        const fl = g.flight
        fl.t += dt
        const k = Math.min(1, fl.t / fl.dur)
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
        g.root.position.lerpVectors(fl.from, fl.to, e)
        const arc = Math.sin(k * Math.PI) * (6 + fl.from.distanceTo(fl.to) * 0.15)
        g.root.position.y = arc + groundAt(fl.from.x, fl.from.z) * (1 - e) + groundAt(fl.to.x, fl.to.z) * e
        g.yaw += dt * 8
        // 特效的座標以地面為 0（見 ground.ts），扣掉麻袋所在位置的地面高度
        this.fx.trail(v2.copy(g.root.position).setY(g.root.position.y - groundAt(g.root.position.x, g.root.position.z)), 0xffe6a0, 0.5)
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
        if (g.terror > 0) for (let k = 0; k < f.rate(`fe${g.id}`, 4, dt); k++) this.violinFx.fearNote(g.pos)
        if (g.snare > 0 || (g.held && elf.ranger)) for (let k = 0; k < f.rate(`sn${g.id}`, 9, dt); k++) this.rangerFx.snareLeaf(g.pos)
        if (g.mark > 0) for (let k = 0; k < f.rate(`mk${g.id}`, 7, dt); k++) this.rangerFx.markMote(g.pos)
        if (g.slow > 0) for (let k = 0; k < f.rate(`sl2${g.id}`, 6, dt); k++) f.trail(g.pos, 0xbfe8ff, 0.3)
      }
      // 刺客之眼：操控這隻哥布林的玩家頭上跳警告
      g.fx.eyeWarn.visible = g.isPlayer && !g.captured && elf.eye > 0
      if (g.fx.eyeWarn.visible) g.fx.eyeWarn.position.y = 2.55 + Math.abs(Math.sin(this.elapsed * 4)) * 0.1
      g.fx.bar.group.visible = g.held && !!elf.packing
      if (elf.packing && elf.packing.g === g) setBarProgress(g.fx.bar, elf.packing.t / elf.packing.total)
    }

    // 雷達提示音（文字只用 HUD 上方的雷達橫幅，不再另跳 toast / 頭頂字牌，避免同一句話疊三次）
    const radarNow = !!this.playerGoblin && !this.playerGoblin.captured && !elf.stealthed && this.playerGoblin.zone >= 0 && this.playerGoblin.zone === elf.zone
    if (radarNow && !this.radarWas) {
      sfx.alarm()
    }
    this.radarWas = radarNow

    // 洞內變暗、太陽陰影跟隨
    const focus = this.focusActor()
    const zone = this.world.zoneOf(focus.pos)
    const inCave = zone >= 0 && this.world.caves[zone].kind === 'cave'
    const k = Math.min(1, dt * 2)
    const theme = this.world.theme
    this.hemi.intensity += ((inCave ? theme.hemiCave : theme.hemi) - this.hemi.intensity) * k
    this.sun.intensity += ((inCave ? theme.sunCave : theme.sun) - this.sun.intensity) * k
    this.fx.update(dt, focus.pos, inCave)
    this.shake = Math.max(0, this.shake - dt * 1.8)
    const fy = groundAt(focus.pos.x, focus.pos.z)
    this.sun.position.set(focus.pos.x + 30, fy + 60, focus.pos.z + 18)
    this.sun.target.position.set(focus.pos.x, fy, focus.pos.z)
    this.marker.visible = !(this.playerGoblin?.captured ?? false)
    const me = this.playerGoblin ?? this.elf
    this.marker.position.set(me.pos.x, groundAt(me.pos.x, me.pos.z) + 0.06, me.pos.z)
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
    // 網路驅動的角色位置以操控者為準，不被推開（但仍會推開其他角色）
    const fixed = (x: Actor) => x.netDriven || (x === this.elf ? !!(this.elf.packing || this.elf.channel >= 0) : (x as Goblin).held)
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
          if (!fixed(a)) {
            a.pos.x -= nx * push
            a.pos.z -= nz * push
          }
          if (!fixed(b)) {
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
    // 跟著角色畫面上的位置（含台地高度、彈跳蘑菇的拋物線）
    const target = v1.set(focus.root.position.x, focus.root.position.y + h + 0.3, focus.root.position.z)
    if (focus instanceof Goblin && focus.flight) target.set(focus.pos.x, h + 0.3, focus.pos.z)
    const cp = Math.cos(this.camPitch)
    const dir = v2.set(Math.sin(this.camYaw) * cp, Math.sin(this.camPitch) + 0.15, Math.cos(this.camYaw) * cp).normalize()
    let dist = this.camDist
    this.raycaster.set(target, dir)
    this.raycaster.far = dist
    const hit = this.raycaster.intersectObjects(this.world.occluders, false)[0]
    if (hit) dist = Math.max(1.2, hit.distance - 0.4)
    const want = new THREE.Vector3().copy(target).addScaledVector(dir, dist)
    want.y = Math.max(want.y, groundAt(want.x, want.z) + 0.4)
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
  floatText(text: string, pos: THREE.Vector3, color: string, scale = 0.75, rise?: number) {
    this.fx.floatText(text, pos, color, scale, rise)
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
    this.elfStopMusic()
    this.emit({ e: 'end', w: winner, c: this.goblins.filter((g) => g.captured).length, time: r2(this.elapsed) })
  }

  private showResult(winner: Role, captured: number, time: number) {
    if (this.hud.phase === 'over') return
    this.hud.phase = 'over'
    this.elapsed = time
    this.syncGameplay()
    this.elf.model.setHarp?.(false)
    // 結算時精靈一定現身
    this.elf.resetForResult()
    this.rangerFx.ropeOff()
    this.elf.character.setOpacity(1)
    this.updateXray(false)
    for (const g of this.goblins) g.fx.eyeWarn.visible = false
    if (winner === 'elf') this.elf.character.setVictory(true)
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
          : t(CONFIG.goblinCount - captured === 1 ? 'rGoblinDetailOne' : 'rGoblinDetail', { free: CONFIG.goblinCount - captured, n: captured }),
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
    h.eye = this.role === 'elf' && elf.eye > 0
    h.stealth = this.role === 'elf' && elf.stealthed
    if (this.role === 'elf' && elf.kind === 'violin') this.syncVioletHud(h, touch)
    else if (this.role === 'elf' && elf.ranger) this.syncRangerHud(h, touch)
    else if (this.role === 'elf') {
      const E = CONFIG.elf
      const b = this.binds.elf
      const pack = this.packReady()
      h.skills = [
        { key: keyLabel(b.gaze), code: b.gaze, name: t('skillGaze'), icon: 'skill-gaze', cd: elf.cd.gaze, max: E.gaze.cooldown, active: false, usable: !elf.busy },
        { key: keyLabel(b.music), code: b.music, name: elf.channel >= 0 ? t('skillMusicStop') : t('skillMusic'), icon: 'skill-music', cd: elf.cd.music, max: E.music.cooldown, active: elf.channel >= 0, usable: !elf.packing && elf.stagger <= 0 },
        pack
          ? { key: keyLabel(b.stun), code: b.stun, name: t('skillCapture'), icon: 'skill-capture', cd: 0, max: E.capture.cooldown, active: false, usable: !elf.busy }
          : { key: keyLabel(b.stun), code: b.stun, name: t('skillStun'), icon: 'skill-stun', cd: elf.cd.stun, max: E.stun.cooldown, active: false, usable: !elf.busy },
        { key: keyLabel(b.capture), code: b.capture, name: t('skillCapture'), icon: 'skill-capture', cd: elf.cd.capture, max: E.capture.cooldown, active: !!elf.packing, usable: !elf.busy },
      ]
      h.radar = false
      const near = this.goblins.filter((g) => !g.captured && !g.held && d2(g.pos, elf.pos) < E.capture.range)
      if (elf.stagger > 0) h.hint = t('hInterrupted')
      else if (elf.packing) h.hint = ''
      else if (elf.channel >= 0) h.hint = touch ? t('hPlayingTouch') : t('hPlaying', { key: keyLabel(b.music) })
      else if (pack) h.hint = touch ? t('hCaptureTouch') : t('hCapture', { key: keyLabel(b.stun) })
      else if (near.length && elf.cd.stun <= 0) h.hint = touch ? t('hStunTouch') : t('hStun', { key: keyLabel(b.stun) })
      else h.hint = ''
      h.progress = elf.packing ? elf.packing.t / elf.packing.total : -1
      h.progressLabel = elf.packing ? t('hPacking', { name: elf.packing.g.name }) : ''
      h.spectating = ''
    } else {
      const g = this.playerGoblin!
      const G = CONFIG.goblin
      const b = this.binds.goblin
      // 遊俠精靈：攪局鍵＝割斷隊友身上的繩索 / 拆掉身邊的陷阱
      const rg = elf.ranger
      const cut = !!rg && !!elf.packing && elf.packing.g !== g
      const cutNear = cut && d2(g.pos, elf.packing!.g.pos) < CONFIG.ranger.reel.cutRange
      const trapNear = !!rg && !g.captured && !cutNear && rg.traps.some((x) => d2(x.pos, g.pos) < CONFIG.ranger.trap.disarmRange)
      h.skills = [
        { key: keyLabel(b.dash), code: b.dash, name: t('skillDash'), icon: 'skill-dash', cd: g.dashCd, max: G.dashCooldown, active: g.dashT > 0, usable: !g.disabled },
        { key: keyLabel(b.interfere), code: b.interfere, name: cut ? t('skillCut') : trapNear ? t('skillDisarm') : t('skillInterfere'), icon: 'skill-interfere', cd: g.interfereCd, max: G.interfereCooldown, active: false, usable: (trapNear || (!!elf.packing && elf.packing.g !== g)) && g.canInterfere },
        { key: keyLabel(b.ult), code: b.ult, name: t('skillUlt'), icon: 'skill-ult', cd: 0, max: 1, active: false, usable: g.held && !g.ultUsed, used: g.ultUsed },
      ]
      h.radar = !g.captured && !elf.stealthed && g.zone >= 0 && g.zone === elf.zone
      if (g.captured) h.hint = ''
      else if (g.held) h.hint = g.ultUsed ? t('hUltUsed') : touch ? t('hUltTouch') : t('hUlt', { key: keyLabel(b.ult) })
      else if (g.terror > 0) h.hint = t('hFeared')
      else if (g.stun > 0) h.hint = t('hStunned')
      else if (g.snare > 0) h.hint = t('hSnared')
      else if (g.rooted > 0) h.hint = t('hRooted')
      else if (g.attract > 0) h.hint = t('hCharmed')
      else if (cutNear) h.hint = touch ? t('hCutTouch') : t('hCut', { key: keyLabel(b.interfere) })
      else if (cut && d2(g.pos, elf.packing!.g.pos) < 40) h.hint = t('hAllyReeled', { name: elf.packing!.g.name })
      else if (g.mark > 0) h.hint = t('hMarked')
      else if (trapNear) h.hint = touch ? t('hDisarmTouch') : t('hDisarm', { key: keyLabel(b.interfere) })
      else if (rg) h.hint = ''
      else if (elf.packing && d2(g.pos, elf.pos) < G.interfereRange) h.hint = touch ? t('hInterfereTouch') : t('hInterfere', { key: keyLabel(b.interfere) })
      else if (elf.packing && d2(g.pos, elf.pos) < 30) h.hint = t('hAllyPacked', { name: elf.packing.g.name })
      else h.hint = ''
      h.progress = g.held && elf.packing ? elf.packing.t / elf.packing.total : -1
      h.progressLabel = h.progress >= 0 ? t('hYouPacked') : ''
      const f = this.focusActor()
      h.spectating = g.captured ? (f instanceof Goblin ? f.name : t('elf')) : ''
    }
  }

  // 紫晶精靈玩家的技能列與提示
  private syncVioletHud(h: HudState, touch: boolean) {
    const elf = this.elf
    const V = CONFIG.violin
    const b = this.binds.elf
    const free = elf.stagger <= 0 && !elf.packing && !elf.charge
    const pack = this.packReady()
    const packUsable = (free || elf.charge?.phase === 'recover') && elf.stealthCast < 0
    // 瞬移後的鎖定衝鋒時限內（衝鋒已冷卻好）
    const lock = elf.blinkLock > 0 && elf.cd.charge <= 0 && !elf.charge
    h.skills = [
      {
        key: keyLabel(b.gaze), code: b.gaze, name: elf.stealthed ? t('skillUnstealth') : t('skillStealth'), icon: elf.stealthed ? 'skill-reveal' : 'skill-stealth',
        cd: elf.cd.stealth, max: V.stealth.cooldown, active: elf.stealthed || elf.stealthCast >= 0, usable: elf.stealthed || (free && elf.stealthCast < 0),
      },
      {
        key: keyLabel(b.music), code: b.music, name: elf.eye > 0 ? t('skillBlink') : t('skillEye'), icon: elf.eye > 0 ? 'skill-blink' : 'skill-eye',
        cd: elf.cd.eye, max: V.eye.cooldown, active: elf.eye > 0, usable: free && elf.stealthCast < 0,
      },
      pack
        ? { key: keyLabel(b.stun), code: b.stun, name: t('skillCapture'), icon: 'skill-capture', cd: 0, max: CONFIG.elf.capture.cooldown, active: false, usable: packUsable }
        : { key: keyLabel(b.stun), code: b.stun, name: lock ? t('skillChargeLock') : t('skillCharge'), icon: 'skill-charge', cd: elf.cd.charge, max: V.charge.cooldown, active: !!elf.charge || lock, usable: free && elf.stealthCast < 0 },
      { key: keyLabel(b.capture), code: b.capture, name: t('skillCapture'), icon: 'skill-capture', cd: elf.cd.capture, max: CONFIG.elf.capture.cooldown, active: !!elf.packing, usable: packUsable },
    ]
    h.radar = false
    if (elf.stagger > 0) h.hint = t('hInterrupted')
    else if (elf.packing) h.hint = ''
    else if (elf.stealthCast >= 0) h.hint = t('hStealthCast')
    else if (pack) h.hint = touch ? t('hCaptureTouch') : t('hCapture', { key: keyLabel(b.stun) })
    else if (lock && free) h.hint = touch ? t('hChargeLockTouch') : t('hChargeLock', { key: keyLabel(b.stun) })
    else if (elf.eye > 0) h.hint = touch ? t('hEyeTouch', { s: Math.ceil(elf.eye) }) : t('hEye', { key: keyLabel(b.music), s: Math.ceil(elf.eye) })
    else if (elf.stealthed) h.hint = touch ? t('hStealthTouch', { s: Math.ceil(elf.stealth) }) : t('hStealth', { key: keyLabel(b.gaze), s: Math.ceil(elf.stealth) })
    else h.hint = ''
    h.progress = elf.packing ? elf.packing.t / elf.packing.total : -1
    h.progressLabel = elf.packing ? t('hPacking', { name: elf.packing.g.name }) : ''
    h.spectating = ''
  }

  // 遊俠精靈玩家的技能列與提示
  private syncRangerHud(h: HudState, touch: boolean) {
    const elf = this.elf
    const r = elf.ranger!
    const R = CONFIG.ranger
    const b = this.binds.elf
    const free = elf.stagger <= 0 && !elf.packing && !r.busy
    const pack = this.packReady()
    const squeezed = pressured(elf.pos, this.goblins, R.pressureRadius)
    h.skills = [
      { key: keyLabel(b.gaze), code: b.gaze, name: t('skillTrap'), icon: 'skill-trap', cd: r.charges > 0 ? 0 : r.recharge, max: R.trap.recharge, active: r.plant >= 0, usable: free && r.charges > 0, count: r.charges },
      { key: keyLabel(b.music), code: b.music, name: t('skillLeap'), icon: 'skill-leap', cd: r.cd.leap, max: R.leap.cooldown, active: !!r.leap, usable: free },
      pack
        ? { key: keyLabel(b.stun), code: b.stun, name: t('skillReel'), icon: 'skill-reel', cd: 0, max: R.reel.cooldown, active: false, usable: free }
        : { key: keyLabel(b.stun), code: b.stun, name: t('skillArrow'), icon: 'skill-arrow', cd: r.cd.arrow, max: R.arrow.cooldown, active: !!r.draw, usable: free },
      { key: keyLabel(b.capture), code: b.capture, name: t('skillReel'), icon: 'skill-reel', cd: elf.cd.capture, max: R.reel.cooldown, active: !!elf.packing, usable: free },
    ]
    h.radar = false
    const snaredClose = this.goblins.some((g) => !g.captured && !g.held && g.snare > 0 && d2(g.pos, elf.pos) < R.reel.minRange)
    const snaredFar = this.goblins.some((g) => !g.captured && !g.held && g.snare > 0 && d2(g.pos, elf.pos) > R.reel.maxRange)
    if (elf.stagger > 0) h.hint = t('hRopeCut')
    else if (elf.packing) h.hint = squeezed ? t('hPressured') : ''
    else if (pack) h.hint = touch ? t('hReelTouch') : t('hReel', { key: keyLabel(b.stun) })
    else if (snaredClose) h.hint = touch ? t('hReelTooCloseTouch') : t('hReelTooClose', { key: keyLabel(b.music) })
    else if (snaredFar) h.hint = t('hReelTooFar', { m: R.reel.maxRange })
    else if (squeezed) h.hint = t('hPressured')
    else h.hint = ''
    h.progress = elf.packing ? elf.packing.t / elf.packing.total : -1
    h.progressLabel = elf.packing ? t('hReeling', { name: elf.packing.g.name }) : ''
    h.spectating = ''
  }

  // 精靈玩家的小地圖上這隻哥布林的顏色（null = 不顯示）
  // 刺客之眼：全部（紫色）；豎琴彈奏中：全部（金色，只給精靈玩家，AI 的感知不變）；最終狩獵：全部（橘色）；平常：視線內 28 m
  elfMapColor(gb: Goblin): string | null {
    const elf = this.elf
    if (gb.captured) return null
    if (elf.eye > 0) return '#d0a0ff'
    // 遊俠：受困、被標記、剛踩到陷阱的哥布林
    if (gb.snare > 0 || gb.mark > 0 || gb.reveal > 0 || (gb.held && elf.ranger)) return '#b6ff8a'
    if (elf.channel >= 0) return '#ffe066'
    if (this.finalHunt) return '#ffb347'
    if (d2(gb.pos, elf.pos) < 28 && this.world.lineOfSight(elf.pos, gb.pos)) return MAP_SEEN
    return null
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
    const world = this.world
    const mushroom = world.map === 'mushroom'
    g.beginPath()
    g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2)
    g.fillStyle = mushroom ? 'rgba(34,70,78,0.9)' : 'rgba(86,130,60,0.85)'
    g.fill()
    g.clip()
    // 蘑菇秘境：孢子噴泉（噴霧中畫成一團霧）、台地（亮色＋邊框）、傳送門、彈跳蘑菇
    for (const v of world.vents) {
      const on = world.activeVents().includes(v)
      g.beginPath()
      g.arc(tx(v.pos.x), tz(v.pos.z), on ? v.radius * sc : 2, 0, Math.PI * 2)
      g.fillStyle = on ? 'rgba(170,140,255,0.45)' : 'rgba(200,184,232,0.8)'
      g.fill()
    }
    for (const pl of world.plateaus) {
      g.beginPath()
      g.arc(tx(pl.center.x), tz(pl.center.z), pl.radius * sc, 0, Math.PI * 2)
      g.fillStyle = 'rgba(92,150,120,0.95)'
      g.fill()
      g.strokeStyle = '#2a2448'
      g.lineWidth = 2.5
      g.stroke()
    }
    for (const w of world.warps) {
      g.beginPath()
      if (w.kind === 'portal') g.arc(tx(w.from.x), tz(w.from.z), 2.6, 0, Math.PI * 2)
      else {
        // 彈跳蘑菇：指向落點的小箭頭
        const a = Math.atan2(w.to.z - w.from.z, w.to.x - w.from.x)
        g.moveTo(tx(w.from.x) + Math.cos(a) * 4, tz(w.from.z) + Math.sin(a) * 4)
        g.lineTo(tx(w.from.x) + Math.cos(a + 2.4) * 3, tz(w.from.z) + Math.sin(a + 2.4) * 3)
        g.lineTo(tx(w.from.x) + Math.cos(a - 2.4) * 3, tz(w.from.z) + Math.sin(a - 2.4) * 3)
        g.closePath()
      }
      g.fillStyle = '#' + w.color.toString(16).padStart(6, '0')
      g.fill()
    }
    for (const cave of this.world.caves) {
      if (cave.kind !== 'cave') continue
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
    // 遊俠的陷阱：精靈玩家都看得到；哥布林只看得到身邊的
    if (elf.ranger)
      for (const tr of elf.ranger.traps) {
        if (!this.trapVisible(tr.pos)) continue
        g.beginPath()
        g.arc(tx(tr.pos.x), tz(tr.pos.z), 2.4, 0, Math.PI * 2)
        g.strokeStyle = tr.arm > 0 ? 'rgba(190,255,150,0.5)' : '#7dff5a'
        g.lineWidth = 1.6
        g.stroke()
      }
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
        const color = this.elfMapColor(gb)
        if (color) dot(gb.pos, color, color === MAP_SEEN ? 3 : 3.2)
      }
    } else {
      const me = this.playerGoblin!
      for (const gb of this.goblins) if (!gb.captured && gb !== me) dot(gb.pos, '#9effa0', 2.6)
      // 隱身中的精靈不會出現在小地圖（雷達警告仍然有效）
      const seeElf = !elf.stealthed && (me.captured || (me.zone >= 0 && me.zone === elf.zone) || (d2(me.pos, elf.pos) < 30 && this.world.lineOfSight(me.pos, elf.pos)))
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
