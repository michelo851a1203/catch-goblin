// 跨平台結果一致的數學函式（golden master 用）。
// V8 內建的 Math.sin / cos / atan2 / pow / exp / log… 在 arm64 與 x64 上會差最後一個位元
// （編譯器在 arm64 把乘加合併成 FMA），整場對局累積下來雜湊就完全不同：本機（Apple Silicon）產生的 golden 到 CI（x64）會全數失敗。
// 這裡只用 + - * / 與 Math.sqrt（IEEE 754 規定必須正確捨入，JS 引擎也不會自行合併乘加）重新實作，
// 演算法與係數取自 fdlibm，精度與內建版本相差在數個 ulp 以內（見 tests/detMath.test.ts）。

const f64 = new Float64Array(1)
const u32 = new Uint32Array(f64.buffer)
// 小端序（x64 / arm64 皆是）：高 32 位元在索引 1
const HI = 1

// x * 2^k（k 為整數），乘以 2 的次方是精確的
const TWO54 = 18014398509481984
function scalb(x: number, k: number) {
  while (k > 1000) {
    x *= 1.0715086071862673e301 // 2^1000
    k -= 1000
  }
  while (k < -1000) {
    x *= 9.332636185032189e-302 // 2^-1000
    k += 1000
  }
  u32[0] = 0
  u32[HI] = (0x3ff + k) << 20
  return x * f64[0]
}

// ───── sin / cos / tan ─────
const PIO2_1 = 1.5707963267341256 // π/2 的前 33 位元
const PIO2_2 = 6.077100506303966e-11
const PIO2_2T = 2.0222662487959506e-21
const INV_PIO2 = 0.6366197723675814
const TWO_PI = 6.283185307179586
const S1 = -1.66666666666666324348e-1, S2 = 8.33333333332248946124e-3, S3 = -1.98412698298579493134e-4
const S4 = 2.75573137070700676789e-6, S5 = -2.50507602534068634195e-8, S6 = 1.58969099521155010221e-10
const C1 = 4.16666666666666019037e-2, C2 = -1.38888888888741095749e-3, C3 = 2.48015872894767294178e-5
const C4 = -2.75573143513906633035e-7, C5 = 2.0875723212981748279e-9, C6 = -1.13596475577881948265e-11

function kSin(x: number, y: number) {
  const z = x * x
  const v = z * x
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
  return x - (z * (0.5 * y - v * r) - y - v * S1)
}
function kCos(x: number, y: number) {
  const z = x * x
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))))
  const hz = 0.5 * z
  const w = 1 - hz
  return w + (1 - w - hz + (z * r - x * y))
}

// 把 x 化約到 [-π/4, π/4]：回傳象限，餘數放在 remHi / remLo
let remHi = 0
let remLo = 0
function reduce(x: number) {
  // 極大的角度先粗略取餘數（遊戲不會用到，只求結果固定）
  if (x > 1e6 || x < -1e6) x %= TWO_PI
  const n = Math.round(x * INV_PIO2)
  const t = x - n * PIO2_1
  let w = n * PIO2_2
  const r = t - w
  w = n * PIO2_2T - (t - r - w)
  remHi = r - w
  remLo = r - remHi - w
  return n & 3
}

export function sin(x: number) {
  if (!(x - x === 0)) return NaN
  if (x === 0) return x
  if (x < 0.7853981633974483 && x > -0.7853981633974483) return kSin(x, 0)
  switch (reduce(x)) {
    case 0: return kSin(remHi, remLo)
    case 1: return kCos(remHi, remLo)
    case 2: return -kSin(remHi, remLo)
    default: return -kCos(remHi, remLo)
  }
}
export function cos(x: number) {
  if (!(x - x === 0)) return NaN
  if (x < 0.7853981633974483 && x > -0.7853981633974483) return kCos(x, 0)
  switch (reduce(x)) {
    case 0: return kCos(remHi, remLo)
    case 1: return -kSin(remHi, remLo)
    case 2: return -kCos(remHi, remLo)
    default: return kSin(remHi, remLo)
  }
}
export function tan(x: number) {
  if (x === 0) return x
  return sin(x) / cos(x)
}

// ───── atan / atan2 / asin / acos ─────
const PI = 3.141592653589793
const PI_LO = 1.2246467991473532e-16
const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.570796326794896558]
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17]
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.1111110405462355788e-1, 9.09088713343650656196e-2,
  -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2, 4.97687799461593236017e-2, -3.6531572744216915527e-2,
  1.62858201153657823623e-2,
]

export function atan(x: number) {
  if (x !== x) return NaN
  if (x === 0) return x
  const neg = x < 0
  let a = neg ? -x : x
  if (a >= 73786976294838210000) return neg ? -ATAN_HI[3] : ATAN_HI[3] // |x| ≥ 2^66
  let id = -1
  if (a >= 0.4375) {
    if (a < 1.1875) {
      if (a < 0.6875) {
        id = 0
        a = (2 * a - 1) / (2 + a)
      } else {
        id = 1
        a = (a - 1) / (a + 1)
      }
    } else if (a < 2.4375) {
      id = 2
      a = (a - 1.5) / (1 + 1.5 * a)
    } else {
      id = 3
      a = -1 / a
    }
  }
  const z = a * a
  const w = z * z
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))))
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))))
  if (id < 0) return neg ? -(a - a * (s1 + s2)) : a - a * (s1 + s2)
  const r = ATAN_HI[id] - (a * (s1 + s2) - ATAN_LO[id] - a)
  return neg ? -r : r
}

const nativeAtan2 = Math.atan2
export function atan2(y: number, x: number) {
  // 0、無限大、NaN 的結果都是固定常數，沿用內建的
  if (!(x - x === 0) || !(y - y === 0) || x === 0 || y === 0) return nativeAtan2(y, x)
  const z = atan(Math.abs(y / x))
  if (x > 0) return y < 0 ? -z : z
  const r = PI - (z - PI_LO)
  return y < 0 ? -r : r
}
export function asin(x: number) {
  if (x === 0) return x
  if (!(x >= -1 && x <= 1)) return NaN
  return atan2(x, Math.sqrt((1 - x) * (1 + x)))
}
export function acos(x: number) {
  if (!(x >= -1 && x <= 1)) return NaN
  if (x === 1) return 0
  return atan2(Math.sqrt((1 - x) * (1 + x)), x)
}

// ───── exp / log / pow ─────
const LN2_HI = 6.9314718036912381649e-1
const LN2_LO = 1.90821492927058770002e-10
const INV_LN2 = 1.4426950408889634
const P1 = 1.66666666666666019037e-1, P2 = -2.77777777770155933842e-3, P3 = 6.61375632143793436117e-5
const P4 = -1.6533902205465251539e-6, P5 = 4.13813679705723846039e-8

export function exp(x: number) {
  if (x !== x) return NaN
  if (x > 709.782712893384) return Infinity
  if (x < -745.1332191019411) return 0
  const k = Math.round(x * INV_LN2)
  const hi = x - k * LN2_HI
  const lo = k * LN2_LO
  const r = hi - lo
  const t = r * r
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
  const y = 1 - (lo - (r * c) / (2 - c) - hi)
  return k === 0 ? y : scalb(y, k)
}

const LG1 = 6.66666666666673513e-1, LG2 = 3.999999999940941908e-1, LG3 = 2.857142874366239149e-1, LG4 = 2.222219843214978396e-1
const LG5 = 1.818357216161805012e-1, LG6 = 1.531383769920937332e-1, LG7 = 1.479819860511658591e-1

export function log(x: number) {
  if (x !== x || x < 0) return NaN
  if (x === 0) return -Infinity
  if (x === Infinity) return Infinity
  let k = 0
  f64[0] = x
  if (u32[HI] < 0x00100000) {
    // 次正規數
    f64[0] = x * TWO54
    k = -54
  }
  const hx = u32[HI]
  k += (hx >>> 20) - 1023
  u32[HI] = (hx & 0x000fffff) | 0x3ff00000
  let m = f64[0] // [1, 2)
  if (m > 1.4142135623730951) {
    m *= 0.5
    k += 1
  }
  const f = m - 1
  const s = f / (2 + f)
  const z = s * s
  const w = z * z
  const R = w * (LG2 + w * (LG4 + w * LG6)) + z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)))
  const hfsq = 0.5 * f * f
  return k * LN2_HI - (hfsq - (s * (hfsq + R) + k * LN2_LO) - f)
}

const nativePow = Math.pow
export function pow(x: number, y: number) {
  // 0、±1、無限大、NaN 的結果都是固定值，沿用內建的
  if (!(x - x === 0) || !(y - y === 0) || x === 0 || y === 0 || x === 1) return nativePow(x, y)
  const int = Math.floor(y) === y
  if (int && y >= -64 && y <= 64) {
    // 小的整數次方：連乘（x² 就是精確的 x * x）
    let n = y < 0 ? -y : y
    let b = x
    let r = 1
    while (n > 0) {
      if (n & 1) r *= b
      b *= b
      n >>>= 1
    }
    return y < 0 ? 1 / r : r
  }
  if (x < 0) {
    if (!int) return NaN
    const r = exp(y * log(-x))
    return Math.abs(y % 2) === 1 ? -r : r
  }
  if (y === 0.5) return Math.sqrt(x)
  return exp(y * log(x))
}

// 換掉全域 Math 上的函式；回傳還原用的函式
export function installDetMath() {
  const M = Math as unknown as Record<string, unknown>
  const fns = { sin, cos, tan, atan, atan2, asin, acos, exp, log, pow }
  const orig: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(fns)) {
    orig[k] = M[k]
    M[k] = f
  }
  return () => {
    for (const [k, f] of Object.entries(orig)) M[k] = f
  }
}
