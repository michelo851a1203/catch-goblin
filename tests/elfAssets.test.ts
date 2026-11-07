import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 純 JS 工具腳本，無型別宣告
import { inspectGlb } from '../tools/validate-glb.mjs'
import { ELF_CLIPS, ELF_NODES, ELF_SPRING_CHAINS } from '../src/game/elf/assets'
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
    for (const chains of Object.values(ELF_SPRING_CHAINS)) for (const c of chains) for (const b of c) expect(elf.bones).toContain(b.replace(/(L|R)$/, '.$1').replace(/^(hair|skirt)_(.*)\.(L|R)$/, '$1_$2$3'))
  })

  it('貼圖與材質都內嵌', () => {
    // Meshy 模型：單一貼圖集（BaseColor + 金屬度 / 粗糙度）
    expect(elf.images).toEqual(expect.arrayContaining(['elf_color', 'elf_orm']))
    expect(elf.texturedMaterials).toEqual(['M_Elf'])
    expect(harp.images).toContain('harp_color')
    expect(harp.texturedMaterials).toEqual(['M_HarpWood'])
  })

  it('尺寸：角色約 1.75m、站在 y=0；豎琴約 0.5m', () => {
    expect(elf.bounds.size[1]).toBeGreaterThan(1.6)
    expect(elf.bounds.size[1]).toBeLessThan(1.9)
    expect(Math.abs(elf.bounds.min[1])).toBeLessThan(0.02)
    expect(harp.bounds.size[1]).toBeGreaterThan(0.4)
    expect(harp.bounds.size[1]).toBeLessThan(0.6)
  })
})
