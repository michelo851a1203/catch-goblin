import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { createElfLoader } from '../src/game/elf/ElfCharacter'

export const ROOT = resolve(__dirname, '..')
export const ELF_GLB = resolve(ROOT, 'public/models/elf/elf.glb')
export const HARP_GLB = resolve(ROOT, 'public/models/elf/harp.glb')

// Node 沒有 Image / createImageBitmap：以外掛攔截貼圖載入，其餘照真實 GLTFLoader 流程解析
export function parseGlb(file: string) {
  const buf = readFileSync(file)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const loader = createElfLoader()
  // 內建的 EXT_texture_webp 會用 self / Image 偵測瀏覽器支援，Node 沒有；貼圖本來就由下方替身處理
  const internal = loader as unknown as { pluginCallbacks: ((p: unknown) => { name: string })[] }
  internal.pluginCallbacks = internal.pluginCallbacks.filter((cb) => cb({}).name !== 'EXT_texture_webp')
  loader.register(() => ({
    name: 'test_stub_textures',
    loadTexture: () => Promise.resolve(Object.assign(new THREE.Texture(), { name: 'stub' })),
  }))
  return loader.parseAsync(ab, '')
}

// url → 本機檔案
export function fileLoad(url: string) {
  if (url.endsWith('elf.glb')) return parseGlb(ELF_GLB)
  if (url.endsWith('harp.glb')) return parseGlb(HARP_GLB)
  return Promise.reject(new Error(`404 ${url}`))
}

// 模擬現有的程序化模型（createElf 需要 DOM canvas，測試中以替身取代）
export function fakeFallback() {
  const root = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
  root.add(mesh)
  const calls: string[] = []
  return {
    root,
    mesh,
    calls,
    animate: (_dt: number, _m: number, pose: string) => void calls.push(pose),
    setHarp: (on: boolean) => void calls.push(`harp:${on}`),
  }
}
