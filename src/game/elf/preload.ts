import type { ElfKind } from '../config'
import { rigOf } from './rigs'

// 精靈模型預先下載：選角畫面就開始在背景下載 GLB，開局時直接解析，倒數前就能顯示正確的角色。
// 只快取下載的位元組：每局各自解析成新的場景，上一局結束時才能完整釋放（幾何、貼圖不共用）
const cache = new Map<string, Promise<ArrayBuffer>>()

export function fetchModel(url: string): Promise<ArrayBuffer> {
  const hit = cache.get(url)
  if (hit) return hit
  const p = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
    return r.arrayBuffer()
  })
  cache.set(url, p)
  // 失敗（離線、iOS 切到背景時網路被暫停）就移除，下次重新下載
  p.catch(() => {
    if (cache.get(url) === p) cache.delete(url)
  })
  return p
}

// 依序下載（先下載的角色先可用），失敗不影響遊戲：開局時會再試一次
export async function preloadElves(kinds: readonly ElfKind[]) {
  for (const kind of kinds) {
    const rig = rigOf(kind)
    await Promise.all([rig.url, rig.propUrl].filter((u): u is string => !!u).map((u) => fetchModel(u).catch(() => {})))
  }
}
