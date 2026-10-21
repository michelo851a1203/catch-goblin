import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { ElfCharacter, HARP_OFFSET } from '../game/elf/ElfCharacter'
import { ElfMagicFx } from '../game/elf/ElfMagicFx'
import { FxSystem } from '../game/fx/Effects'
import { createElf, type Pose } from '../game/models'
import { toon } from '../game/toon'

// 女精靈獨立預覽場景：軌道相機、動作切換、豎琴掛點微調、LOD 與特效測試
const host = document.getElementById('view')!
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
host.appendChild(renderer.domElement)
const outline = new OutlineEffect(renderer, { defaultThickness: 0.0035, defaultColor: [0.1, 0.07, 0.05] })

const scene = new THREE.Scene()
scene.background = new THREE.Color(0xbfe3f2)
scene.fog = new THREE.Fog(0xbfe3f2, 30, 80)
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = 0.55
scene.add(new THREE.HemisphereLight(0xdff0ff, 0x5a7a32, 1.6))
const sun = new THREE.DirectionalLight(0xfff0d0, 2.4)
sun.position.set(6, 10, 5)
sun.castShadow = true
sun.shadow.mapSize.set(1024, 1024)
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 })
scene.add(sun)
const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 48), toon(0x8fbf5a, { outline: false }))
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200)
camera.position.set(0.6, 1.5, 3.6)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 1.0, 0)
controls.enableDamping = true

const elf = new ElfCharacter()
elf.setCamera(camera)
scene.add(elf.root)
const old = createElf()
old.root.position.x = -1.2
old.root.visible = false
scene.add(old.root)

const fxSys = new FxSystem(scene)
const fx = new ElfMagicFx(scene, fxSys)

// ── UI ──
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
let pose: Pose = 'normal'
let victory = false
let harpOn = false
let move = 0
let walkAround = false
let music = 0
const POSES: [string, Pose | 'victory'][] = [
  ['一般', 'normal'], ['彈奏', 'play'], ['凝視', 'cast'], ['攻擊', 'attack'], ['打包', 'pack'], ['暈眩', 'stunned'], ['勝利', 'victory'],
]
const poseBox = $('poses')
for (const [label, p] of POSES) {
  const b = document.createElement('button')
  b.textContent = label
  b.dataset.pose = p
  if (p === 'normal') b.classList.add('on')
  b.onclick = () => {
    victory = p === 'victory'
    pose = p === 'victory' ? 'normal' : p
    elf.setVictory(victory)
    poseBox.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
  }
  poseBox.appendChild(b)
}
$<HTMLInputElement>('move').oninput = (e) => {
  move = Number((e.target as HTMLInputElement).value)
  $('moveV').textContent = move.toFixed(2)
}
$<HTMLInputElement>('walkAround').onchange = (e) => (walkAround = (e.target as HTMLInputElement).checked)
$('harp').onclick = (e) => {
  harpOn = !harpOn
  elf.setHarp(harpOn)
  old.setHarp?.(harpOn)
  ;(e.target as HTMLElement).classList.toggle('on', harpOn)
}
document.querySelectorAll<HTMLButtonElement>('[data-fx]').forEach((b) => {
  b.onclick = () => {
    const p = elf.root.position
    const dir = new THREE.Vector3(Math.sin(elf.root.rotation.y), 0, Math.cos(elf.root.rotation.y))
    if (b.dataset.fx === 'gaze') fx.gaze(p, dir)
    if (b.dataset.fx === 'music') {
      music = 5
      fx.musicStart(p)
    }
    if (b.dataset.fx === 'stun') fx.stun(p.clone().addScaledVector(dir, 2))
    if (b.dataset.fx === 'capture') fx.capture(p.clone().addScaledVector(dir, 1.5))
  }
})
document.querySelectorAll<HTMLButtonElement>('[data-lod]').forEach((b) => {
  b.onclick = () => {
    elf.forceLod(b.dataset.lod === 'auto' ? null : Number(b.dataset.lod))
    document.querySelectorAll('[data-lod]').forEach((x) => x.classList.toggle('on', x === b))
  }
})
let useOutline = true
$('outline').onclick = (e) => {
  useOutline = !useOutline
  ;(e.target as HTMLElement).classList.toggle('on', useOutline)
}
$('compare').onclick = (e) => {
  old.root.visible = !old.root.visible
  ;(e.target as HTMLElement).classList.toggle('on', old.root.visible)
}
// 豎琴掛點微調（數值複製回 ElfCharacter.ts 的 HARP_OFFSET）
const tune = $('harpTune')
const tuneKeys: [string, THREE.Vector3 | THREE.Euler, 'x' | 'y' | 'z', number][] = [
  ['pos x', HARP_OFFSET.position, 'x', 0.3], ['pos y', HARP_OFFSET.position, 'y', 0.3], ['pos z', HARP_OFFSET.position, 'z', 0.3],
  ['rot x', HARP_OFFSET.rotation, 'x', Math.PI], ['rot y', HARP_OFFSET.rotation, 'y', Math.PI], ['rot z', HARP_OFFSET.rotation, 'z', Math.PI],
]
for (const [label, obj, k, range] of tuneKeys) {
  const row = document.createElement('label')
  const input = document.createElement('input')
  Object.assign(input, { type: 'range', min: String(-range), max: String(range), step: '0.01', value: String(obj[k]) })
  const v = document.createElement('span')
  v.textContent = obj[k].toFixed(2)
  input.oninput = () => {
    obj[k] = Number(input.value)
    v.textContent = obj[k].toFixed(2)
    const pivot = elf.root.getObjectByName('HarpPivot')
    if (pivot) {
      pivot.position.copy(HARP_OFFSET.position)
      pivot.rotation.copy(HARP_OFFSET.rotation)
    }
  }
  row.append(label, input, v)
  tune.appendChild(row)
}

function resize() {
  const w = host.clientWidth, h = host.clientHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  fxSys.setViewport(h * renderer.getPixelRatio(), camera.fov)
}
addEventListener('resize', resize)
resize()

const clock = new THREE.Clock()
let t = 0
let statusT = 0
function frame() {
  requestAnimationFrame(frame)
  const dt = Math.min(clock.getDelta(), 0.05)
  t += dt
  let m = move
  if (walkAround) {
    const r = 2.2, w = 0.35 + move * 0.6
    elf.root.position.set(Math.sin(t * w) * r, 0, Math.cos(t * w) * r)
    elf.root.rotation.y = t * w + Math.PI / 2
    m = Math.max(0.3, move)
  }
  const p: Pose = music > 0 ? 'play' : pose
  if (music > 0) {
    music -= dt
    fx.musicTick(dt, elf.root.position, 17)
  }
  elf.animate(dt, p === 'normal' ? m : 0, p)
  if (old.root.visible) old.animate(dt, m, p)
  fx.ambient(dt, elf.root.position, m)
  fx.update(dt)
  fxSys.update(dt, elf.root.position, false)
  controls.update()
  if (useOutline) outline.render(scene, camera)
  else renderer.render(scene, camera)
  statusT -= dt
  if (statusT <= 0) {
    statusT = 0.25
    const info = renderer.info
    $('status').textContent = [
      `status   ${elf.status}${elf.error ? ' (' + String(elf.error) + ')' : ''}`,
      `clip     ${elf.anim.current}`,
      `lod      ${elf.lodLevel}`,
      `harp     ${elf.harpVisible}`,
      `springs  ${elf.springs.count}`,
      `draws    ${info.render.calls}  tris ${info.render.triangles}`,
      `geo/tex  ${info.memory.geometries}/${info.memory.textures}`,
    ].join('\n')
  }
}
frame()
;(window as unknown as { __elf: ElfCharacter }).__elf = elf
