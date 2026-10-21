import * as THREE from 'three'

const TEXTURE_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'gradientMap'] as const

// 釋放物件樹底下的幾何、材質、貼圖與骨架；回傳釋放數量方便測試
export function disposeObject(root: THREE.Object3D, opts: { materials?: boolean } = {}) {
  const { materials = true } = opts
  const geos = new Set<THREE.BufferGeometry>()
  const mats = new Set<THREE.Material>()
  const texs = new Set<THREE.Texture>()
  const skeletons = new Set<THREE.Skeleton>()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) geos.add(m.geometry)
    const sk = (o as THREE.SkinnedMesh).skeleton
    if (sk) skeletons.add(sk)
    if (!materials || !m.material) return
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      mats.add(mat)
      const rec = mat as unknown as Record<string, unknown>
      for (const k of TEXTURE_KEYS) {
        const t = rec[k]
        if (t instanceof THREE.Texture) texs.add(t)
      }
    }
  })
  geos.forEach((g) => g.dispose())
  mats.forEach((m) => m.dispose())
  texs.forEach((t) => t.dispose())
  skeletons.forEach((s) => s.dispose())
  return { geometries: geos.size, materials: mats.size, textures: texs.size, skeletons: skeletons.size }
}
