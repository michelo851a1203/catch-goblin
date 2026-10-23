import * as THREE from 'three'
import { CONFIG } from './config'
import { createElf, createGoblin, type CharacterModel, type Pose } from './models'
import { ElfCharacter } from './elf/ElfCharacter'
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
    bar.group.position.y = 1.95
    this.root.add(radar, bar.group)
    this.fx = { radar, bar }
  }

  get free() {
    return !this.captured
  }
  get disabled() {
    return this.stun > 0 || this.rooted > 0 || this.held || this.captured
  }
}

export class Elf extends Actor {
  cd = { gaze: 0, music: 0, stun: 0, capture: 0 }
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

  constructor() {
    const character = new ElfCharacter({ fallback: createElf() })
    super(character, CONFIG.elf.radius)
    this.character = character
    const bar = barSprites()
    bar.group.position.y = 2.25
    const stunned = makeSprite('💥', 0.6, { w: 128, h: 128, font: 90 })
    stunned.position.y = 2.1
    stunned.visible = false
    this.root.add(bar.group, stunned)
    this.fx = { bar, stunned }
  }

  get busy() {
    return this.packing !== null || this.channel >= 0 || this.stagger > 0
  }
}
