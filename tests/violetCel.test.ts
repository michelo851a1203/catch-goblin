import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { ElfCharacter } from '../src/game/elf/ElfCharacter'
import { applyCelShading, celChunksAvailable } from '../src/game/elf/celShading'
import { VIOLINIST_RIG } from '../src/game/elf/rigs'
import { fileLoad, parseGlb, VIOLINIST_GLB } from './helpers'

function violetMaterials(root: THREE.Object3D) {
  const mats = new Set<THREE.MeshStandardMaterial>()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && (m.material as THREE.Material).name === 'M_Violet') mats.add(m.material as THREE.MeshStandardMaterial)
  })
  return [...mats]
}

describe('紫晶精靈模型（build_violinist.py 輸出）', () => {
  it('網格已焊接（不是三角形湯）且頭部已細分', async () => {
    const gltf = await parseGlb(VIOLINIST_GLB)
    const lod0 = gltf.scene.getObjectByName('VioletMesh_LOD0') as THREE.SkinnedMesh
    const geo = lod0.geometry
    const tris = geo.index!.count / 3
    // 三角形湯：頂點數 ≈ 三角形數 × 2；焊接後只在 UV 接縫分裂
    expect(geo.attributes.position.count / tris).toBeLessThan(1.6)
    expect(tris).toBeGreaterThan(38000)
    // 高模烘焙的法線貼圖 + MikkTSpace 切線（沒有切線時 three 改用螢幕空間導數，與烘焙不一致）
    expect((lod0.material as THREE.MeshStandardMaterial).normalMap).toBeTruthy()
    expect(geo.getAttribute('tangent')).toBeTruthy()
  })

  it('LOD0 / LOD1 都帶有臉部遮罩 _facemask，且臉上有完整遮罩的頂點', async () => {
    const gltf = await parseGlb(VIOLINIST_GLB)
    for (const name of ['VioletMesh_LOD0', 'VioletMesh_LOD1']) {
      const mesh = gltf.scene.getObjectByName(name) as THREE.Mesh
      const attr = mesh.geometry.getAttribute('_facemask')
      expect(attr, name).toBeTruthy()
      let full = 0
      for (let i = 0; i < attr.count; i++) if (attr.getX(i) > 0.9) full++
      expect(full, name).toBeGreaterThan(50)
    }
  })
})

describe('cel shading', () => {
  it('目前 three.js 的 shader chunk 含有要改寫的片段（升級 three 時把關）', () => {
    expect(celChunksAvailable()).toBe(true)
  })

  it('改寫後的 shader 宣告臉部遮罩並取代直射光漫射 / 平行光陰影', () => {
    const mat = new THREE.MeshStandardMaterial()
    expect(applyCelShading(mat)).toBe(true)
    expect(applyCelShading(mat)).toBe(false) // 不重複套用
    const shader = {
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      uniforms: {},
    } as unknown as THREE.WebGLProgramParametersWithUniforms
    mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    expect(shader.vertexShader).toContain('vFaceMask = _facemask;')
    expect(shader.vertexShader).toContain('mvPosition.xyz * 0.9960')
    expect(shader.fragmentShader).toContain('celBand')
    expect(shader.fragmentShader).toContain('celShadowK = mix(')
    expect(shader.fragmentShader).toContain('nonPerturbedNormal, vFaceMask')
    expect(shader.fragmentShader).not.toContain('#include <lights_physical_pars_fragment>')
    expect(mat.customProgramCacheKey()).toContain('cel:')
  })

  it('紫晶精靈載入後貼圖集材質套用 cel shading，並換上高解析貼圖', async () => {
    const hi = new THREE.Texture()
    const hiN = new THREE.Texture()
    const urls: string[] = []
    const elf = new ElfCharacter({
      rig: VIOLINIST_RIG,
      load: fileLoad,
      lowEnd: false,
      loadTexture: (url) => (urls.push(url), Promise.resolve(url === VIOLINIST_RIG.hiResNormal ? hiN : hi)),
    })
    await elf.ready
    await new Promise((r) => setTimeout(r, 0))
    expect(urls.sort()).toEqual([VIOLINIST_RIG.hiResMap, VIOLINIST_RIG.hiResNormal].sort())
    expect([...elf.hiResLoaded].sort()).toEqual(['map', 'normalMap'])
    const mats = violetMaterials(elf.root)
    expect(mats.length).toBeGreaterThan(0)
    // 取樣設定沿用 GLB 貼圖（瀏覽器中 glTF 貼圖 flipY = false；測試替身貼圖是 three 的預設值）
    expect(hi.flipY).toBe(new THREE.Texture().flipY)
    for (const m of mats) {
      expect(m.userData.cel).toBeTruthy()
      expect(m.map).toBe(hi)
      expect(m.emissiveMap).toBe(hi)
      expect(m.normalMap).toBe(hiN)
      expect(hiN.colorSpace).toBe(THREE.NoColorSpace)
      expect(hi.colorSpace).toBe(THREE.SRGBColorSpace)
    }
    elf.dispose()
  })

  it('低階裝置不載入高解析貼圖；載入失敗時沿用 GLB 貼圖', async () => {
    const urls: string[] = []
    const low = new ElfCharacter({ rig: VIOLINIST_RIG, load: fileLoad, lowEnd: true, loadTexture: (u) => (urls.push(u), Promise.resolve(new THREE.Texture())) })
    await low.ready
    expect(urls).toEqual([])
    low.dispose()

    const fail = new ElfCharacter({ rig: VIOLINIST_RIG, load: fileLoad, lowEnd: false, loadTexture: () => Promise.reject(new Error('404')) })
    await fail.ready
    const before = violetMaterials(fail.root)[0].map
    await new Promise((r) => setTimeout(r, 0))
    expect(fail.hiResLoaded.size).toBe(0)
    expect(violetMaterials(fail.root)[0].map).toBe(before)
    fail.dispose()
  })
})
