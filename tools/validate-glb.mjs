// 驗證角色 GLB：結構、貼圖、材質、骨架、動畫、尺寸與朝向
// 用法：node tools/validate-glb.mjs public/models/elf/elf.glb [--expect-anims Idle,Walk,...] [--expect-bones a,b]
import { readFileSync } from 'node:fs'

export function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB (bad magic)')
  if (dv.getUint32(4, true) !== 2) throw new Error('unsupported glTF version')
  if (dv.getUint32(8, true) !== buf.byteLength) throw new Error('length header mismatch')
  let off = 12
  let json = null
  let bin = null
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const chunk = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk))
    else if (type === 0x004e4942) bin = chunk
    off += 8 + len
  }
  if (!json) throw new Error('missing JSON chunk')
  return { json, bin }
}

export function inspectGlb(buf) {
  const { json, bin } = parseGlb(buf)
  const errors = []
  const acc = json.accessors ?? []
  const views = json.bufferViews ?? []
  for (const [i, v] of views.entries()) {
    // EXT_meshopt_compression 的 fallback buffer 沒有實際資料，只檢查內嵌的 buffer 0
    if ((v.buffer ?? 0) !== 0) continue
    if (bin && (v.byteOffset ?? 0) + v.byteLength > bin.byteLength) errors.push(`bufferView ${i} out of range`)
  }
  for (const [i, img] of (json.images ?? []).entries()) {
    if (img.bufferView === undefined && !img.uri) errors.push(`image ${i} has no data`)
    if (img.bufferView !== undefined) {
      const v = views[img.bufferView]
      const head = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + 4)
      const png = head[0] === 0x89 && head[1] === 0x50
      const jpg = head[0] === 0xff && head[1] === 0xd8
      const webp = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 // RIFF
      if (!png && !jpg && !webp) errors.push(`image ${i} (${img.name}) is not PNG/JPEG/WebP`)
    }
  }
  // 世界尺寸：所有 POSITION accessor 的 min/max（glTF 為 Y-up、+Z 為正面）
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const m of json.meshes ?? []) {
    for (const p of m.primitives) {
      const a = acc[p.attributes.POSITION]
      if (!a?.min) continue
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], a.min[k])
        max[k] = Math.max(max[k], a.max[k])
      }
      if (p.material === undefined) errors.push(`mesh ${m.name} has a primitive without material`)
    }
  }
  const texturedMaterials = (json.materials ?? []).filter((m) => m.pbrMetallicRoughness?.baseColorTexture).map((m) => m.name)
  const nodes = json.nodes ?? []
  return {
    errors,
    meshes: (json.meshes ?? []).map((m) => ({ name: m.name, primitives: m.primitives.length })),
    materials: (json.materials ?? []).map((m) => m.name),
    texturedMaterials,
    images: (json.images ?? []).map((i) => i.name),
    skins: (json.skins ?? []).map((s) => ({ name: s.name, joints: s.joints.length })),
    bones: (json.skins ?? []).flatMap((s) => s.joints.map((j) => nodes[j].name)),
    nodes: nodes.map((n) => n.name),
    animations: (json.animations ?? []).map((a) => ({ name: a.name, channels: a.channels.length })),
    bounds: { min, max, size: max.map((v, k) => v - min[k]) },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2]
  const flag = (name) => {
    const i = process.argv.indexOf(name)
    return i > 0 ? process.argv[i + 1].split(',') : []
  }
  const r = inspectGlb(readFileSync(file))
  const missingAnims = flag('--expect-anims').filter((n) => !r.animations.some((a) => a.name === n))
  const missingNodes = flag('--expect-nodes').filter((n) => !r.nodes.includes(n))
  if (missingAnims.length) r.errors.push(`missing animations: ${missingAnims.join(', ')}`)
  if (missingNodes.length) r.errors.push(`missing nodes: ${missingNodes.join(', ')}`)
  console.log(JSON.stringify({ ...r, bones: r.bones.length, nodes: r.nodes.length }, null, 2))
  if (r.errors.length) {
    console.error('FAILED:\n- ' + r.errors.join('\n- '))
    process.exit(1)
  }
  console.log('OK', file)
}
