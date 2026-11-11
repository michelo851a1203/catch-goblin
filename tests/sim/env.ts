// 無頭模擬用的瀏覽器替身：Game 需要 DOM / canvas / window，但測試只關心遊戲邏輯。
// 必須在 import 任何 src 模組之前載入（ESM 依 import 順序執行）。
/* eslint-disable @typescript-eslint/no-explicit-any */
const noop = () => {}

// 任何方法呼叫都回傳另一個萬用替身（漸層、ImageData 等）
function anything(): any {
  const target: any = { measureText: (s: string) => ({ width: String(s).length * 10 }), data: new Uint8ClampedArray(4) }
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : () => anything()),
    set: (t, k, v) => ((t[k] = v), true),
  })
}
const fakeCtx = anything

function fakeEl(tag: string): any {
  return {
    tagName: tag.toUpperCase(),
    width: 300,
    height: 150,
    style: {},
    dataset: {},
    clientWidth: 1280,
    clientHeight: 720,
    getContext: () => fakeCtx(),
    appendChild: noop,
    remove: noop,
    addEventListener: noop,
    removeEventListener: noop,
    requestPointerLock: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  }
}

const g = globalThis as any
const store = new Map<string, string>()
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
}
g.document = {
  hidden: false,
  title: '',
  documentElement: fakeEl('html'),
  pointerLockElement: null,
  createElement: fakeEl,
  addEventListener: noop,
  removeEventListener: noop,
  exitPointerLock: noop,
}
g.window = g
g.addEventListener = noop
g.removeEventListener = noop
g.devicePixelRatio = 1
g.matchMedia = () => ({ matches: false, addEventListener: noop })
g.location = { search: '', hostname: 'test', href: 'http://test/' }
g.Image = class {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  src = ''
}
g.requestAnimationFrame = () => 0
g.cancelAnimationFrame = noop

export function setSearch(search: string) {
  g.location.search = search
}
