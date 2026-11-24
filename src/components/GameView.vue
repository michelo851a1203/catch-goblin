<script setup lang="ts">
import { isEmbedded } from '../platform'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Game, createHudState } from '../game/Game'
import type { ElfKind, Role } from '../game/config'
import type { NetLink } from '../net/room'
import { recordResult } from '../stats'
import { keyLabel, loadKeybinds } from '../keybinds'
import { t } from '../i18n'
import { touchMode } from '../input/touch'
import { music } from '../game/music'
import TouchControls from './TouchControls.vue'
import FullscreenButton from './FullscreenButton.vue'
import IconText from './IconText.vue'
import CoachTips from './CoachTips.vue'
import KeybindSettings from './KeybindSettings.vue'
import { icon } from '../icons'
import { locale } from '../i18n'
import logoZh from '../assets/brand/logo-zh.webp'
import logoEn from '../assets/brand/logo-en.webp'

const props = defineProps<{ role: Role; net?: NetLink; elfKind?: ElfKind }>()
const emit = defineEmits<{ restart: []; menu: [] }>()

const host = ref<HTMLDivElement | null>(null)
const minimap = ref<HTMLCanvasElement | null>(null)
const kind: ElfKind = props.net?.elfKind ?? props.elfKind ?? 'harp'
const hud = reactive(createHudState(props.role, kind))
let game: Game | null = null
// 載入畫面：角色模型就緒（多人加入者另外等到房主開始）才進入倒數，避免先看到替身模型再換成正確的角色
const loading = ref(true)
const logo = computed(() => (locale.value === 'zh' ? logoZh : logoEn))

onMounted(() => {
  const g = (game = new Game(host.value!, minimap.value!, props.role, hud, (winner) => recordResult(props.role, winner), props.net ?? null, kind))
  game.start()
  void game.ready.then(() => {
    if (game !== g) return
    loading.value = false
    // 當哥布林時告訴玩家這一局的精靈是哪一位
    if (props.role === 'goblin') g.toast(t('tOpponent', { name: kind === 'violin' ? t('violinName') : t('elfName') }), 'info')
  })
  // 遊戲中播自己陣營的音樂；再玩一局時 GameView 重新掛載，從結算的勝利音樂換回來
  music.play(props.role)
})
// 結算：不論自己是哪一邊，都播獲勝陣營的勝利音樂
watch(
  () => hud.result?.winner,
  (winner) => winner && music.play(winner === 'elf' ? 'elfWin' : 'goblinWin'),
)
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
// 對局中的暫停選單：單機會停住時間；連線對戰無法暫停整個房間，只停止本機輸入
const menuOpen = ref(false)
const showBinds = ref(false)
const binds = ref(loadKeybinds())
function openMenu() {
  if (menuOpen.value || hud.result) return
  menuOpen.value = true
  game?.pause('menu')
}
function closeMenu() {
  menuOpen.value = false
  showBinds.value = false
  game?.resume('menu')
}
function closeBinds() {
  showBinds.value = false
  game?.reloadKeybinds()
}
function quitMatch() {
  menuOpen.value = false
  leave('menu')
}
// 對局結束時自動關掉選單，交給結算畫面
watch(
  () => hud.result,
  (r) => r && menuOpen.value && closeMenu(),
)
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
    <!-- 紫晶精靈：刺客之眼開圖 / 隱身中的畫面暈影 -->
    <div v-if="hud.eye || hud.stealth" class="violet-vignette" :class="{ eye: hud.eye }"></div>
    <TouchControls
      v-if="touchMode && !hud.result"
      @move="touchMove"
      @look="touchLook"
      @zoom="touchZoom"
    />

    <!-- 上方：時間與剩餘數量 -->
    <div class="top">
      <div class="pill side">
        <span class="label">{{ role === 'elf' ? (hud.elfKind === 'violin' ? t('violinName') : t('elfName')) : t('goblinName') }}</span>
      </div>
      <div class="pill timer" :class="{ urgent: hud.timeLeft < 60 }"><img class="gi" :src="icon('ui-timer')" alt="" />{{ clock }}</div>
      <div class="pill side">
        <span class="goblins">
          <img v-for="n in hud.total" :key="n" :src="icon(n > hud.free ? 'icon-goblin-caught' : 'icon-goblin')" :class="{ gone: n > hud.free }" alt="" />
        </span>
      </div>
    </div>

    <canvas ref="minimap" class="minimap" width="180" height="180"></canvas>

    <!-- 左上角：暫停選單；手機另有全螢幕鈕（隱藏瀏覽器導覽列） -->
    <div class="corner">
      <button v-if="!loading && !hud.result" class="pause-btn" :aria-label="t('hudPause')" :title="t('hudPause')" @click="openMenu">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>
      </button>
      <FullscreenButton />
    </div>

    <div class="toasts">
      <!-- 哥布林雷達固定在提示列最上方，不蓋住畫面中央的角色 -->
      <div v-if="hud.radar" class="radar"><IconText :text="t('hudRadar')" /></div>
      <TransitionGroup name="toast">
        <div v-for="t in hud.toasts" :key="t.id" class="toast" :class="t.kind"><IconText :text="t.text" /></div>
      </TransitionGroup>
    </div>

    <div v-if="hud.progress >= 0" class="progress">
      <span>{{ hud.progressLabel }}</span>
      <div class="bar"><div :style="{ width: hud.progress * 100 + '%' }"></div></div>
    </div>

    <div v-if="hud.hint" class="hint">{{ hud.hint }}</div>

    <!-- 新手教學卡（一次性，可略過） -->
    <CoachTips v-if="!loading" :game="() => game" :hud="hud" :role="role" :elf-kind="kind" :online="!!net" />

    <!-- 技能列 -->
    <div v-if="!hud.spectating && !hud.result" class="skills">
      <button
        v-for="s in hud.skills"
        :key="s.key"
        class="skill"
        :class="{ active: s.active, cooling: s.cd > 0, off: !s.usable || s.used }"
        @pointerdown.prevent="press(s.code)"
      >
        <img class="ico" :src="icon(s.used ? 'skill-ult-used' : s.icon)" alt="" />
        <span class="cd" v-if="s.cd > 0" :style="{ '--p': (s.cd / s.max) * 100 + '%' }"></span>
        <span class="num" v-if="s.cd > 0">{{ Math.ceil(s.cd) }}</span>
        <kbd>{{ s.key }}</kbd>
        <small>{{ s.name }}</small>
      </button>
    </div>

    <div v-if="hud.spectating && !hud.result" class="spectate">
      <IconText :text="touchMode ? t('hudSpectatingTouch', { name: hud.spectating }) : t('hudSpectating', { name: hud.spectating })" />
      <button @click="nextSpectate"><IconText :text="t('hudNext')" /></button>
      <!-- 多人連線不能快轉 -->
      <button v-if="!net" @click="toggleSpeed"><IconText :text="hud.speed === 1 ? t('hudFast') : t('hudNormal')" /></button>
    </div>

    <div v-if="!touchMode && !hud.spectating && !hud.result" class="help">{{ t('hudHelp', { keys: moveKeys, lock: isEmbedded ? '' : t('lockHint') }) }}</div>

    <div v-if="hud.phase === 'countdown'" class="countdown" :key="hud.countdown">{{ hud.countdown }}</div>

    <Transition name="loading">
      <div v-if="loading" class="loading" role="status">
        <img :src="logo" alt="" />
        <p>{{ t('loading') }}<span class="dots"><i>.</i><i>.</i><i>.</i></span></p>
      </div>
    </Transition>

    <div v-if="menuOpen" class="result menu" @pointerdown.self="closeMenu">
      <div class="panel">
        <h2>{{ net ? t('hudMenuTitle') : t('hudPaused') }}</h2>
        <p v-if="net">{{ t('hudPausedOnline') }}</p>
        <div class="actions column">
          <button class="go" @click="closeMenu">{{ t('hudResume') }}</button>
          <button v-if="!touchMode" class="ghost" @click="showBinds = true">{{ t('settings') }}</button>
          <button class="ghost" @click="quitMatch">{{ net ? t('mpLeave') : t('hudQuit') }}</button>
        </div>
      </div>
    </div>
    <KeybindSettings v-if="showBinds" v-model="binds" @close="closeBinds" />

    <div v-if="hud.result" class="result">
      <div class="panel" :class="{ win: won }">
        <p class="eyebrow">{{ won ? 'VICTORY' : 'DEFEAT' }}</p>
        <h2>{{ hud.result.title }}</h2>
        <p>{{ hud.result.detail }}</p>
        <div class="actions">
          <button class="ghost" @click="leave('menu')">{{ net ? t('mpLeave') : t('hudMenu') }}</button>
          <button class="go" @click="leave('restart')">{{ net ? t('hudBackRoom') : t('hudAgain') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.loading {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  background: #000;
  color: #f3dfb0;
  font-family: var(--font);
}
.loading img {
  width: min(360px, 62vw);
  max-height: 46vh;
  object-fit: contain;
  filter: drop-shadow(0 6px 24px rgba(0, 0, 0, 0.6));
}
.loading p {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.18em;
}
.loading .dots i {
  font-style: normal;
  animation: dot 1.2s infinite;
}
.loading .dots i:nth-child(2) {
  animation-delay: 0.2s;
}
.loading .dots i:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes dot {
  0%,
  60%,
  100% {
    opacity: 0.2;
  }
  30% {
    opacity: 1;
  }
}
.loading-leave-active {
  transition: opacity 0.35s ease;
}
.loading-leave-to {
  opacity: 0;
}
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
.violet-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(ellipse 80% 70% at 50% 50%, transparent 55%, rgba(80, 30, 150, 0.45) 100%);
  animation: vignette-in 0.4s ease-out;
}
.violet-vignette.eye {
  background: radial-gradient(ellipse 75% 65% at 50% 50%, transparent 45%, rgba(120, 50, 220, 0.55) 100%);
  animation: vignette-in 0.4s ease-out, vignette-pulse 1.6s ease-in-out infinite;
}
@keyframes vignette-in {
  from {
    opacity: 0;
  }
}
@keyframes vignette-pulse {
  50% {
    opacity: 0.7;
  }
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
.timer {
  display: flex;
  align-items: center;
  gap: 6px;
}
.timer .gi {
  width: 28px;
  height: 28px;
}
.goblins {
  display: flex;
  align-items: center;
  gap: 2px;
}
.goblins img {
  width: 24px;
  height: 24px;
  display: block;
}
.goblins img.gone {
  opacity: 0.55;
}
.minimap {
  position: absolute;
  right: calc(16px + env(safe-area-inset-right));
  top: calc(16px + env(safe-area-inset-top));
  width: 180px;
  height: 180px;
  pointer-events: none;
}
.corner {
  position: absolute;
  top: calc(14px + env(safe-area-inset-top));
  left: calc(14px + env(safe-area-inset-left));
  z-index: 5;
  display: flex;
  gap: 8px;
}
.pause-btn {
  width: 44px;
  height: 44px;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid rgba(240, 210, 140, 0.6);
  background: rgba(20, 16, 10, 0.62);
  color: #e6c878;
  cursor: pointer;
  touch-action: manipulation;
}
.pause-btn svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 3;
  stroke-linecap: round;
}
.result.menu {
  z-index: 20;
  animation: fade 0.2s;
}
.actions.column {
  flex-direction: column;
  align-items: stretch;
  min-width: 200px;
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
  /* 技能名稱在按鈕下方，底部多留一行字的高度 */
  bottom: 30px;
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
  /* 圖示本身含金框與深綠底 */
  border: none;
  padding: 0;
  background: #121a14;
  color: #fff;
  cursor: pointer;
  /* 不裁切：技能名稱放在按鈕外側下方，長名稱（Assassin's Eye）才不會被圓形切掉 */
  overflow: visible;
  font-family: inherit;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}
.skill .ico {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
  pointer-events: none;
}
/* 冷卻遮罩：圓形內由下往上填滿 --p（按鈕不再 overflow: hidden，改由遮罩自己畫成圓形） */
.skill .cd {
  z-index: 1;
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.65) var(--p), transparent var(--p));
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
  top: calc(100% + 2px);
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: 11px;
  line-height: 1.2;
  z-index: 3;
  text-shadow: 0 1px 2px #000, 0 0 6px #000;
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
  /* 不可伸進畫面中央的技能列（4 顆技能約 330px 寬）：窄視窗時自動換行、往上長 */
  max-width: calc(50% - 200px);
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
  bottom: calc(28px + env(safe-area-inset-bottom));
  transform: none;
  display: grid;
  grid-template-columns: repeat(2, 80px);
  gap: 18px 12px; /* 列距留給按鈕下方的技能名稱 */
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

/* ── 窄螢幕（小手機橫向）：哥布林圖示縮小，上方列才不會壓到右上角小地圖 ── */
@media (max-width: 600px) {
  .top {
    gap: 4px;
  }
  .goblins img {
    width: 17px;
    height: 17px;
  }
  .pill.side {
    padding: 3px 8px;
  }
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
  .corner {
    top: calc(8px + env(safe-area-inset-top));
    left: calc(10px + env(safe-area-inset-left));
    transform: scale(0.85);
    transform-origin: top left;
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
    gap: 16px 10px;
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
