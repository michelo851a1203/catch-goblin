// 地面高度：遊戲邏輯全部在 y = 0 的平面上計算（碰撞、距離、網路同步都只看 x、z），
// 畫面上的物件與特效再依所在位置的地面高度往上墊高。預設草原處處為 0；
// 蘑菇秘境的上層台地由 World 在建立時註冊高度函式，對局結束時還原
type Height = (x: number, z: number) => number
const flat: Height = () => 0
let current: Height = flat

export function groundAt(x: number, z: number) {
  return current(x, z)
}

export function setGround(fn: Height | null) {
  current = fn ?? flat
}
