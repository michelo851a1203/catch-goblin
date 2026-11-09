import * as THREE from 'three'

// 角色用的 cel shading：在 MeshStandardMaterial 上改寫直射光的漫射項，保留 PBR 的環境光 / 反射與陰影貼圖。
//  - 直射光的明暗以 smoothstep 分成「亮面 / 暗面」兩階，交界帶一點柔邊（放大看不會鋸齒）
//  - 臉部（頂點屬性 _facemask，build_violinist.py 產生）：暗面提亮、交界更柔，並略過自身陰影貼圖，
//    避免頭髮 / 瀏海投在臉上的斑駁陰影與陰影粉刺；臉部法線已在 Blender 中往頭部橢球混合，明暗交界是乾淨的大塊形狀
export interface CelParams {
  // 明暗交界位置（N·L）與柔邊寬度
  edge: number
  soft: number
  // 亮面的 N·L 等效值（PBR 中正對光源 = 1）與暗面亮度（相對亮面）
  lit: number
  shade: number
  // 臉部的暗面亮度、柔邊寬度、陰影貼圖保留比例
  faceShade: number
  faceSoft: number
  faceShadow: number
}

export const CEL_DEFAULTS: CelParams = {
  edge: 0.12,
  soft: 0.06,
  lit: 0.6,
  shade: 0.55,
  faceShade: 0.8,
  faceSoft: 0.22,
  faceShadow: 0.15,
}

// 以正規表示式比對（容許空白差異：three 的發佈版本會壓縮 shader chunk 中的空行）
const ws = (src: string) => new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'))
const DIFFUSE_SRC = ws('float dotNL = saturate( dot( geometryNormal, directLight.direction ) ); vec3 irradiance = dotNL * directLight.color;')
const SHADOW_SRC = ws(
  'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;',
)
const DIR_INFO_SRC = 'getDirectionalLightInfo( directionalLight, directLight );'

// three.js 升級後 shader chunk 文字可能改變：找不到要改寫的片段時不套用（維持原本的 PBR），由測試把關
export function celChunksAvailable() {
  const begin = THREE.ShaderChunk.lights_fragment_begin
  return DIFFUSE_SRC.test(THREE.ShaderChunk.lights_physical_pars_fragment) && SHADOW_SRC.test(begin) && begin.includes(DIR_INFO_SRC)
}

const fnum = (x: number) => x.toFixed(4)

export function applyCelShading(mat: THREE.MeshStandardMaterial, params: Partial<CelParams> = {}) {
  if (mat.userData.cel || !celChunksAvailable()) return false
  const p = { ...CEL_DEFAULTS, ...params }
  mat.userData.cel = p
  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float _facemask;\nvarying float vFaceMask;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFaceMask = _facemask;')
    const pars = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
      DIFFUSE_SRC,
      // 亮面 = lit、暗面 = lit × shade；陰影貼圖（celShadowK）併入同一個明暗階，影子裡 = 暗面，不會疊加變得更黑
      `float ndl = dot( geometryNormal, directLight.direction );
	float celSoft = mix( ${fnum(p.soft)}, ${fnum(p.faceSoft)}, vFaceMask );
	float celBand = smoothstep( ${fnum(p.edge)} - celSoft, ${fnum(p.edge)} + celSoft, ndl ) * celShadowK;
	float dotNL = mix( mix( ${fnum(p.shade)}, ${fnum(p.faceShade)}, vFaceMask ), 1.0, celBand ) * ${fnum(p.lit)};
	vec3 irradiance = dotNL * directLight.color;`,
    )
    const begin = THREE.ShaderChunk.lights_fragment_begin.replace(
      SHADOW_SRC,
      // 平行光（太陽）的陰影貼圖：不直接乘在光色上，改存進 celShadowK 交給 RE_Direct 併入明暗階；
      // PCF 的灰階漸層收窄成柔邊，臉上幾乎略過（頭髮投影 / 陰影粉刺）。
      // 每個平行光先重設為 1（沒有陰影貼圖的平行光不沿用上一盞的值）；平行光迴圈在點光源 / 聚光燈之後，
      // 其後的光源（面光、半球光）不經過 RE_Direct，不受影響
      `{
			float celSh = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
			celShadowK = mix( smoothstep( 0.3, 0.7, celSh ), 1.0, vFaceMask * ( 1.0 - ${fnum(p.faceShadow)} ) );
		}`,
    ).replace(DIR_INFO_SRC, `${DIR_INFO_SRC}\n\t\tcelShadowK = 1.0;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFaceMask;\nfloat celShadowK = 1.0;')
      .replace('#include <lights_physical_pars_fragment>', pars)
      .replace('#include <lights_fragment_begin>', begin)
  }
  const prevKey = mat.customProgramCacheKey.bind(mat)
  mat.customProgramCacheKey = () => `${prevKey()}|cel:${Object.values(p).join(',')}`
  mat.needsUpdate = true
  return true
}
