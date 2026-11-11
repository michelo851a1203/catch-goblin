import * as THREE from 'three'
import { CONFIG, type ElfKind } from './config'
import { createElf, createGoblin, type CharacterModel, type Pose } from './models'
import { ElfCharacter } from './elf/ElfCharacter'
import { rigOf } from './elf/rigs'
import { makeSprite } from './toon'
import { t } from '../i18n'

export class Actor {
  pos = new THREE.Vector3()
  vel = new THREE.Vector3()
  wish = new THREE.Vector3() // 期望移動方向（長度 0~1）
  yaw = 0
  zone = -1
  moveAmt = 0
  pose: Pose = 'normal'
  model: CharacterModel
  isPlayer = false
  radius: number
  avoidSide = 1
  // 多人連線：位置由網路驅動（房主端＝其他真人玩家；加入者端＝自己以外的所有角色）
  netDriven = false
  // 加入者端：最近一次房主廣播的位置（t＝收到後經過的秒數，用來短暫推算）
  net: { x: number; z: number; yaw: number; t: number } | null = null
  // 房主強制移動角色（掙脫推開、被捕獲）時遞增，操控者看到變化就以房主位置為準
  corr = 0

  constructor(model: CharacterModel, radius: number) {
    this.model = model
    this.radius = radius
  }

  get root() {
    return this.model.root
  }
}

function barSprites() {
  const bg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x222222, depthTest: false, transparent: true, opacity: 0.75 }))
  const fg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffd34d, depthTest: false }))
  bg.scale.set(1.2, 0.14, 1)
  fg.scale.set(1.16, 0.1, 1)
  bg.center.set(0, 0.5)
  fg.center.set(0, 0.5)
  bg.renderOrder = 11
  fg.renderOrder = 12
  const g = new THREE.Group()
  g.add(bg, fg)
  bg.position.x = -0.6
  fg.position.x = -0.58
  g.visible = false
  return { group: g, fg }
}

export interface GoblinAIState {
  think: number
  fear: number
  lastElf: THREE.Vector3 | null
  target: THREE.Vector3 | null
  wanderT: number
  relocateT: number
  relocating: boolean
  ultDelay: number
  rescueId: number
  rescuing: boolean
  walk: number
}

export class Goblin extends Actor {
  captured = false
  stun = 0
  rooted = 0
  // 紫晶精靈現身時的恐懼：緩慢遠離精靈、不受控制
  terror = 0
  attract = 0
  charm = 0
  held = false
  grace = 0
  dashT = 0
  dashCd = 0
  ultUsed = false
  interfereCd = 0
  homeCave: number
  capturedAt = 0
  ai: GoblinAIState
  fx: {
    radar: THREE.Sprite
    // 刺客之眼的警告（只在操控這隻哥布林的玩家畫面顯示）
    eyeWarn: THREE.Sprite
    bar: ReturnType<typeof barSprites>
  }
  // 捕獲後飛向牢籠的動畫
  flight: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number } | null = null
  dustT = 0

  id: number
  name: string

  constructor(id: number, name: string, homeCave: number) {
    super(createGoblin(id), CONFIG.goblin.radius)
    this.id = id
    this.name = name
    this.homeCave = homeCave
    this.ai = {
      think: Math.random() * 0.3,
      fear: 0,
      lastElf: null,
      target: null,
      wanderT: 0,
      relocateT: 50 + Math.random() * 90,
      relocating: false,
      ultDelay: -1,
      rescueId: -1,
      rescuing: false,
      walk: 0.45,
    }
    const radar = makeSprite(t('elfInCave'), 0.42, { w: 512, h: 128, font: 58, bg: 'rgba(200,40,40,0.92)' })
    const bar = barSprites()
    radar.visible = false
    radar.position.y = 2.15
    const eyeWarn = makeSprite(t('eyeWarn'), 0.42, { w: 640, h: 128, font: 54, bg: 'rgba(110,40,190,0.92)' })
    eyeWarn.visible = false
    eyeWarn.position.y = 2.55
    bar.group.position.y = 1.95
    this.root.add(radar, eyeWarn, bar.group)
    this.fx = { radar, eyeWarn, bar }
  }

  get free() {
    return !this.captured
  }
  get disabled() {
    return this.stun > 0 || this.rooted > 0 || this.terror > 0 || this.held || this.captured
  }
}

export type ChargePhase = 'windup' | 'dash' | 'recover'
export interface ChargeState {
  phase: ChargePhase
  t: number
  dir: THREE.Vector3
  done: number // 已衝刺的距離
  hit: number // 命中的哥布林編號，-1 = 落空
}

export class Elf extends Actor {
  readonly kind: ElfKind
  cd = { gaze: 0, music: 0, stun: 0, capture: 0, stealth: 0, eye: 0, charge: 0 }
  // 紫晶精靈：拉琴準備隱身（≥0 = 拉琴中經過的秒數）、隱身剩餘秒數、刺客之眼剩餘秒數、衝鋒
  stealthCast = -1
  stealth = 0
  eye = 0
  charge: ChargeState | null = null
  channel = -1
  musicAffected = new Set<Goblin>()
  musicNoteT = 0
  musicNote = 0
  packing: { g: Goblin; t: number; total: number } | null = null
  stagger = 0
  castT = 0
  castPose: Pose = 'normal'
  ai = {
    think: 0,
    target: null as Goblin | null,
    seen: new Map<Goblin, { pos: THREE.Vector3; at: number; since: number }>(),
    patrolCave: -1,
    patrolWait: 0,
    plannedChannel: 0,
    dest: null as THREE.Vector3 | null,
  }
  fx: { bar: ReturnType<typeof barSprites>; stunned: THREE.Sprite }
  // GLB 綁骨角色；載入完成前（或失敗時）顯示程序化的 createElf()
  readonly character: ElfCharacter

  constructor(kind: ElfKind = 'harp') {
    const character = new ElfCharacter({ rig: rigOf(kind), fallback: createElf() })
    super(character, CONFIG.elf.radius)
    this.kind = kind
    this.character = character
    const bar = barSprites()
    bar.group.position.y = 2.25
    const stunned = makeSprite('💥', 0.6, { w: 128, h: 128, font: 90 })
    stunned.position.y = 2.1
    stunned.visible = false
    this.root.add(bar.group, stunned)
    this.fx = { bar, stunned }
  }

  // ───── 動作狀態 ─────
  // 精靈同一時間只會做一件事：打包 / 彈奏 / 拉琴準備隱身 / 衝鋒（硬直可疊加在上面）。
  // 以下的轉移函式是唯一該改動這些欄位的地方，房主（判定）與加入者（套用事件）共用，避免兩邊各寫一份而不一致
  get action(): ElfAction {
    if (this.charge) return this.charge.phase
    if (this.channel >= 0) return 'channel'
    if (this.stealthCast >= 0) return 'stealthCast'
    if (this.packing) return 'packing'
    return 'idle'
  }

  get busy() {
    return this.packing !== null || this.channel >= 0 || this.stagger > 0 || this.stealthCast >= 0 || this.charge !== null
  }

  get stealthed() {
    return this.stealth > 0
  }

  // 彈奏（豎琴）
  startChannel() {
    this.channel = 0
    this.musicAffected.clear()
  }
  stopChannel() {
    this.channel = -1
    this.cd.music = CONFIG.elf.music.cooldown
  }

  // 打包：精靈的 packing 與哥布林的 held 必須一起變動
  startPacking(g: Goblin, total: number) {
    g.held = true
    this.packing = { g, t: 0, total }
  }
  // 結束打包（完成或被打斷），回傳被打包的哥布林
  endPacking(): Goblin {
    const g = this.packing!.g
    this.packing = null
    this.cd.capture = CONFIG.elf.capture.cooldown
    g.held = false
    return g
  }

  // 紫晶精靈：拉琴準備隱身 → 隱身 → 現身（進入冷卻）
  startStealthCast() {
    this.stealthCast = 0
  }
  enterStealth() {
    this.stealthCast = -1
    this.stealth = CONFIG.violin.stealth.duration
  }
  exitStealth() {
    this.stealth = 0
    this.cd.stealth = CONFIG.violin.stealth.cooldown
  }

  // 刺客之眼：開圖 → 瞬移或時間到 → 冷卻
  openEye() {
    this.eye = CONFIG.violin.eye.duration
  }
  closeEye() {
    this.eye = 0
    this.cd.eye = CONFIG.violin.eye.cooldown
  }

  // 衝鋒：前搖 → 突刺 → 收招 → 結束
  startCharge(dir: THREE.Vector3) {
    this.charge = { phase: 'windup', t: 0, dir, done: 0, hit: -1 }
  }
  recoverCharge(hit: number) {
    const c = this.charge!
    c.phase = 'recover'
    c.t = 0
    c.hit = hit
    this.cd.charge = CONFIG.violin.charge.cooldown
  }
  cancelCharge() {
    this.charge = null
  }

  // 結算：一定現身、停止所有持續中的技能狀態
  resetForResult() {
    this.stealth = 0
    this.stealthCast = -1
    this.eye = 0
    this.charge = null
  }
}

export type ElfAction = 'idle' | 'channel' | 'stealthCast' | 'packing' | ChargePhase
