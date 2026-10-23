import * as THREE from 'three'

let gradient: THREE.DataTexture | null = null

export function toonGradient(): THREE.DataTexture {
  if (!gradient) {
    gradient = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat)
    gradient.minFilter = THREE.NearestFilter
    gradient.magFilter = THREE.NearestFilter
    gradient.generateMipmaps = false
    gradient.needsUpdate = true
  }
  return gradient
}

const cache = new Map<string, THREE.MeshToonMaterial>()

export function toon(color: number, opts: THREE.MeshToonMaterialParameters & { outline?: boolean } = {}): THREE.MeshToonMaterial {
  const { outline = true, ...rest } = opts
  const key = `${color}|${outline}|${JSON.stringify(rest)}`
  const hit = cache.get(key)
  if (hit) return hit
  const m = new THREE.MeshToonMaterial({ color, gradientMap: toonGradient(), ...rest })
  m.userData.outlineParameters = outline
    ? { thickness: 0.004, color: [0.08, 0.06, 0.05], alpha: 1, visible: true }
    : { visible: false }
  cache.set(key, m)
  return m
}

export function noOutline<T extends THREE.Material>(m: T): T {
  m.userData.outlineParameters = { visible: false }
  return m
}

export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  m.castShadow = shadow
  m.receiveShadow = shadow
  return m
}

// 文字 / emoji 看板用的 canvas 貼圖
// shadow：不描邊，改用柔和陰影維持對比（用於玩家名牌）
export function makeLabelTexture(text: string, opts: { bg?: string; fg?: string; font?: number; w?: number; h?: number; shadow?: boolean } = {}) {
  const { bg = 'rgba(0,0,0,0)', fg = '#fff', font = 64, w = 256, h = 128, shadow = false } = opts
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  g.fillStyle = bg
  if (bg !== 'rgba(0,0,0,0)') {
    const r = 28
    g.beginPath()
    g.roundRect(6, 6, w - 12, h - 12, r)
    g.fill()
    g.lineWidth = 6
    g.strokeStyle = 'rgba(255,255,255,0.9)'
    g.stroke()
  }
  g.font = `bold ${font}px "Noto Sans TC", system-ui, sans-serif`
  // 英文字串較長，超出寬度時縮小字級
  const fit = (w - 24) / g.measureText(text).width
  if (fit < 1) g.font = `bold ${Math.floor(font * fit)}px "Noto Sans TC", system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  if (shadow) {
    g.shadowColor = 'rgba(0,0,0,0.9)'
    g.shadowBlur = font * 0.25
    g.shadowOffsetY = font * 0.05
  } else {
    g.lineWidth = 8
    g.strokeStyle = 'rgba(0,0,0,0.55)'
    g.strokeText(text, w / 2, h / 2 + 4)
  }
  g.fillStyle = fg
  g.fillText(text, w / 2, h / 2 + 4)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export function makeSprite(text: string, scale: number, opts: Parameters<typeof makeLabelTexture>[1] = {}) {
  const mat = new THREE.SpriteMaterial({ map: makeLabelTexture(text, opts), depthTest: false, transparent: true })
  const s = new THREE.Sprite(mat)
  const w = opts.w ?? 256
  const h = opts.h ?? 128
  s.scale.set(scale * (w / h), scale, 1)
  s.renderOrder = 10
  return s
}
