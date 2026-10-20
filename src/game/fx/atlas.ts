import * as THREE from 'three'

// 粒子貼圖集：4 x 2 格，全部畫成白色，讓粒子自行上色
export const CELL = {
  glow: 0,
  sparkle: 1,
  heart: 2,
  note: 3,
  notes: 4,
  smoke: 5,
  leaf: 6,
  star: 7,
} as const

let atlas: THREE.CanvasTexture | null = null
let glowTex: THREE.CanvasTexture | null = null

function drawGlow(g: CanvasRenderingContext2D, s: number) {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  r.addColorStop(0, 'rgba(255,255,255,1)')
  r.addColorStop(0.25, 'rgba(255,255,255,0.75)')
  r.addColorStop(0.6, 'rgba(255,255,255,0.18)')
  r.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = r
  g.fillRect(0, 0, s, s)
}

function drawSparkle(g: CanvasRenderingContext2D, s: number) {
  const c = s / 2
  drawGlowSmall(g, s, 0.35)
  g.fillStyle = '#fff'
  g.beginPath()
  const L = s * 0.48, W = s * 0.06
  g.moveTo(c, c - L)
  g.quadraticCurveTo(c + W, c - W, c + L, c)
  g.quadraticCurveTo(c + W, c + W, c, c + L)
  g.quadraticCurveTo(c - W, c + W, c - L, c)
  g.quadraticCurveTo(c - W, c - W, c, c - L)
  g.fill()
}

function drawGlowSmall(g: CanvasRenderingContext2D, s: number, k: number) {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, (s / 2) * k)
  r.addColorStop(0, 'rgba(255,255,255,0.9)')
  r.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = r
  g.fillRect(0, 0, s, s)
}

function heartPath(g: CanvasRenderingContext2D, cx: number, cy: number, w: number) {
  g.beginPath()
  g.moveTo(cx, cy + w * 0.35)
  g.bezierCurveTo(cx - w * 0.9, cy - w * 0.25, cx - w * 0.45, cy - w * 0.85, cx, cy - w * 0.35)
  g.bezierCurveTo(cx + w * 0.45, cy - w * 0.85, cx + w * 0.9, cy - w * 0.25, cx, cy + w * 0.35)
  g.closePath()
}

function drawHeart(g: CanvasRenderingContext2D, s: number) {
  g.shadowColor = 'rgba(255,255,255,0.9)'
  g.shadowBlur = s * 0.12
  g.fillStyle = '#fff'
  heartPath(g, s / 2, s * 0.55, s * 0.62)
  g.fill()
  g.shadowBlur = 0
}

function drawNote(g: CanvasRenderingContext2D, s: number, double: boolean) {
  g.shadowColor = 'rgba(255,255,255,0.9)'
  g.shadowBlur = s * 0.1
  g.fillStyle = '#fff'
  g.strokeStyle = '#fff'
  g.lineWidth = s * 0.06
  const head = (x: number, y: number) => {
    g.beginPath()
    g.ellipse(x, y, s * 0.12, s * 0.085, -0.45, 0, Math.PI * 2)
    g.fill()
  }
  if (double) {
    head(s * 0.3, s * 0.72)
    head(s * 0.68, s * 0.64)
    g.beginPath()
    g.moveTo(s * 0.4, s * 0.7)
    g.lineTo(s * 0.4, s * 0.22)
    g.lineTo(s * 0.78, s * 0.14)
    g.lineTo(s * 0.78, s * 0.62)
    g.stroke()
    g.lineWidth = s * 0.08
    g.beginPath()
    g.moveTo(s * 0.4, s * 0.25)
    g.lineTo(s * 0.78, s * 0.17)
    g.stroke()
  } else {
    head(s * 0.42, s * 0.72)
    g.beginPath()
    g.moveTo(s * 0.52, s * 0.7)
    g.lineTo(s * 0.52, s * 0.16)
    g.quadraticCurveTo(s * 0.62, s * 0.32, s * 0.78, s * 0.36)
    g.quadraticCurveTo(s * 0.7, s * 0.44, s * 0.56, s * 0.42)
    g.stroke()
  }
}

function drawSmoke(g: CanvasRenderingContext2D, s: number) {
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    const x = s / 2 + Math.cos(a) * s * 0.14
    const y = s / 2 + Math.sin(a) * s * 0.14
    const r = g.createRadialGradient(x, y, 0, x, y, s * 0.3)
    r.addColorStop(0, 'rgba(255,255,255,0.55)')
    r.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = r
    g.fillRect(0, 0, s, s)
  }
}

function drawLeaf(g: CanvasRenderingContext2D, s: number) {
  g.fillStyle = '#fff'
  g.beginPath()
  g.moveTo(s * 0.5, s * 0.08)
  g.bezierCurveTo(s * 0.88, s * 0.3, s * 0.82, s * 0.75, s * 0.5, s * 0.92)
  g.bezierCurveTo(s * 0.18, s * 0.75, s * 0.12, s * 0.3, s * 0.5, s * 0.08)
  g.fill()
  g.strokeStyle = 'rgba(0,0,0,0.25)'
  g.lineWidth = s * 0.025
  g.beginPath()
  g.moveTo(s * 0.5, s * 0.12)
  g.lineTo(s * 0.5, s * 0.88)
  g.stroke()
}

function drawStar(g: CanvasRenderingContext2D, s: number) {
  const c = s / 2
  g.shadowColor = 'rgba(255,255,255,0.9)'
  g.shadowBlur = s * 0.12
  g.fillStyle = '#fff'
  g.beginPath()
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? s * 0.18 : s * 0.42
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2
    g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r)
  }
  g.closePath()
  g.fill()
}

export function particleAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas
  const S = 128
  const c = document.createElement('canvas')
  c.width = S * 4
  c.height = S * 2
  const g = c.getContext('2d')!
  const draws = [
    (x: CanvasRenderingContext2D) => drawGlow(x, S),
    (x: CanvasRenderingContext2D) => drawSparkle(x, S),
    (x: CanvasRenderingContext2D) => drawHeart(x, S),
    (x: CanvasRenderingContext2D) => drawNote(x, S, false),
    (x: CanvasRenderingContext2D) => drawNote(x, S, true),
    (x: CanvasRenderingContext2D) => drawSmoke(x, S),
    (x: CanvasRenderingContext2D) => drawLeaf(x, S),
    (x: CanvasRenderingContext2D) => drawStar(x, S),
  ]
  draws.forEach((d, i) => {
    g.save()
    g.translate((i % 4) * S, Math.floor(i / 4) * S)
    g.beginPath()
    g.rect(0, 0, S, S)
    g.clip()
    d(g)
    g.restore()
  })
  atlas = new THREE.CanvasTexture(c)
  atlas.colorSpace = THREE.SRGBColorSpace
  return atlas
}

export function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex
  const c = document.createElement('canvas')
  c.width = c.height = 128
  drawGlow(c.getContext('2d')!, 128)
  glowTex = new THREE.CanvasTexture(c)
  glowTex.colorSpace = THREE.SRGBColorSpace
  glowTex.userData.cached = true
  return glowTex
}

export function glowSprite(color: number, size: number, opacity = 0.8) {
  const m = new THREE.SpriteMaterial({
    map: glowTexture(),
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const s = new THREE.Sprite(m)
  s.scale.setScalar(size)
  return s
}
