<script setup lang="ts">
import { onBeforeUnmount, reactive } from 'vue'
import { sfx } from '../game/audio'

// 左半邊：浮動搖桿（手指按下的位置就是搖桿中心）；右半邊：拖曳轉視角、雙指縮放
const emit = defineEmits<{ move: [x: number, y: number]; look: [dx: number, dy: number]; zoom: [ratio: number] }>()

const R = 56 // 搖桿最大半徑（px）
const DEAD = 0.12

const stick = reactive({ id: -1, ox: 0, oy: 0, kx: 0, ky: 0 })
const looks = new Map<number, { x: number; y: number }>()
let pinch = 0

function pinchDist() {
  const [a, b] = [...looks.values()]
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function down(e: PointerEvent) {
  if (e.pointerType === 'mouse') return
  sfx.unlock()
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 指標已失效時忽略 */
  }
  if (stick.id < 0 && e.clientX < innerWidth * 0.45) {
    stick.id = e.pointerId
    stick.ox = e.clientX
    stick.oy = e.clientY
    stick.kx = stick.ky = 0
    return
  }
  looks.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (looks.size === 2) pinch = pinchDist()
}

function move(e: PointerEvent) {
  if (e.pointerId === stick.id) {
    let dx = e.clientX - stick.ox, dy = e.clientY - stick.oy
    const len = Math.hypot(dx, dy)
    if (len > R) {
      dx *= R / len
      dy *= R / len
    }
    stick.kx = dx
    stick.ky = dy
    const m = Math.min(1, len / R)
    // 死區內不動，外面重新映射到 0～1，可以慢慢走
    const k = m < DEAD ? 0 : (m - DEAD) / (1 - DEAD) / (m || 1)
    emit('move', (dx / R) * k, (-dy / R) * k)
    return
  }
  const p = looks.get(e.pointerId)
  if (!p) return
  const dx = e.clientX - p.x, dy = e.clientY - p.y
  p.x = e.clientX
  p.y = e.clientY
  if (looks.size >= 2) {
    const d = pinchDist()
    if (pinch > 0 && d > 0) emit('zoom', d / pinch)
    pinch = d
  } else emit('look', dx, dy)
}

// 切回滑鼠模式時元件會被移除，避免角色停不下來
onBeforeUnmount(() => emit('move', 0, 0))

function up(e: PointerEvent) {
  if (e.pointerId === stick.id) {
    stick.id = -1
    emit('move', 0, 0)
    return
  }
  looks.delete(e.pointerId)
  pinch = looks.size === 2 ? pinchDist() : 0
}
</script>

<template>
  <div class="touch-layer" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
    <div v-if="stick.id >= 0" class="stick" :style="{ left: stick.ox + 'px', top: stick.oy + 'px' }">
      <div class="knob" :style="{ transform: `translate(${stick.kx}px, ${stick.ky}px)` }"></div>
    </div>
    <!-- 尚未觸碰時，在左下角提示搖桿位置 -->
    <div v-else class="stick idle"><div class="knob"></div></div>
  </div>
</template>

<style scoped>
.touch-layer {
  position: absolute;
  inset: 0;
  touch-action: none;
}
.stick {
  position: absolute;
  width: 112px;
  height: 112px;
  margin: -56px 0 0 -56px;
  border-radius: 50%;
  border: 2px solid rgba(255, 240, 200, 0.55);
  background: rgba(20, 16, 10, 0.3);
  pointer-events: none;
}
.stick.idle {
  left: calc(110px + env(safe-area-inset-left));
  top: auto;
  bottom: calc(54px + env(safe-area-inset-bottom));
  margin: 0 0 0 -56px;
  opacity: 0.45;
}
.knob {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 52px;
  height: 52px;
  margin: -26px 0 0 -26px;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, #fff3d0, #c9a24e);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}
</style>
