import * as THREE from 'three'
import { CONFIG } from './config'
import { isShortSession } from '../platform'
import { mesh, noOutline, toon } from './toon'
import { glowSprite } from './fx/atlas'
import { noise3, rand, type CaveStyle, type Theme, type World } from './world'

// 蘑菇秘境：夜晚的發光蘑菇林。地面上有 2 座哥布林山洞，3 座高起的「蘑菇台地」也是哥布林的據點。
// 台地只能經由傳送門（雙向）上下，或踩台地邊緣的彈跳蘑菇跳回地面（單向）；地面上的孢子噴泉會定時噴出擋視線的孢子霧。
// 五個據點放在預設草原五座山洞的位置（洞與洞之間的距離相同），讓兩張地圖的勝率接近

export const MUSHROOM_THEME: Theme = {
  fog: 0x16304a, fogNear: 45, fogFar: 230, hemiSky: 0x9ab4ff, hemiGround: 0x2a3250, hemi: 1.05, hemiCave: 0.75,
  sun: 1.35, sunColor: 0xc4d2ff, sunCave: 0.9, ambient: 'spores',
}

// 台地的高度（畫面上）
export const PLATEAU_HEIGHT = 6
// 傳送門 / 彈跳蘑菇的觸發半徑與落點距離
const PORTAL_R = 1.2
const PORTAL_EXIT = 2.6
const PAD_R = 1.1

// 平衡用的參數：以無頭 AI 對 AI 模擬調整到兩張地圖的精靈勝率相同（見 tests/balance.test.ts）；測試可暫時覆寫。
// 2026-11-26 量測（AI 對 AI，種子 1000 起，每格 160～384 場）：
//                          短局版（itch.io / CrazyGames）   網站版（長局）
//                           草原     蘑菇秘境               草原     蘑菇秘境
//   豎琴・AI 精靈            0.74      0.74                  0.44      0.43
//   豎琴・玩家速度精靈        0.93      0.89                  0.66      0.76  ← 網站版仍偏精靈（見下）
//   紫晶・AI 精靈            1.00      0.96                  1.00      1.00
//   紫晶・玩家速度精靈        0.99      0.99                  1.00      1.00
// 遊俠精靈（2026-11-27 加入）的量測在 config.ts 的 CONFIG.ranger 與 docs/ranger.md
// 網站版把月光傘台改成山洞（extraCave）可以把玩家速度精靈調回 0.68，但會變成 3 座山洞（地圖設計是 2 座），所以沒有採用
const SHORT = isShortSession
export const MUSHROOM_TUNE = {
  // 孢子噴泉：幾座、霧的半徑、每次噴多久（秒）
  vents: 4,
  ventRadius: 4.2,
  ventDuration: 5.5,
  // 台地邊緣的彈跳蘑菇
  pads: true,
  // 台地背面（朝地圖外側）多一組傳送門
  backPortals: false,
  // 台地的半徑（崖壁的位置）
  plateauR: SHORT ? 12 : 15,
  // 擋視線的巨大蘑菇、石頭數量
  shrooms: SHORT ? 34 : 46,
  rocks: 30,
  // 月光傘台改成山洞（3 座山洞 + 2 座台地）
  extraCave: false,
}

const MUSHROOM_CAVE: CaveStyle = {
  rock: 0x6c6690, moss: 0x3f7d72, boulder: 0x5d5780, floor: 0x2b2838, pillar: 0x564f72,
  shroom: 0xffa66a, shroomGlow: 0x9a3e10, halo: 0xffb070,
  extra: (world, center, R, gaps) => {
    // 洞口兩側的發光水晶、圓頂上長出的蘑菇
    for (const a of gaps)
      for (const s of [-1, 1]) {
        const aa = a + s * 0.42
        crystalCluster(world, center.x + Math.cos(aa) * (R + 1.6), 0, center.z + Math.sin(aa) * (R + 1.6), s > 0 ? 0x6fd8ff : 0xb98cff, 1)
      }
    for (let k = 0; k < 5; k++) {
      const a = rand() * Math.PI * 2, r = 4 + rand() * 6
      const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r
      const y = Math.sqrt(Math.max(0, R * R - r * r)) * 0.62 - 0.3
      giantMushroom(world, x, y, z, 1.6 + rand() * 1.4, k % 2 ? 0xff7fb8 : 0x6f9cff, false)
    }
  },
}

export function buildMushroomWorld(world: World) {
  world.theme = MUSHROOM_THEME
  const k = CONFIG.mapScale
  buildSky(world)
  buildGround(world)
  const dens = [
    { kind: 'cave', name: '螢光蘑菇窟', x: 8, z: -62, rot: 0.3 },
    { kind: 'plateau', name: '東傘台', x: 62, z: -8 },
    { kind: 'cave', name: '孢子老窟', x: -10, z: 62, rot: 0.1 },
    { kind: 'plateau', name: '西傘台', x: -60, z: 6 },
    { kind: 'plateau', name: '月光傘台', x: 48, z: 52 },
  ] as const
  // 每座台地一種傳送門顏色
  const colors = [0x5fe8ff, 0xff6fd8, 0xffc44a]
  let pi = 0
  dens.forEach((d, id) => {
    if (d.kind === 'cave' || (MUSHROOM_TUNE.extraCave && id === 4)) world.buildCave(id, d.name, d.x * k, d.z * k, 'rot' in d ? d.rot : 0.8, MUSHROOM_CAVE)
    else buildPlateau(world, id, d.name, d.x * k, d.z * k, colors[pi++])
  })
  world.buildCage(0x6a4fa0)
  plaza(world)
  addVents(world)
  scatter(world)
  boundary(world)
}

// ───────────────────────── 天空與地面 ─────────────────────────
function buildSky(world: World) {
  const geo = new THREE.SphereGeometry(400, 32, 16)
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { top: { value: new THREE.Color(0x070b24) }, mid: { value: new THREE.Color(0x15325a) }, bottom: { value: new THREE.Color(0x2c7a8c) } },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP;
      void main(){ float h = clamp(normalize(vP).y*1.5+0.08,0.,1.);
        vec3 c = h < 0.35 ? mix(bottom, mid, h/0.35) : mix(mid, top, (h-0.35)/0.65);
        gl_FragColor = vec4(c,1.); }`,
  })
  noOutline(mat)
  world.scene.add(new THREE.Mesh(geo, mat))

  // 星星
  const n = 700
  const pos = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2, e = 0.12 + rand() * 1.3
    pos.set([Math.cos(a) * Math.cos(e) * 380, Math.sin(e) * 380, Math.sin(a) * Math.cos(e) * 380], i * 3)
  }
  const sg = new THREE.BufferGeometry()
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const stars = new THREE.Points(sg, noOutline(new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.85, depthWrite: false, fog: false })))
  world.scene.add(stars)

  // 月亮
  const moon = new THREE.Mesh(new THREE.CircleGeometry(16, 32), noOutline(new THREE.MeshBasicMaterial({ color: 0xf4f0d8, fog: false })))
  moon.position.set(-150, 190, -280)
  moon.lookAt(0, 0, 0)
  world.scene.add(moon)
  const halo = glowSprite(0xbcd4ff, 120, 0.35)
  ;(halo.material as THREE.SpriteMaterial).fog = false
  halo.position.copy(moon.position)
  world.scene.add(halo)
}

function buildGround(world: World) {
  const size = 340
  const geo = new THREE.PlaneGeometry(size, size, 90, 90)
  geo.rotateX(-Math.PI / 2)
  const colors: number[] = []
  const pos = geo.attributes.position
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i)
    const n = noise3(x * 0.04, 7, z * 0.04)
    const n2 = noise3(x * 0.18, 2, z * 0.18)
    // 青苔地面，夾雜紫色的菌毯
    const violet = Math.max(0, n - 0.55) * 2.2
    c.setHSL(0.46 + violet * 0.28, 0.38 - violet * 0.08, 0.15 + n2 * 0.06)
    const d = Math.hypot(x, z)
    if (d > CONFIG.worldRadius + 6) pos.setY(i, (d - CONFIG.worldRadius - 6) * 0.3 * n)
    colors.push(c.r, c.g, c.b)
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  const ground = mesh(geo, toon(0xffffff, { vertexColors: true, outline: false }))
  ground.castShadow = false
  world.scene.add(ground)

  // 發光的小徑：圍繞中央的環狀步道
  const stone = toon(0xe6c48a, { outline: false, emissive: 0x6a4512 })
  const k = CONFIG.mapScale
  for (let i = 0; i < 150; i++) {
    const a = (i / 150) * Math.PI * 2
    const r = (34 + Math.sin(a * 3) * 6) * k
    const s = mesh(new THREE.CircleGeometry(1.3 + rand() * 0.7, 7), stone, false)
    s.rotation.x = -Math.PI / 2
    s.rotation.z = rand() * 3
    s.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r)
    s.receiveShadow = true
    world.scene.add(s)
  }
}

// ───────────────────────── 台地 ─────────────────────────
function buildPlateau(world: World, id: number, name: string, cx: number, cz: number, color: number) {
  const R = MUSHROOM_TUNE.plateauR
  const H = PLATEAU_HEIGHT
  const region = world.plateaus.length + 1
  const center = new THREE.Vector3(cx, 0, cz)
  world.plateaus.push({ region, center, radius: R, height: H })

  // 崖壁：低多邊形的紫色岩壁（稍微往外鼓，底部略寬）
  const cliffGeo = new THREE.CylinderGeometry(R + 0.4, R + 1.4, H, 44, 4, true)
  const p = cliffGeo.attributes.position
  const v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i)
    const n = noise3(v.x * 0.3 + cx, v.y * 0.35, v.z * 0.3 + cz)
    const k = 1 + (n - 0.5) * 0.09
    p.setXYZ(i, v.x * k, v.y, v.z * k)
  }
  cliffGeo.computeVertexNormals()
  const cliff = mesh(cliffGeo, toon(0x5d5684, { side: THREE.DoubleSide }))
  cliff.position.set(cx, H / 2, cz)
  world.scene.add(cliff)

  // 台地頂：青苔地面 + 邊緣的苔蘚
  const topGeo = new THREE.CircleGeometry(R + 0.5, 44)
  topGeo.rotateX(-Math.PI / 2)
  const tc: number[] = []
  const tp = topGeo.attributes.position
  const col = new THREE.Color()
  for (let i = 0; i < tp.count; i++) {
    const n = noise3(tp.getX(i) * 0.2 + cx, 3, tp.getZ(i) * 0.2 + cz)
    col.setHSL(0.44 + n * 0.05, 0.38, 0.19 + n * 0.06)
    tc.push(col.r, col.g, col.b)
  }
  topGeo.setAttribute('color', new THREE.Float32BufferAttribute(tc, 3))
  const top = mesh(topGeo, toon(0xffffff, { vertexColors: true, outline: false, side: THREE.DoubleSide }))
  top.position.set(cx, H, cz)
  world.scene.add(top)
  const rim = mesh(new THREE.TorusGeometry(R + 0.35, 0.55, 5, 44), toon(0x4f9a6a, {}))
  rim.rotation.x = Math.PI / 2
  rim.position.set(cx, H + 0.05, cz)
  world.scene.add(rim)
  world.occluders.push(cliff, top)

  // 崖壁上的發光層孔菌與垂藤
  const shelf = toon(0xffb066, { emissive: 0x8a3a0a, outline: false })
  const vine = toon(0x3f8a52, { outline: false })
  for (let i = 0; i < 14; i++) {
    const a = rand() * Math.PI * 2
    const y = 1.2 + rand() * (H - 2.2)
    const s = mesh(new THREE.CylinderGeometry(0.9 + rand() * 0.6, 0.2, 0.28, 10, 1, false, 0, Math.PI), shelf, false)
    s.position.set(cx + Math.cos(a) * (R + 0.9), y, cz + Math.sin(a) * (R + 0.9))
    s.rotation.y = -a + Math.PI / 2
    world.scene.add(s)
  }
  for (let i = 0; i < 22; i++) {
    const a = rand() * Math.PI * 2
    const len = 1.5 + rand() * 3
    const vn = mesh(new THREE.CylinderGeometry(0.07, 0.05, len, 4), vine, false)
    vn.position.set(cx + Math.cos(a) * (R + 0.75), H - len / 2, cz + Math.sin(a) * (R + 0.75))
    world.scene.add(vn)
  }

  // 崖壁碰撞：沿圓周放碰撞圓（擋路也擋視線）。半徑較大，台地上下的角色至少相隔 3.7 公尺（大於擊暈 / 捕獲 / 攪局的距離）
  const step = 1.1
  const n = Math.floor((Math.PI * 2 * R) / step)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    world.colliders.push({ x: cx + Math.cos(a) * R, z: cz + Math.sin(a) * R, r: 1.3, blocksSight: true })
  }

  // 中央的巨大蘑菇（地標，從遠處就看得到）
  giantMushroom(world, cx, H, cz, 7.5, color === 0xffc44a ? 0x4f74d8 : color === 0xff6fd8 ? 0x8a5ad8 : 0x3f8ad0, true)
  world.colliders.push({ x: cx, z: cz, r: 1.3, blocksSight: true })
  const light = new THREE.PointLight(0xffb070, 9, 20, 1.4)
  light.position.set(cx, H + 5, cz)
  world.scene.add(light)
  // 台地上的小蘑菇與水晶
  for (let i = 0; i < 10; i++) {
    const a = rand() * Math.PI * 2, r = 4 + rand() * (R - 6)
    glowShroom(world, cx + Math.cos(a) * r, H, cz + Math.sin(a) * r, 0.7 + rand() * 0.9, [0x6fe8ff, 0xff8fd0, 0xffd27a][i % 3])
  }
  // 水晶放在背面的兩個斜角（避開傳送門、彈跳蘑菇、背面傳送門的通道）
  const face = Math.atan2(-cz, -cx)
  for (let i = 0; i < 2; i++) {
    const a = face + (i ? 1 : -1) * Math.PI * 0.75
    const x = cx + Math.cos(a) * (R - 5.5), z = cz + Math.sin(a) * (R - 5.5)
    crystalCluster(world, x, H, z, i ? 0x6fd8ff : 0xb98cff, 0.8)
    world.colliders.push({ x, z, r: 0.8, blocksSight: false })
  }

  world.caves.push({ id, name, center, radius: R, gaps: [], dome: [], kind: 'plateau' })

  // 傳送門：台地朝向地圖中央的一側，崖下一座、台地上一座（雙向）
  const u = new THREE.Vector3(-cx, 0, -cz).normalize()
  portalPair(world, center, region, u, color)
  if (MUSHROOM_TUNE.backPortals) portalPair(world, center, region, u.clone().negate(), color)
  if (!MUSHROOM_TUNE.pads) return

  // 彈跳蘑菇：台地側面的邊緣，往側邊彈到地面（單向）；挑落點離其他據點較遠的那一側
  const perp = [new THREE.Vector3(-u.z, 0, u.x), new THREE.Vector3(u.z, 0, -u.x)]
  const landingOf = (d: THREE.Vector3) => center.clone().addScaledVector(d, R + 11)
  const others = (q: THREE.Vector3) => Math.min(...world.caves.filter((c) => c.id !== id).map((c) => c.center.distanceTo(q)), Infinity)
  const side = perp
    .filter((d) => landingOf(d).length() < CONFIG.worldRadius - 6)
    .sort((x, y) => others(landingOf(y)) - others(landingOf(x)))[0] ?? perp[0]
  const pad = center.clone().addScaledVector(side, R - 3.2)
  const land = landingOf(side)
  const b = world.warps.length
  world.warps.push({ id: b, kind: 'bounce', from: pad, region, radius: PAD_R, to: land, toRegion: 0, pair: -1, color: 0xff7a6a })
  bouncePad(world, b, pad, H)
  world.keepOut.push({ x: land.x, z: land.z, r: 4 })
  // 落點的光圈
  const ring = mesh(new THREE.RingGeometry(1.4, 1.9, 24), noOutline(new THREE.MeshBasicMaterial({ color: 0xff9a7a, transparent: true, opacity: 0.45, depthWrite: false })), false)
  ring.rotation.x = -Math.PI / 2
  ring.position.set(land.x, 0.05, land.z)
  world.scene.add(ring)
}

// 一組雙向傳送門：崖下（台地外 dir 方向）與台地上，落點都在對面傳送門的範圍外、沿著穿過的方向
function portalPair(world: World, center: THREE.Vector3, region: number, dir: THREE.Vector3, color: number) {
  const R = MUSHROOM_TUNE.plateauR
  const low = center.clone().addScaledVector(dir, R + 4.5)
  const high = center.clone().addScaledVector(dir, R - 4)
  const a = world.warps.length
  const exitDown = low.clone().addScaledVector(dir, PORTAL_EXIT)
  const exitUp = high.clone().addScaledVector(dir, -PORTAL_EXIT)
  world.warps.push(
    { id: a, kind: 'portal', from: low, region: 0, radius: PORTAL_R, to: exitUp, toRegion: region, pair: a + 1, color },
    { id: a + 1, kind: 'portal', from: high, region, radius: PORTAL_R, to: exitDown, toRegion: 0, pair: a, color },
  )
  portal(world, low, dir, 0, color)
  portal(world, high, dir, PLATEAU_HEIGHT, color)
  world.keepOut.push({ x: low.x, z: low.z, r: 4.5 }, { x: exitDown.x, z: exitDown.z, r: 2 })
}

// 傳送門：哥布林用木頭搭的門框＋紅布條，中間是旋轉的魔法漩渦（u＝穿過的方向）
function portal(world: World, p: THREE.Vector3, u: THREE.Vector3, y: number, color: number) {
  const g = new THREE.Group()
  g.position.set(p.x, y, p.z)
  g.rotation.y = Math.atan2(u.x, u.z)
  const wood = toon(0x7a4f2a)
  const dark = toon(0x5a3a20)
  for (const s of [-1, 1]) {
    const post = mesh(new THREE.BoxGeometry(0.38, 3.9, 0.38), wood)
    post.position.set(s * 1.75, 1.95, 0)
    post.rotation.z = s * 0.05
    g.add(post)
    const brace = mesh(new THREE.BoxGeometry(0.22, 2.2, 0.22), dark)
    brace.position.set(s * 1.75, 1.0, s * 0.55)
    brace.rotation.x = s * 0.5
    g.add(brace)
  }
  const beam = mesh(new THREE.BoxGeometry(4.6, 0.36, 0.42), wood)
  beam.position.y = 3.85
  beam.rotation.z = 0.04
  g.add(beam)
  const plank = mesh(new THREE.BoxGeometry(3.9, 0.26, 0.3), dark)
  plank.position.set(0, 3.35, 0.12)
  plank.rotation.z = -0.06
  g.add(plank)
  // 紅布條
  const cloth = mesh(new THREE.PlaneGeometry(1.3, 0.7, 4, 2), toon(0xc8402a, { side: THREE.DoubleSide, outline: false }), false)
  cloth.position.set(-0.9, 3.45, 0.24)
  cloth.rotation.z = 0.15
  g.add(cloth)
  const cloth2 = cloth.clone()
  cloth2.position.set(1.0, 3.5, 0.24)
  cloth2.rotation.z = -0.2
  g.add(cloth2)
  // 漩渦
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uT: { value: rand() * 10 }, uC: { value: new THREE.Color(color) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float uT; uniform vec3 uC; varying vec2 vUv;
      void main(){
        vec2 q = vUv*2.-1.; float r = length(q); if (r > 1.) discard;
        float a = atan(q.y, q.x);
        float sw = sin(a*3. + r*11. - uT*4.);
        float band = smoothstep(0.1, 0.9, sw*0.5+0.5);
        float core = exp(-r*r*3.5);
        float edge = smoothstep(1., 0.82, r) * (0.55 + 0.45*smoothstep(0.7, 1., r));
        vec3 c = mix(uC, vec3(1.), core*0.7);
        gl_FragColor = vec4(c * (band*0.75 + core*1.2) * edge, edge*(0.55 + band*0.45));
      }`,
  })
  noOutline(mat)
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1.45, 40), mat)
  disc.position.y = 1.75
  disc.renderOrder = 5
  g.add(disc)
  const glow = glowSprite(color, 5, 0.55)
  glow.position.y = 1.75
  g.add(glow)
  // 地上的石圈
  const stoneMat = toon(0x8c86a8, {})
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2
    const s = mesh(new THREE.DodecahedronGeometry(0.28, 0), stoneMat)
    s.position.set(Math.cos(a) * 1.55, 0.12, Math.sin(a) * 1.55)
    g.add(s)
  }
  const pad = mesh(new THREE.CircleGeometry(1.35, 24), noOutline(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false })), false)
  pad.rotation.x = -Math.PI / 2
  pad.position.y = 0.04
  g.add(pad)
  world.scene.add(g)
  const t0 = mat.uniforms.uT.value as number
  world.animators.push((_dt, t) => {
    mat.uniforms.uT.value = t0 + t
    glow.material.opacity = 0.45 + Math.sin(t * 3 + t0) * 0.12
  })
}

// 彈跳蘑菇：紅底白點的大蘑菇，被踩到時壓扁再彈回來
function bouncePad(world: World, warp: number, p: THREE.Vector3, y: number) {
  const g = new THREE.Group()
  g.position.set(p.x, y, p.z)
  const stem = mesh(new THREE.CylinderGeometry(0.45, 0.6, 0.7, 10), toon(0xf2e6d0))
  stem.position.y = 0.35
  g.add(stem)
  const capG = new THREE.SphereGeometry(1.35, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  capG.scale(1, 0.55, 1)
  const cap = mesh(capG, toon(0xe8443a, { emissive: 0x3a0806 }))
  cap.position.y = 0.6
  g.add(cap)
  const dotMat = toon(0xfff6e6, { emissive: 0x554433, outline: false })
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3, e = i % 2 ? 0.5 : 0.9
    const d = mesh(new THREE.SphereGeometry(0.17, 6, 4), dotMat, false)
    d.position.set(Math.cos(a) * Math.sin(e) * 1.3, 0.6 + Math.cos(e) * 0.72, Math.sin(a) * Math.sin(e) * 1.3)
    d.scale.y = 0.5
    g.add(d)
  }
  const glow = glowSprite(0xff8a6a, 3.2, 0.4)
  glow.position.y = 0.9
  g.add(glow)
  world.scene.add(g)
  let squash = 0
  const prev = world.onBounce
  world.onBounce = (id) => {
    if (id === warp) squash = 1
    else prev?.(id)
  }
  world.animators.push((dt, t) => {
    squash = Math.max(0, squash - dt * 2.2)
    const s = squash > 0 ? 1 - Math.sin(squash * Math.PI * 2.5) * squash * 0.4 : 1 + Math.sin(t * 2 + warp) * 0.03
    cap.scale.set(2 - s, s, 2 - s)
  })
}

// ───────────────────────── 機關：孢子噴泉 ─────────────────────────
function addVents(world: World) {
  const k = CONFIG.mapScale
  const defs = [
    { x: 30, z: 24, phase: 0 },
    { x: -34, z: -26, phase: 5 },
    { x: -40, z: 34, phase: 9 },
    { x: 36, z: -36, phase: 3 },
  ]
  for (const d of defs.slice(0, MUSHROOM_TUNE.vents)) {
    const pos = new THREE.Vector3(d.x * k, 0, d.z * k)
    const vent = { pos, radius: MUSHROOM_TUNE.ventRadius, period: 15, duration: MUSHROOM_TUNE.ventDuration, phase: d.phase }
    world.vents.push(vent)
    world.keepOut.push({ x: pos.x, z: pos.z, r: 3 })
    world.colliders.push({ x: pos.x, z: pos.z, r: 0.9, blocksSight: false })
    // 馬勃菇（圓滾滾的噴泉本體）
    const ball = mesh(new THREE.IcosahedronGeometry(0.95, 1), toon(0xc8b8e8, { emissive: 0x2a1f40 }))
    ball.position.set(pos.x, 0.75, pos.z)
    ball.scale.y = 0.85
    world.scene.add(ball)
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4
      const sm = mesh(new THREE.IcosahedronGeometry(0.42, 0), toon(0xb0a0d8, {}))
      sm.position.set(pos.x + Math.cos(a) * 1.2, 0.3, pos.z + Math.sin(a) * 1.2)
      world.scene.add(sm)
    }
    // 孢子霧：幾團柔光，噴霧時膨脹變亮
    const puffs: THREE.Sprite[] = []
    for (let i = 0; i < 9; i++) {
      const s = glowSprite(i % 3 ? 0x9a7aff : 0x6fe8d8, 1, 0)
      const m = s.material as THREE.SpriteMaterial
      m.blending = THREE.NormalBlending
      s.position.set(pos.x, 1.5, pos.z)
      world.scene.add(s)
      puffs.push(s)
    }
    const seeds = puffs.map(() => [rand() * Math.PI * 2, rand(), rand()])
    world.animators.push((dt, t) => {
      const ph = (world.simTime + vent.phase) % vent.period
      const on = ph < vent.duration
      // 噴發 / 消散的漸變
      const a = on ? Math.min(1, ph / 0.6) * Math.min(1, (vent.duration - ph) / 0.8 + 0.2) : 0
      ball.scale.set(1 + a * 0.12, 0.85 - a * 0.15, 1 + a * 0.12)
      puffs.forEach((s, i) => {
        const [ang, r, h] = seeds[i]
        const m = s.material as THREE.SpriteMaterial
        const rr = vent.radius * (0.25 + r * 0.6) * (0.4 + a * 0.6)
        s.position.set(pos.x + Math.cos(ang + t * 0.2) * rr, 0.8 + h * 2.6 * a + a, pos.z + Math.sin(ang + t * 0.2) * rr)
        s.scale.setScalar((3.5 + r * 3) * (0.3 + a * 0.9))
        m.opacity = a * 0.55
        s.visible = a > 0.01
      })
      // 快噴發時微微鼓動
      if (!on && vent.period - ph < 1.5) ball.scale.y = 0.85 + Math.sin(t * 20) * 0.04
      void dt
    })
  }
}

// ───────────────────────── 中央廣場 ─────────────────────────
function plaza(world: World) {
  const circle = mesh(new THREE.RingGeometry(5.2, 5.6, 48), noOutline(new THREE.MeshBasicMaterial({ color: 0x9ad8ff, transparent: true, opacity: 0.5, depthWrite: false })), false)
  circle.rotation.x = -Math.PI / 2
  circle.position.y = 0.04
  world.scene.add(circle)
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    glowShroom(world, Math.cos(a) * 6.4, 0, Math.sin(a) * 6.4, 0.8 + (i % 3) * 0.25, i % 2 ? 0x6fe8ff : 0xffd27a)
  }
}

// ───────────────────────── 散佈的植物、石頭、水晶 ─────────────────────────
function scatter(world: World) {
  // 巨大蘑菇（樹木的位置）：擋路也擋視線
  const capColors = [0x3f63c8, 0x6a4fc8, 0x2f8ab0, 0xc8507a]
  for (let i = 0; i < MUSHROOM_TUNE.shrooms; i++) {
    const p = world.freeSpot(3)
    if (!p) continue
    const h = 4 + rand() * 6
    giantMushroom(world, p.x, 0, p.z, h, capColors[i % capColors.length], i % 4 === 0)
    world.colliders.push({ x: p.x, z: p.z, r: 0.75, blocksSight: true })
  }
  // 深色的杉樹，讓林子更茂密
  const trunkMat = toon(0x4a3426)
  const pine = toon(0x24504a, {})
  for (let i = 0; i < 16; i++) {
    const p = world.freeSpot(3)
    if (!p) continue
    const t = new THREE.Group()
    const h = 3 + rand() * 2
    const trunk = mesh(new THREE.CylinderGeometry(0.25, 0.4, h, 7), trunkMat)
    trunk.position.y = h / 2
    t.add(trunk)
    for (let k = 0; k < 3; k++) {
      const cone = mesh(new THREE.ConeGeometry(2.2 - k * 0.5, 2.4, 8), pine)
      cone.position.y = h + k * 1.3 - 0.3
      t.add(cone)
    }
    t.position.copy(p)
    world.scene.add(t)
    world.colliders.push({ x: p.x, z: p.z, r: 0.7, blocksSight: true })
  }
  // 石頭
  const rockMat = toon(0x6e6890, {})
  for (let i = 0; i < MUSHROOM_TUNE.rocks; i++) {
    const p = world.freeSpot(2)
    if (!p) continue
    const s = 0.6 + rand() * 1.4
    const r = mesh(new THREE.DodecahedronGeometry(s, 0), rockMat)
    r.position.set(p.x, s * 0.5, p.z)
    r.rotation.set(rand() * 3, rand() * 3, rand() * 3)
    world.scene.add(r)
    world.colliders.push({ x: p.x, z: p.z, r: s * 0.9, blocksSight: s > 1.2 })
  }
  // 水晶叢（不擋視線）
  for (let i = 0; i < 16; i++) {
    const p = world.freeSpot(1.5)
    if (!p) continue
    crystalCluster(world, p.x, 0, p.z, i % 2 ? 0x6fd8ff : 0xb98cff, 0.8 + rand() * 0.6)
    world.colliders.push({ x: p.x, z: p.z, r: 0.7, blocksSight: false })
  }
  // 發光小蘑菇（不擋路）
  const colors = [0x6fe8ff, 0xff8fd0, 0xffd27a, 0x9effa0]
  for (let i = 0; i < 70; i++) {
    const p = world.freeSpot(0.5)
    if (!p) continue
    glowShroom(world, p.x, 0, p.z, 0.6 + rand() * 1.1, colors[i % colors.length], i % 3 === 0)
  }

  // 草叢：藍綠色的草
  const blade = new THREE.ConeGeometry(0.07, 0.6, 3)
  blade.translate(0, 0.3, 0)
  const gm = new THREE.MeshLambertMaterial({ color: 0xffffff })
  noOutline(gm)
  gm.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = world.time
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vec4 wp = instanceMatrix * vec4(0.,0.,0.,1.);
       float sway = sin(uTime*1.6 + wp.x*0.3 + wp.z*0.2) * 0.12 * position.y;
       transformed.x += sway; transformed.z += sway*0.5;`,
    )
  }
  const count = 8000
  const grass = new THREE.InstancedMesh(blade, gm, count)
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const col = new THREE.Color()
  let placed = 0
  // 留 900 根給台地頂
  for (let i = 0; i < count * 2 && placed < count - 900; i++) {
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(rand()) * (CONFIG.worldRadius + 5)
    const x = Math.cos(a) * r, z = Math.sin(a) * r
    if (world.caves.some((c) => Math.hypot(x - c.center.x, z - c.center.z) < c.radius + 1)) continue
    if (Math.hypot(x, z) < 3.2) continue
    const s = 0.6 + rand() * 0.9
    q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.4, rand() * 6, (rand() - 0.5) * 0.4))
    m4.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s))
    grass.setMatrixAt(placed, m4)
    col.setHSL(0.44 + rand() * 0.1, 0.45, 0.16 + rand() * 0.1)
    grass.setColorAt(placed, col)
    placed++
  }
  // 台地頂上也長草
  for (const pl of world.plateaus)
    for (let i = 0; i < 260 && placed < count; i++) {
      const a = rand() * Math.PI * 2, r = 2 + Math.sqrt(rand()) * (pl.radius - 2.5)
      const s = 0.6 + rand() * 0.8
      q.setFromEuler(new THREE.Euler(0, rand() * 6, 0))
      m4.compose(new THREE.Vector3(pl.center.x + Math.cos(a) * r, pl.height, pl.center.z + Math.sin(a) * r), q, new THREE.Vector3(s, s, s))
      grass.setMatrixAt(placed, m4)
      col.setHSL(0.44 + rand() * 0.08, 0.45, 0.18 + rand() * 0.09)
      grass.setColorAt(placed, col)
      placed++
    }
  grass.count = placed
  grass.receiveShadow = true
  world.scene.add(grass)

  // 發光的小花苞
  const flowerColors = [0x8ff8ff, 0xffb0e8, 0xfff0a0]
  for (const fc of flowerColors) {
    const fl = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.1, 0), toon(fc, { outline: false, emissive: fc }), 180)
    for (let i = 0; i < 180; i++) {
      const p = world.freeSpot(0) ?? new THREE.Vector3(999, -5, 0)
      m4.makeTranslation(p.x, 0.35, p.z)
      fl.setMatrixAt(i, m4)
    }
    world.scene.add(fl)
  }
}

// 邊界：一圈巨大蘑菇與遠方的山影
function boundary(world: World) {
  const R = CONFIG.worldRadius
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + rand() * 0.05
    const r = R + 5 + rand() * 6
    giantMushroom(world, Math.cos(a) * r, 0, Math.sin(a) * r, 7 + rand() * 9, [0x3f63c8, 0x6a4fc8, 0x2f8ab0][i % 3], i % 5 === 0)
  }
  const hedge = toon(0x24504a, {})
  for (let i = 0; i < 80; i++) {
    const a = (i / 80) * Math.PI * 2
    const r = R + 4 + rand() * 3
    const b = mesh(new THREE.IcosahedronGeometry(2.6 + rand() * 1.5, 0), hedge, false)
    b.position.set(Math.cos(a) * r, 1.3, Math.sin(a) * r)
    world.scene.add(b)
  }
  const mats = [toon(0x2a3a66, { outline: false }), toon(0x33477a, { outline: false })]
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2 + rand() * 0.1
    const r = 180 + rand() * 40
    const h = 30 + rand() * 50
    const m = new THREE.Mesh(new THREE.ConeGeometry(25 + rand() * 20, h, 6), mats[i % 2])
    m.position.set(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r)
    world.scene.add(m)
  }
  // 遠方的巨型蘑菇剪影
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.3
    const r = 150 + rand() * 30
    giantMushroom(world, Math.cos(a) * r, 0, Math.sin(a) * r, 30 + rand() * 25, 0x2c3f86, true, 3)
  }
}

// ───────────────────────── 零件 ─────────────────────────
// 底面帶放射狀發光菌褶的蘑菇傘（像參考圖的巨大蘑菇）
let gillTex: THREE.CanvasTexture | null = null
function gillTexture() {
  if (gillTex) return gillTex
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128)
  grad.addColorStop(0, '#5a2a10')
  grad.addColorStop(1, '#2a1208')
  g.fillStyle = grad
  g.fillRect(0, 0, 256, 256)
  g.strokeStyle = '#ffd08a'
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2
    g.lineWidth = 1 + (i % 3)
    g.globalAlpha = 0.55 + (i % 4) * 0.12
    g.beginPath()
    g.moveTo(128 + Math.cos(a) * 18, 128 + Math.sin(a) * 18)
    g.lineTo(128 + Math.cos(a + 0.05) * 126, 128 + Math.sin(a + 0.05) * 126)
    g.stroke()
  }
  gillTex = new THREE.CanvasTexture(c)
  gillTex.colorSpace = THREE.SRGBColorSpace
  return gillTex
}

function giantMushroom(world: World, x: number, y: number, z: number, h: number, capColor: number, glow: boolean, scale = 1) {
  const g = new THREE.Group()
  g.position.set(x, y, z)
  const r = (0.25 + h * 0.05) * scale
  const stem = mesh(new THREE.CylinderGeometry(r * 0.75, r * 1.35, h, 8), toon(0xe8d4b4, { emissive: 0x2a1c10 }))
  stem.position.y = h / 2
  stem.rotation.z = (rand() - 0.5) * 0.12
  g.add(stem)
  const capR = (1.3 + h * 0.42) * (scale > 1 ? 0.8 : 1)
  const capG = new THREE.SphereGeometry(capR, 16, 7, 0, Math.PI * 2, 0, Math.PI / 2)
  capG.scale(1, 0.5, 1)
  const cap = mesh(capG, toon(capColor, { emissive: glow ? 0x101840 : 0x05081a }))
  cap.position.y = h
  g.add(cap)
  const gills = mesh(new THREE.CircleGeometry(capR * 0.98, 24), noOutline(new THREE.MeshBasicMaterial({ map: gillTexture(), side: THREE.DoubleSide })), false)
  gills.rotation.x = Math.PI / 2
  gills.position.y = h - 0.02
  g.add(gills)
  // 傘上的淡色斑點
  const spot = toon(0xbfe8ff, { emissive: 0x3a5a80, outline: false })
  for (let i = 0; i < 5; i++) {
    const a = rand() * Math.PI * 2, e = 0.3 + rand() * 0.7
    const d = mesh(new THREE.SphereGeometry(capR * 0.09, 6, 4), spot, false)
    d.position.set(Math.cos(a) * Math.sin(e) * capR * 0.95, h + Math.cos(e) * capR * 0.48, Math.sin(a) * Math.sin(e) * capR * 0.95)
    d.scale.y = 0.4
    g.add(d)
  }
  if (glow && scale === 1) {
    const s = glowSprite(0xffb070, capR * 1.6, 0.35)
    s.position.y = h - 0.4
    g.add(s)
  }
  g.rotation.y = rand() * 6
  world.scene.add(g)
  return g
}

function glowShroom(world: World, x: number, y: number, z: number, s: number, color: number, halo = true) {
  const g = new THREE.Group()
  const stem = mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.45, 6), toon(0xe8e0c8, { outline: false }), false)
  stem.position.y = 0.22
  const cap = mesh(new THREE.SphereGeometry(0.24, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), toon(color, { emissive: color, outline: false }), false)
  cap.position.y = 0.42
  cap.scale.y = 0.7
  g.add(stem, cap)
  if (halo) {
    const h = glowSprite(color, 1.2, 0.5)
    h.position.y = 0.45
    g.add(h)
  }
  g.position.set(x, y, z)
  g.scale.setScalar(s)
  world.scene.add(g)
}

function crystalCluster(world: World, x: number, y: number, z: number, color: number, s: number) {
  const g = new THREE.Group()
  const mat = toon(color, { emissive: color, emissiveIntensity: 0.45, transparent: true, opacity: 0.92 })
  for (let i = 0; i < 5; i++) {
    const h = (0.8 + rand() * 1.4) * (i === 0 ? 1.5 : 1)
    const c = mesh(new THREE.ConeGeometry(0.22 + rand() * 0.12, h, 5), mat, false)
    const a = (i / 5) * Math.PI * 2
    c.position.set(i ? Math.cos(a) * 0.35 : 0, h / 2, i ? Math.sin(a) * 0.35 : 0)
    c.rotation.set(i ? Math.cos(a) * 0.35 : 0, 0, i ? -Math.sin(a) * 0.35 : 0)
    g.add(c)
  }
  const glow = glowSprite(color, 2.4, 0.4)
  glow.position.y = 0.9
  g.add(glow)
  g.position.set(x, y, z)
  g.scale.setScalar(s)
  world.scene.add(g)
}

