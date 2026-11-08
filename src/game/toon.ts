import * as THREE from 'three'
import { icon, splitIcon } from '../icons'

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
  // 開頭的 emoji 換成遊戲圖示（圖片非同步載入，載入後重畫）
  const parts = splitIcon(text)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const draw = (img: HTMLImageElement | null) => {
    g.clearRect(0, 0, w, h)
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
    const label = parts.text
    // 只有圖示：置中放大
    const iconSize = label ? h * 0.66 : Math.min(w, h) * 0.92
    const gap = label && parts.icon ? h * 0.08 : 0
    g.font = `bold ${font}px "Noto Sans TC", system-ui, sans-serif`
    const room = w - 24 - (parts.icon && label ? iconSize + gap : 0)
    // 英文字串較長，超出寬度時縮小字級
    const fit = label ? room / g.measureText(label).width : 1
    if (fit < 1) g.font = `bold ${Math.floor(font * fit)}px "Noto Sans TC", system-ui, sans-serif`
    const tw = label ? g.measureText(label).width : 0
    const total = (parts.icon ? iconSize + gap : 0) + tw
    let x = w / 2 - total / 2
    if (parts.icon && img) g.drawImage(img, x, h / 2 - iconSize / 2 + 2, iconSize, iconSize)
    if (parts.icon) x += iconSize + gap
    if (label) {
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      if (shadow) {
        g.shadowColor = 'rgba(0,0,0,0.9)'
        g.shadowBlur = font * 0.25
        g.shadowOffsetY = font * 0.05
      } else {
        g.lineWidth = 8
        g.strokeStyle = 'rgba(0,0,0,0.55)'
        g.strokeText(label, x, h / 2 + 4)
      }
      g.fillStyle = fg
      g.fillText(label, x, h / 2 + 4)
      g.shadowColor = 'transparent'
    }
    tex.needsUpdate = true
  }
  draw(null)
  if (parts.icon) {
    const img = new Image()
    img.onload = () => draw(img)
    img.src = icon(parts.icon)
  }
  return tex
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
