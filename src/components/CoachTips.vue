<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Game, HudState } from '../game/Game'
import type { ElfKind, Role } from '../game/config'
import type { IconName } from '../icons'
import { icon } from '../icons'
import { keyLabel, loadKeybinds } from '../keybinds'
import { t } from '../i18n'
import { touchMode } from '../input/touch'
import { markStep, skipTutorial, stepDone, type CoachStep } from '../tutorial'

// 新手教學卡：依遊戲中發生的事情，在畫面左側顯示一次性的圖示＋短句提示（看過就不再出現，可略過）。
// 只讀取遊戲狀態、不改動遊戲邏輯，對局結果與 golden master 不受影響
const props = defineProps<{ game: () => Game | null; hud: HudState; role: Role; elfKind: ElfKind }>()

const binds = loadKeybinds()
const k = (code: string) => keyLabel(code)
const mv = binds.move
const moveKeys = [mv.up, mv.left, mv.down, mv.right].map(k).join('')

// 精靈：移動 → 目標 → 連招；哥布林：移動 → 目標 → 遇到精靈時衝刺 → 同伴被抓時救人 → 自己被抓時掙脫
const STEPS: CoachStep[] = props.role === 'elf' ? ['move', 'goal', 'combo'] : ['move', 'goal', 'dash', 'rescue', 'ult']
// 最短顯示時間（毫秒）：太快消失會看不清楚
const MIN_SHOW = 1500

const current = ref<CoachStep | null>(null)
let shownAt = 0
let startX = 0
let startZ = 0
let timer = 0

function me(g: Game) {
  return props.role === 'elf' ? g.elf : g.playerGoblin
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

// 這張卡現在該出現嗎
function triggered(step: CoachStep, g: Game) {
  const self = me(g)
  if (!self) return false
  const elf = g.elf
  const gob = g.playerGoblin
  switch (step) {
    case 'move':
      return true
    case 'goal':
      return stepDone('move')
    case 'dash': {
      if (!gob || !stepDone('goal') || gob.captured || gob.held || elf.stealthed) return false
      return props.hud.radar || (dist(gob.pos, elf.pos) < 16 && g.world.lineOfSight(gob.pos, elf.pos))
    }
    case 'rescue':
      return !!gob && stepDone('goal') && !!elf.packing && elf.packing.g !== gob && !gob.captured && !gob.held
    case 'ult':
      return !!gob?.held && !gob.ultUsed
    case 'combo':
      return stepDone('goal') && g.goblins.some((o) => !o.captured && dist(o.pos, self.pos) < 22)
  }
}

// 這張卡可以收起來了嗎（玩家做到了，或顯示夠久）
function finished(step: CoachStep, g: Game, ms: number) {
  if (ms < MIN_SHOW) return false
  const self = me(g)
  const gob = g.playerGoblin
  switch (step) {
    case 'move':
      return (!!self && dist(self.pos, { x: startX, z: startZ }) > 4) || ms > 9000
    case 'goal':
      return ms > 5000
    case 'dash':
      return (!!gob && gob.dashT > 0) || ms > 6000
    case 'rescue':
      return !g.elf.packing || (!!gob && gob.interfereCd > 0) || ms > 7000
    case 'ult':
      return !gob?.held || ms > 6000
    case 'combo':
      return ms > 8000
  }
}

function open(step: CoachStep, g: Game) {
  current.value = step
  shownAt = performance.now()
  const self = me(g)
  startX = self?.pos.x ?? 0
  startZ = self?.pos.z ?? 0
}

function close() {
  if (current.value) markStep(current.value)
  current.value = null
}

function tick() {
  const g = props.game()
  const h = props.hud
  if (!g || h.phase !== 'play' || h.result || h.spectating) {
    // 結算或觀戰時收起（還沒看完的下次再出現）
    if (current.value && (h.result || h.spectating)) current.value = null
    return
  }
  const now = performance.now()
  // 被打包是最緊急的：先插隊顯示掙脫
  if (current.value !== 'ult' && STEPS.includes('ult') && !stepDone('ult') && triggered('ult', g)) {
    if (current.value) close()
    open('ult', g)
    return
  }
  if (current.value) {
    if (finished(current.value, g, now - shownAt)) close()
    return
  }
  for (const s of STEPS) {
    if (stepDone(s)) continue
    if (triggered(s, g)) open(s, g)
    break // 依序教學：前一張還沒看過就不跳到後面
  }
}

function skip() {
  skipTutorial()
  current.value = null
}

onMounted(() => {
  // 全部看過就不必再檢查
  if (STEPS.every(stepDone)) return
  timer = window.setInterval(tick, 200)
})
onBeforeUnmount(() => clearInterval(timer))

const card = computed((): { icon: IconName; text: string } | null => {
  const touch = touchMode.value
  const e = binds.elf
  const gb = binds.goblin
  switch (current.value) {
    case 'move':
      return { icon: 'ui-move', text: touch ? t('coachMoveTouch') : t('coachMove', { keys: moveKeys }) }
    case 'goal':
      return { icon: 'ui-goal', text: props.role === 'elf' ? t('coachGoalElf') : t('coachGoalGoblin') }
    case 'dash':
      return { icon: 'skill-dash', text: touch ? t('coachDashTouch') : t('coachDash', { key: k(gb.dash) }) }
    case 'rescue':
      return { icon: 'skill-interfere', text: touch ? t('coachRescueTouch') : t('coachRescue', { key: k(gb.interfere) }) }
    case 'ult':
      return { icon: 'skill-ult', text: touch ? t('coachUltTouch') : t('coachUlt', { key: k(gb.ult) }) }
    case 'combo': {
      const violin = props.elfKind === 'violin'
      if (touch) return { icon: violin ? 'skill-charge' : 'skill-gaze', text: violin ? t('coachComboViolinTouch') : t('coachComboTouch') }
      const keys = { a: k(e.gaze), b: k(e.stun) }
      return { icon: violin ? 'skill-charge' : 'skill-gaze', text: violin ? t('coachComboViolin', keys) : t('coachCombo', keys) }
    }
    default:
      return null
  }
})
</script>

<template>
  <Transition name="coach">
    <div v-if="card" :key="current ?? ''" class="coach" role="status">
      <img class="ico" :src="icon(card.icon)" alt="" />
      <div class="body">
        <span class="tag">{{ t('coachTag') }}</span>
        <p>{{ card.text }}</p>
        <button class="skip" @pointerdown.stop @click="skip">{{ t('coachSkip') }}</button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.coach {
  position: absolute;
  left: 20px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 330px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(20, 30, 22, 0.88);
  border: 2px solid #e6c878;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  color: #fff3d6;
  font-family: var(--font);
  pointer-events: none;
}
.ico {
  flex: none;
  width: 56px;
  height: 56px;
}
.body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tag {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #f4d983;
}
p {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.35;
}
.skip {
  align-self: flex-start;
  pointer-events: auto;
  margin-top: 2px;
  padding: 2px 0;
  border: none;
  background: none;
  color: #d8cba8;
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.coach-enter-active,
.coach-leave-active {
  transition: opacity 0.25s, transform 0.25s;
}
.coach-enter-from,
.coach-leave-to {
  opacity: 0;
  transform: translate(-16px, -50%);
}
@media (max-height: 500px) {
  .coach {
    left: 12px;
    max-width: 260px;
    padding: 8px 10px;
    gap: 8px;
  }
  .ico {
    width: 40px;
    height: 40px;
  }
  p {
    font-size: 13px;
  }
}
</style>
