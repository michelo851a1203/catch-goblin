<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Game, createHudState } from '../game/Game'
import type { Role } from '../game/config'
import { recordResult } from '../stats'
import { keyLabel, loadKeybinds } from '../keybinds'
import { t } from '../i18n'
import { touchMode } from '../input/touch'
import TouchControls from './TouchControls.vue'

const props = defineProps<{ role: Role }>()
const emit = defineEmits<{ restart: []; menu: [] }>()

const host = ref<HTMLDivElement | null>(null)
const minimap = ref<HTMLCanvasElement | null>(null)
const hud = reactive(createHudState(props.role))
let game: Game | null = null

onMounted(() => {
  game = new Game(host.value!, minimap.value!, props.role, hud, (winner) => recordResult(props.role, winner))
  game.start()
})
onBeforeUnmount(() => game?.dispose())

const clock = computed(() => {
  const t = Math.ceil(hud.timeLeft)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
})
const mv = loadKeybinds().move
const moveKeys = [mv.up, mv.left, mv.down, mv.right].map(keyLabel).join('')
const won = computed(() => hud.result && hud.result.winner === props.role)
function press(code: string) {
  game?.onAction(code)
}
// 廣告在回合之間播放（由 App 處理），離開前先暫停遊戲
function leave(to: 'restart' | 'menu') {
  game?.pause('leave')
  if (to === 'restart') emit('restart')
  else emit('menu')
}
function touchMove(x: number, y: number) {
  game?.setTouchMove(x, y)
}
function touchLook(dx: number, dy: number) {
  game?.touchLook(dx, dy)
}
function touchZoom(r: number) {
  game?.touchZoom(r)
}
function nextSpectate() {
  game?.nextSpectate()
}
function toggleSpeed() {
  game?.setSpeed(hud.speed === 1 ? 4 : 1)
}
</script>

<template>
  <div class="game" :class="{ touch: touchMode }">
    <div ref="host" class="viewport"></div>
    <TouchControls
      v-if="touchMode && !hud.result"
      @move="touchMove"
      @look="touchLook"
      @zoom="touchZoom"
    />

    <!-- 上方：時間與剩餘數量 -->
    <div class="top">
      <div class="pill side">
        <span class="label">{{ role === 'elf' ? t('elfName') : t('goblinName') }}</span>
      </div>
      <div class="pill timer" :class="{ urgent: hud.timeLeft < 60 }">⏳ {{ clock }}</div>
      <div class="pill side">
        <span class="goblins">
          <i v-for="n in hud.total" :key="n" :class="{ gone: n > hud.free }">👺</i>
        </span>
      </div>
    </div>

    <canvas ref="minimap" class="minimap" width="180" height="180"></canvas>

    <div class="toasts">
      <TransitionGroup name="toast">
        <div v-for="t in hud.toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
      </TransitionGroup>
    </div>

    <div v-if="hud.radar" class="radar">{{ t('hudRadar') }}</div>

    <div v-if="hud.progress >= 0" class="progress">
      <span>{{ hud.progressLabel }}</span>
      <div class="bar"><div :style="{ width: hud.progress * 100 + '%' }"></div></div>
    </div>

    <div v-if="hud.hint" class="hint">{{ hud.hint }}</div>

    <!-- 技能列 -->
    <div v-if="!hud.spectating" class="skills">
      <button
        v-for="s in hud.skills"
        :key="s.key"
        class="skill"
        :class="{ active: s.active, cooling: s.cd > 0, off: !s.usable || s.used }"
        @pointerdown.prevent="press(s.code)"
      >
        <span class="ico">{{ s.used ? '✖' : s.icon }}</span>
        <span class="cd" v-if="s.cd > 0" :style="{ height: (s.cd / s.max) * 100 + '%' }"></span>
        <span class="num" v-if="s.cd > 0">{{ Math.ceil(s.cd) }}</span>
        <kbd>{{ s.key }}</kbd>
        <small>{{ s.name }}</small>
      </button>
    </div>

    <div v-if="hud.spectating" class="spectate">
      {{ touchMode ? t('hudSpectatingTouch', { name: hud.spectating }) : t('hudSpectating', { name: hud.spectating }) }}
      <button @click="nextSpectate">{{ t('hudNext') }}</button>
      <button @click="toggleSpeed">{{ hud.speed === 1 ? t('hudFast') : t('hudNormal') }}</button>
    </div>

    <div v-if="!touchMode" class="help">{{ t('hudHelp', { keys: moveKeys }) }}</div>

    <div v-if="hud.phase === 'countdown'" class="countdown" :key="hud.countdown">{{ hud.countdown }}</div>

    <div v-if="hud.result" class="result">
      <div class="panel" :class="{ win: won }">
        <p class="eyebrow">{{ won ? 'VICTORY' : 'DEFEAT' }}</p>
        <h2>{{ hud.result.title }}</h2>
        <p>{{ hud.result.detail }}</p>
        <div class="actions">
          <button class="ghost" @click="leave('menu')">{{ t('hudMenu') }}</button>
          <button class="go" @click="leave('restart')">{{ t('hudAgain') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.game {
  position: fixed;
  inset: 0;
  background: #000;
  color: #fff;
  font-family: var(--font);
  user-select: none;
}
.viewport {
  position: absolute;
  inset: 0;
}
.top {
  position: absolute;
  top: calc(14px + env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  align-items: center;
  pointer-events: none;
}
.pill {
  background: rgba(20, 16, 10, 0.62);
  border: 1px solid rgba(240, 210, 140, 0.6);
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 15px;
  backdrop-filter: blur(4px);
}
.timer {
  font-size: 24px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #fff3d0;
  padding: 6px 24px;
}
.timer.urgent {
  color: #ff8a7a;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  50% {
    transform: scale(1.06);
  }
}
.goblins i {
  font-style: normal;
  margin: 0 1px;
}
.goblins i.gone {
  filter: grayscale(1) brightness(0.5);
  opacity: 0.5;
}
.minimap {
  position: absolute;
  right: calc(16px + env(safe-area-inset-right));
  top: calc(16px + env(safe-area-inset-top));
  width: 180px;
  height: 180px;
  pointer-events: none;
}
.toasts {
  position: absolute;
  top: 70px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}
.toast {
  background: rgba(20, 16, 10, 0.75);
  border-left: 4px solid #e6c878;
  padding: 6px 16px;
  border-radius: 8px;
  font-size: 15px;
  white-space: nowrap;
}
.toast.good {
  border-color: #7fe07f;
}
.toast.bad {
  border-color: #ff6f6f;
}
.toast.warn {
  border-color: #ffb347;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s;
}
.radar {
  position: absolute;
  bottom: 200px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(190, 30, 30, 0.85);
  border: 2px solid #ffd0c0;
  padding: 8px 18px;
  border-radius: 10px;
  font-weight: 700;
  animation: pulse 0.8s infinite;
  pointer-events: none;
}
.progress {
  position: absolute;
  bottom: 160px;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  pointer-events: none;
}
.progress .bar {
  width: 280px;
  height: 12px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid #e6c878;
  overflow: hidden;
  margin-top: 4px;
}
.progress .bar div {
  height: 100%;
  background: linear-gradient(90deg, #f4d983, #ff9f43);
}
.hint {
  position: absolute;
  bottom: 125px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 18px;
  font-weight: 700;
  color: #fff3d0;
  text-shadow: 0 2px 4px #000, 0 0 10px #000;
  pointer-events: none;
}
.skills {
  position: absolute;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 14px;
}
.skill {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: 2px solid #e6c878;
  background: radial-gradient(circle at 50% 35%, #3a4a3a, #121a14);
  color: #fff;
  cursor: pointer;
  overflow: hidden;
  font-family: inherit;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}
.skill .ico {
  font-size: 28px;
  position: relative;
  z-index: 1;
}
.skill .cd {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.65);
}
.skill .num {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 22px;
  font-weight: 700;
  z-index: 2;
}
.skill kbd {
  position: absolute;
  top: -2px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 10px;
  background: #e6c878;
  color: #2a1d08;
  border-radius: 4px;
  padding: 0 4px;
  z-index: 3;
}
.skill small {
  position: absolute;
  bottom: 6px;
  left: 0;
  right: 0;
  font-size: 10px;
  z-index: 3;
  text-shadow: 0 1px 2px #000;
}
.skill.active {
  box-shadow: 0 0 18px #ffd34d;
  border-color: #fff3a0;
}
.skill.off {
  filter: grayscale(0.7) brightness(0.7);
}
.spectate {
  position: absolute;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(20, 16, 10, 0.7);
  padding: 8px 16px;
  border-radius: 999px;
  display: flex;
  gap: 12px;
  align-items: center;
}
.spectate button {
  font-family: inherit;
  border-radius: 999px;
  border: 1px solid #e6c878;
  background: transparent;
  color: #e6c878;
  padding: 4px 12px;
  cursor: pointer;
}
.help {
  position: absolute;
  left: 16px;
  bottom: 14px;
  font-size: 12px;
  opacity: 0.7;
  text-shadow: 0 1px 2px #000;
  pointer-events: none;
}
.countdown {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 140px;
  font-weight: 900;
  color: #fff3d0;
  text-shadow: 0 0 30px rgba(255, 200, 100, 0.8), 0 6px 0 #3b2a12;
  animation: pop 1s ease-out;
  pointer-events: none;
}
@keyframes pop {
  from {
    transform: scale(1.8);
    opacity: 0;
  }
  30% {
    opacity: 1;
  }
}
.result {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.55);
  animation: fade 0.6s;
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
.panel {
  text-align: center;
  padding: 30px 44px;
  border-radius: 18px;
  background: #1d2a22;
  border: 2px solid #c9a24e;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  max-width: 460px;
}
.panel.win {
  box-shadow: 0 0 60px rgba(255, 210, 110, 0.5);
}
.panel .eyebrow {
  letter-spacing: 0.4em;
  color: #e6c878;
  margin: 0;
}
.panel h2 {
  font-size: 40px;
  margin: 6px 0 10px;
  color: #fff3d0;
}
.panel p {
  color: #e3d8bd;
}
.actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 18px;
}
.actions button {
  font-family: inherit;
  font-size: 15px;
  border-radius: 999px;
  padding: 9px 22px;
  cursor: pointer;
  border: 1px solid #e6c878;
}
.ghost {
  background: transparent;
  color: #e6c878;
}
.go {
  background: linear-gradient(#f4d983, #c9973a);
  color: #2a1d08;
  font-weight: 700;
}
/* ── 觸控模式：技能鍵移到右下角、放大，方便大拇指按 ── */
.touch .skills {
  left: auto;
  right: calc(18px + env(safe-area-inset-right));
  bottom: calc(18px + env(safe-area-inset-bottom));
  transform: none;
  display: grid;
  grid-template-columns: repeat(2, 80px);
  gap: 12px;
  direction: rtl; /* 第一個技能在最右邊，最靠近大拇指 */
}
.touch .skill {
  width: 80px;
  height: 80px;
  touch-action: none;
  direction: ltr;
}
.touch .skill kbd {
  display: none;
}
.touch .skill small {
  font-size: 11px;
}
.touch .spectate {
  bottom: calc(18px + env(safe-area-inset-bottom));
}

/* ── 矮螢幕（手機橫向）── */
@media (max-height: 500px) {
  .top {
    top: calc(8px + env(safe-area-inset-top));
    gap: 6px;
  }
  .pill {
    padding: 3px 10px;
    font-size: 12px;
  }
  .timer {
    font-size: 17px;
    padding: 3px 14px;
  }
  .goblins i {
    font-size: 11px;
    margin: 0;
  }
  .minimap {
    width: 104px;
    height: 104px;
    top: calc(8px + env(safe-area-inset-top));
    right: calc(10px + env(safe-area-inset-right));
  }
  .toasts {
    top: 44px;
    max-width: 60vw;
  }
  .toast {
    font-size: 12px;
    padding: 4px 10px;
    white-space: normal;
    text-align: center;
  }
  .radar {
    bottom: auto;
    top: 42%;
    font-size: 13px;
    padding: 5px 12px;
  }
  .progress {
    bottom: auto;
    top: 58%;
  }
  .progress .bar {
    width: 200px;
  }
  .hint {
    bottom: auto;
    top: 68%;
    font-size: 14px;
    max-width: 50vw;
    text-align: center;
  }
  .countdown {
    font-size: 90px;
  }
  .panel {
    padding: 16px 26px;
  }
  .panel h2 {
    font-size: 28px;
    margin: 4px 0 6px;
  }
  .panel p {
    margin: 4px 0;
    font-size: 13px;
  }
  .actions {
    margin-top: 10px;
  }
  .touch .skills {
    grid-template-columns: repeat(2, 66px);
    gap: 10px;
  }
  .touch .skill {
    width: 66px;
    height: 66px;
  }
  .touch .skill .ico {
    font-size: 24px;
  }
  .spectate {
    font-size: 13px;
    padding: 6px 12px;
  }
}
</style>
