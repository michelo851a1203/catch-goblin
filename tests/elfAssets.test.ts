import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 純 JS 工具腳本，無型別宣告
import { inspectGlb } from '../tools/validate-glb.mjs'
import { ELF_CLIPS, ELF_NODES } from '../src/game/elf/assets'
import { ELF_GLB, HARP_GLB } from './helpers'

describe('GLB 資源驗證', () => {
  const elf = inspectGlb(readFileSync(ELF_GLB))
  const harp = inspectGlb(readFileSync(HARP_GLB))

  it('結構無錯誤', () => {
    expect(elf.errors).toEqual([])
    expect(harp.errors).toEqual([])
  })

  it('包含清單上的所有動作', () => {
    const names = elf.animations.map((a: { name: string }) => a.name)
    for (const c of ELF_CLIPS) expect(names).toContain(c)
  })

  it('包含 LOD 網格、骨架與豎琴掛點', () => {
    expect(elf.skins).toHaveLength(1)
    for (const n of [...ELF_NODES.lod, ELF_NODES.harpSocket, 'hand.L', 'hair_C1', 'skirt_F1']) expect(elf.nodes).toContain(n)
  })

  it('貼圖與材質都內嵌', () => {
    expect(elf.images).toEqual(expect.arrayContaining(['elf_face', 'elf_hair', 'elf_skirt', 'elf_overskirt']))
    expect(elf.texturedMaterials).toEqual(expect.arrayContaining(['M_Face', 'M_Hair', 'M_Dress', 'M_Overskirt']))
    expect(harp.images).toContain('harp_wood')
  })

  it('尺寸：角色約 1.75m、站在 y=0；豎琴約 0.5m', () => {
    expect(elf.bounds.size[1]).toBeGreaterThan(1.6)
    expect(elf.bounds.size[1]).toBeLessThan(1.9)
    expect(Math.abs(elf.bounds.min[1])).toBeLessThan(0.02)
    expect(harp.bounds.size[1]).toBeGreaterThan(0.4)
    expect(harp.bounds.size[1]).toBeLessThan(0.6)
  })
})
