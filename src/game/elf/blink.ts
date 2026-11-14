import * as THREE from 'three'

// 眨眼：兩個精靈的 GLB 都沒有眼皮骨骼 / morph target，眼睛畫在貼圖上，貼圖集又是自動展開的碎片 UV，
// 所以改在著色器中以「綁定姿勢的模型座標」框出眼睛：橢圓範圍內由上往下蓋上眼皮膚色，眼皮邊緣畫一道睫毛線。
// 綁定座標不受骨架動畫影響，頭怎麼轉眼皮都貼在眼睛上。眼睛位置以正面正交視角量測（見 rigs.ts 的 blink 設定）
export interface EyeDef {
  // 綁定姿勢中的眼睛中心與半徑（公尺）：x 為寬、y 為高、z 為前後容許範圍（排除後腦勺的頭髮）
  center: readonly [number, number, number]
  radius: readonly [number, number, number]
}

export interface BlinkSpec {
  eyes: readonly [EyeDef, EyeDef]
  // 眼皮膚色與睫毛線顏色（sRGB）
  skin: number
  lash: number
}

const v3 = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2])

// 套用到角色的貼圖集材質；回傳的 uniform 由 BlinkTimer 驅動（0 = 張開、1 = 閉上）
export function applyBlink(mat: THREE.MeshStandardMaterial, spec: BlinkSpec) {
  const existing = mat.userData.blink as { value: number } | undefined
  if (existing) return existing
  const uBlink = { value: 0 }
  mat.userData.blink = uBlink
  const [L, R] = spec.eyes
  const uniforms = {
    uBlink,
    uEyeC0: { value: v3(L.center) },
    uEyeR0: { value: v3(L.radius) },
    uEyeC1: { value: v3(R.center) },
    uEyeR1: { value: v3(R.radius) },
    uLidSkin: { value: new THREE.Color().setHex(spec.skin, THREE.SRGBColorSpace) },
    uLidLash: { value: new THREE.Color().setHex(spec.lash, THREE.SRGBColorSpace) },
  }
  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBindPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBindPos = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vBindPos;
uniform float uBlink;
uniform vec3 uEyeC0, uEyeR0, uEyeC1, uEyeR1, uLidSkin, uLidLash;
void lidCover( inout vec3 col, vec3 c, vec3 r ) {
	vec3 q = ( vBindPos - c ) / r;
	float d = length( q.xy );
	if ( abs( q.z ) > 1.0 || d > 1.0 ) return;
	// 眼皮從上緣（q.y = 1）往下蓋，閉眼時停在下眼瞼（約 -0.65）、兩端微微上揚（‿ 形）
	float lid = mix( 1.08, -0.66, uBlink ) + 0.3 * q.x * q.x * uBlink;
	float fade = smoothstep( 1.0, 0.8, d );
	float cover = smoothstep( lid - 0.05, lid + 0.05, q.y ) * fade;
	// 靠近睫毛的眼皮略暗，像眼窩的陰影
	vec3 skin = uLidSkin * mix( 0.9, 1.0, smoothstep( lid, lid + 0.6, q.y ) );
	col = mix( col, skin, cover );
	float lash = ( 1.0 - smoothstep( 0.04, 0.16, abs( q.y - lid ) ) ) * smoothstep( 0.2, 0.6, uBlink ) * smoothstep( 1.0, 0.7, d );
	col = mix( col, uLidLash, lash );
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
if ( uBlink > 0.001 ) {
	lidCover( diffuseColor.rgb, uEyeC0, uEyeR0 );
	lidCover( diffuseColor.rgb, uEyeC1, uEyeR1 );
}`,
      )
    // 自發光以貼圖本身提亮（見 optimizeMaterial）：閉眼時自發光貼圖的取樣也換成眼皮，否則眼睛會從眼皮底下透出來
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      THREE.ShaderChunk.emissivemap_fragment.replace(
        'totalEmissiveRadiance *= emissiveColor.rgb;',
        `if ( uBlink > 0.001 ) {
		lidCover( emissiveColor.rgb, uEyeC0, uEyeR0 );
		lidCover( emissiveColor.rgb, uEyeC1, uEyeR1 );
	}
	totalEmissiveRadiance *= emissiveColor.rgb;`,
      ),
    )
  }
  const prevKey = mat.customProgramCacheKey.bind(mat)
  mat.customProgramCacheKey = () => `${prevKey()}|blink`
  mat.needsUpdate = true
  return uBlink
}

// 眨眼節奏：每 2～5.5 秒眨一次，偶爾連眨兩下；閉眼快、睜眼稍慢
export class BlinkTimer {
  private wait: number
  private t = -1
  private double = false
  private random: () => number

  constructor(random: () => number = Math.random) {
    this.random = random
    this.wait = 1 + random() * 2
  }

  // 回傳這一幀的閉眼程度 0～1
  update(dt: number) {
    if (this.t < 0) {
      this.wait -= dt
      if (this.wait > 0) return 0
      this.t = 0
    }
    this.t += dt
    const CLOSE = 0.07, HOLD = 0.04, OPEN = 0.12
    const t = this.t
    let k: number
    if (t < CLOSE) k = t / CLOSE
    else if (t < CLOSE + HOLD) k = 1
    else if (t < CLOSE + HOLD + OPEN) k = 1 - (t - CLOSE - HOLD) / OPEN
    else {
      k = 0
      this.t = -1
      // 兩成機率緊接著再眨一次
      if (!this.double && this.random() < 0.2) {
        this.double = true
        this.wait = 0.12
      } else {
        this.double = false
        this.wait = 2 + this.random() * 3.5
      }
    }
    // ease：眼皮在兩端放慢
    return k * k * (3 - 2 * k)
  }
}
