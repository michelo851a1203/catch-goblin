<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { FloatingParticles, Shader, Sparkle } from 'shaders/vue'
import elfArt from '../assets/art/elf-card.webp'
import goblinArt from '../assets/art/goblin-card.webp'
import violinArt from '../assets/art/violin-card.webp'
import type { ElfKind, Role } from '../game/config'
import { sfx } from '../game/audio'
import { loadStats } from '../stats'
import { keyLabel, loadKeybinds } from '../keybinds'
import KeybindSettings from './KeybindSettings.vue'
import { locale, setLocale, t } from '../i18n'
import { touchMode } from '../input/touch'
import { fullscreenSupported } from '../input/fullscreen'
import FullscreenButton from './FullscreenButton.vue'
import IconText from './IconText.vue'
import { icon, type IconName } from '../icons'
import { displayName, type Room } from '../net/room'
import type { Pick } from '../net/assign'

// room：在多人房間大廳時，卡片改為選角（精靈 / 哥布林），選擇結果標示在卡片邊框上
const props = defineProps<{ room?: Room | null }>()
const emit = defineEmits<{ start: [role: Role, kind: ElfKind]; multiplayer: []; leave: [] }>()

// 卡片：精靈 → 點下後飛出兩張精靈卡（豎琴 / 紫晶）；哥布林直接翻牌
type CardId = 'elf' | 'goblin' | ElfKind
const chosen = ref<CardId | null>(null)
const elfMenu = ref(false)
const offsets = ref<Record<CardId, number>>({ elf: 0, goblin: 0, harp: 0, violin: 0 })
// 飛出動畫的起點（相對於最終位置的水平位移）
const flyFrom = ref<Record<CardId, number>>({ elf: 0, goblin: 0, harp: 0, violin: 0 })
const stage = ref<HTMLElement | null>(null)
const cardEls = ref<Record<string, HTMLElement | null>>({})
const stats = loadStats()
const binds = ref(loadKeybinds())
const showSettings = ref(false)
const moveKeys = computed(() => {
  const m = binds.value.move
  return [m.up, m.left, m.down, m.right].map(keyLabel).join(' ')
})
// 進場動畫：掛載後下一幀才加上 class，讓 CSS transition 生效
const entered = ref(false)
onMounted(() => requestAnimationFrame(() => (entered.value = true)))

// 依目前語系與鍵位重新產生卡片內容
interface Card {
  id: CardId
  role: Role
  kind?: ElfKind
  name: string
  sub: string
  art: string
  tagline: string
  goal: string
  skills: { icon: IconName; key: string; name: string; desc: string }[]
}
const cards = computed<Card[]>(() => {
  const b = binds.value
  const harp: Card = {
    id: 'harp',
    role: 'elf',
    kind: 'harp',
    name: t('elfName'),
    sub: t('harpSub'),
    art: elfArt,
    tagline: t('elfTagline'),
    goal: t('elfGoal'),
    skills: [
      { icon: 'skill-gaze', key: keyLabel(b.elf.gaze), name: t('skillGaze'), desc: t('skillGazeDesc') },
      { icon: 'skill-music', key: keyLabel(b.elf.music), name: t('skillMusic'), desc: t('skillMusicDesc') },
      { icon: 'skill-stun', key: keyLabel(b.elf.stun), name: t('skillStun'), desc: t('skillStunDesc') },
      { icon: 'skill-capture', key: keyLabel(b.elf.capture), name: t('skillCapture'), desc: t('skillCaptureDesc') },
    ],
  }
  if (elfMenu.value)
    return [
      harp,
      {
        id: 'violin',
        role: 'elf',
        kind: 'violin',
        name: t('violinName'),
        sub: t('violinSub'),
        art: violinArt,
        tagline: t('violinTagline'),
        goal: t('elfGoal'),
        skills: [
          { icon: 'skill-stealth', key: keyLabel(b.elf.gaze), name: t('skillStealth'), desc: t('skillStealthDesc') },
          { icon: 'skill-eye', key: keyLabel(b.elf.music), name: t('skillEye'), desc: t('skillEyeDesc') },
          { icon: 'skill-charge', key: keyLabel(b.elf.stun), name: t('skillCharge'), desc: t('skillChargeDesc') },
          { icon: 'skill-capture', key: keyLabel(b.elf.capture), name: t('skillCapture'), desc: t('skillCaptureDesc') },
        ],
      },
    ]
  return [
    { ...harp, id: 'elf', kind: undefined, sub: 'Sylvari Huntress', tagline: t('elfTagline') },
    {
      id: 'goblin',
      role: 'goblin',
      name: t('goblinName'),
      sub: 'Cave Goblin',
      art: goblinArt,
      tagline: t('goblinTagline'),
      goal: t('goblinGoal'),
      skills: [
        { icon: 'skill-dash', key: keyLabel(b.goblin.dash), name: t('skillDash'), desc: t('skillDashDesc') },
        { icon: 'skill-interfere', key: keyLabel(b.goblin.interfere), name: t('skillInterfere'), desc: t('skillInterfereDesc') },
        { icon: 'skill-ult', key: keyLabel(b.goblin.ult), name: t('skillUlt'), desc: t('skillUltDesc') },
        { icon: 'skill-radar', key: t('passive'), name: t('skillRadar'), desc: t('skillRadarDesc') },
      ],
    },
  ]
})

const lobby = computed(() => props.room?.state ?? null)
const me = computed(() => lobby.value?.players.find((p) => p.id === lobby.value!.me) ?? null)
const myPick = computed(() => me.value?.pick ?? null)
const kindName = (k?: ElfKind) => (k === 'violin' ? t('violinName') : t('elfName'))
const myPickLabel = computed(() => {
  const label: Record<Pick, string> = { elf: kindName(me.value?.elf), goblin: t('goblinName'), random: t('mpPickRandom') }
  return label[myPick.value ?? 'random']
})
const myPickIcon = computed<IconName>(() => {
  const p = myPick.value ?? 'random'
  return p === 'elf' ? (me.value?.elf === 'violin' ? 'icon-elf-violin' : 'icon-elf-harp') : p === 'goblin' ? 'icon-goblin' : 'icon-random'
})
function pickers(c: Card) {
  return lobby.value?.players.filter((p) => p.pick === c.role && (!c.kind || (p.elf ?? 'harp') === c.kind)) ?? []
}
function isMine(c: Card) {
  return myPick.value === c.role && (!c.kind || (me.value?.elf ?? 'harp') === c.kind)
}
function canPick(role: Role) {
  return props.room?.canPick(role) ?? true
}
function pickRole(p: Pick, kind?: ElfKind) {
  sfx.unlock()
  sfx.flip()
  props.room?.setPick(p, kind)
  chosen.value = null
  elfMenu.value = false
}
function startRoom() {
  sfx.unlock()
  sfx.flip()
  props.room?.start()
}

function toggleLocale() {
  sfx.unlock()
  sfx.flip()
  setLocale(locale.value === 'zh' ? 'en' : 'zh')
}

async function choose(id: CardId) {
  if (chosen.value) return
  sfx.unlock()
  sfx.flip()
  if (id === 'elf') {
    // 精靈卡：從卡片位置飛出兩張精靈卡（豎琴留在原位、紫晶飛到右邊）
    const from = cardEls.value.elf!.getBoundingClientRect()
    const right = cardEls.value.goblin!.getBoundingClientRect()
    flyFrom.value.harp = 0
    flyFrom.value.violin = from.left - right.left
    elfMenu.value = true
    return
  }
  const st = stage.value!.getBoundingClientRect()
  const el = cardEls.value[id]!.getBoundingClientRect()
  offsets.value[id] = st.left + st.width / 2 - (el.left + el.width / 2)
  await nextTick()
  chosen.value = id
}

// 翻面的精靈卡返回 → 回到兩張精靈卡；兩張精靈卡返回 → 回到陣營選擇
function back() {
  sfx.flip()
  if (chosen.value) chosen.value = null
  else elfMenu.value = false
}

function start(c: Card) {
  emit('start', c.role, c.kind ?? 'harp')
}
</script>

<template>
  <div class="select" :class="{ entered, picked: chosen, 'elf-menu': elfMenu }">
    <div class="glow"></div>
    <button class="lang" :class="{ solo: touchMode, 'with-fs': touchMode && fullscreenSupported }" @click="toggleLocale">{{ t('langSwitch') }}</button>
    <FullscreenButton class="menu-fs" />
    <!-- 已在房間內：點房號打開大廳，✕ 離開房間回到單機 -->
    <div v-if="lobby" class="mp on">
      <button class="mp-open" @click="(sfx.unlock(), sfx.flip(), emit('multiplayer'))"><IconText :text="t('mpJoined', { code: lobby.code })" /></button>
      <button class="mp-x" :aria-label="t('mpLeave')" :title="t('mpLeave')" @click="(sfx.unlock(), sfx.flip(), emit('leave'))"><img class="xi" :src="icon('ui-close')" alt="" /></button>
    </div>
    <button v-else class="mp" @click="(sfx.unlock(), sfx.flip(), emit('multiplayer'))"><IconText :text="t('mpOpen')" /></button>
    <button v-if="!touchMode" class="gear" :aria-label="t('settings')" :title="t('settings')" @click="(sfx.unlock(), sfx.flip(), (showSettings = true))">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          fill-rule="evenodd"
          d="M10.3 2h3.4l.5 2.6c.7.2 1.4.5 2 .9l2.2-1.5 2.4 2.4-1.5 2.2c.4.6.7 1.3.9 2l2.6.5v3.4l-2.6.5c-.2.7-.5 1.4-.9 2l1.5 2.2-2.4 2.4-2.2-1.5c-.6.4-1.3.7-2 .9l-.5 2.6h-3.4l-.5-2.6c-.7-.2-1.4-.5-2-.9l-2.2 1.5-2.4-2.4 1.5-2.2c-.4-.6-.7-1.3-.9-2L2 13.7v-3.4l2.6-.5c.2-.7.5-1.4.9-2L4 5.6 6.4 3.2l2.2 1.5c.6-.4 1.3-.7 2-.9L10.3 2ZM12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"
        />
      </svg>
    </button>
    <KeybindSettings v-if="showSettings" v-model="binds" @close="showSettings = false" />
    <header>
      <p class="eyebrow">{{ t('eyebrow') }}</p>
      <h1 :data-text="t('title')">{{ t('title') }}</h1>
      <p class="lead">{{ elfMenu ? t('chooseElf') : t('chooseSide') }}</p>
    </header>

    <!-- 翻牌時灑落的夢幻藍色靈粉（Shaders：天藍光暈 + 冰藍光點 + 薰衣草藍光暈 + 閃爍星芒） -->
    <!-- 精靈卡飛出時的紫色星塵 -->
    <Shader v-if="elfMenu && !chosen" key="elf-menu" class="fairy-dust violet">
      <FloatingParticles shape="glow" particle-color="#c9a0ff" :count="160" :particle-size="2.4" :softness="0.9" :speed="0.14" :angle="270" :angle-variance="50" :speed-variance="0.5" :randomness="0.6" :twinkle="0.9" />
      <FloatingParticles particle-color="#f0e4ff" :count="500" :particle-size="0.9" :softness="0.3" :speed="0.2" :angle="270" :angle-variance="30" :speed-variance="0.6" :randomness="0.45" :twinkle="1" />
      <Sparkle :size="60" :intensity="7" :threshold="0.5" :ray-length="6" :colorize="0.8" :speed="1.2" />
    </Shader>
    <Shader v-if="chosen" :key="chosen" class="fairy-dust">
      <FloatingParticles shape="glow" particle-color="#8fd3ff" :count="260" :particle-size="2.6" :softness="0.9" :speed="0.16" :angle="270" :angle-variance="40" :speed-variance="0.5" :randomness="0.6" :twinkle="0.9" />
      <FloatingParticles shape="glow" particle-color="#b4a6ff" :count="90" :particle-size="3.4" :softness="1" :speed="0.1" :angle="270" :angle-variance="50" :speed-variance="0.5" :randomness="0.7" :twinkle="0.7" />
      <FloatingParticles particle-color="#e4f6ff" :count="900" :particle-size="0.9" :softness="0.3" :speed="0.22" :angle="270" :angle-variance="25" :speed-variance="0.6" :randomness="0.45" :twinkle="1" />
      <Sparkle :size="70" :intensity="9" :threshold="0.45" :ray-length="7" :colorize="0.75" :speed="1.2" />
    </Shader>

    <div ref="stage" class="stage">
      <div
        v-for="c in cards"
        :key="c.id"
        :ref="(el) => (cardEls[c.id] = el as HTMLElement)"
        class="card-wrap"
        :class="{
          chosen: chosen === c.id,
          hidden: chosen && chosen !== c.id,
          mine: isMine(c),
          taken: lobby && !canPick(c.role) && myPick !== c.role,
          fly: !!c.kind,
        }"
        :style="{ '--dx': offsets[c.id] + 'px', '--from': flyFrom[c.id] + 'px' }"
      >
        <!-- 多人大廳：在卡片上緣標示選了這個角色的玩家 -->
        <div v-if="lobby && pickers(c).length" class="pickers">
          <span v-for="p in pickers(c)" :key="p.id" :class="{ me: p.id === lobby.me }">
            {{ c.role === 'elf' ? t('mpPickedBy', { name: p.id === lobby.me ? t('you') : displayName(p) }) : p.id === lobby.me ? t('you') : displayName(p) }}
          </span>
        </div>
        <div class="card" :class="[c.role, c.kind]" @click="choose(c.id)">
          <div class="face front">
            <div class="art" :style="{ backgroundImage: `url(${c.art})`, '--art': `url(${c.art})` }"></div>
            <div class="frame"></div>
            <div class="plate">
              <span class="sub">{{ c.sub }}</span>
              <h2>{{ c.name }}</h2>
              <p>{{ c.tagline }}</p>
            </div>
          </div>
          <div class="face back">
            <div class="back-inner">
              <span class="sub">{{ c.sub }}</span>
              <h2>{{ c.name }}</h2>
              <p class="goal"><img class="gi" :src="icon('ui-goal')" alt="" />{{ c.goal }}</p>
              <ul>
                <li v-for="s in c.skills" :key="s.name">
                  <img class="icon" :src="icon(s.icon)" alt="" />
                  <div>
                    <b>{{ s.name }} <kbd v-if="!touchMode">{{ s.key }}</kbd></b>
                    <small>{{ s.desc }}</small>
                  </div>
                </li>
              </ul>
              <p class="controls">{{ touchMode ? t('controlsTouch') : t('controls', { keys: moveKeys }) }}</p>
              <div class="actions">
                <button class="ghost" @click.stop="back">{{ t('back') }}</button>
                <template v-if="lobby">
                  <button v-if="isMine(c)" class="go" @click.stop="pickRole('random')">{{ t('mpUnpick') }}</button>
                  <button v-else class="go" :disabled="!canPick(c.role)" @click.stop="pickRole(c.role, c.kind)">
                    {{ canPick(c.role) ? t('mpPickThis') : c.role === 'elf' ? t('mpTaken') : t('mpGoblinFull') }}
                  </button>
                </template>
                <button v-else class="go" @click.stop="start(c)">{{ t('startAdventure') }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <button v-if="elfMenu && !chosen" class="ghost elf-back" @click="back">← {{ t('back') }}</button>

    <footer v-if="lobby" class="lobby-bar">
      <span class="my-pick"><img class="gi" :src="icon(myPickIcon)" alt="" />{{ t('mpMyPick', { pick: myPickLabel }) }}</span>
      <button v-if="myPick && myPick !== 'random'" class="ghost small" @click="pickRole('random')">{{ t('mpUnpick') }}</button>
      <button v-if="lobby.host" class="go small" :disabled="lobby.players.length < 2" :title="lobby.players.length < 2 ? t('mpNeedTwo') : ''" @click="startRoom">
        {{ t('mpStart') }}
      </button>
      <span v-else class="wait">{{ t('mpWaiting') }}</span>
    </footer>
    <footer v-else class="stats">
      <span>{{ t('elfWins', { n: stats.elfWins }) }}</span>
      <span>・</span>
      <span>{{ t('goblinWins', { n: stats.goblinWins }) }}</span>
    </footer>
  </div>
</template>

<style scoped>
.select {
  position: fixed;
  inset: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2vh;
  gap: 2dvh;
  background: radial-gradient(ellipse at 50% 30%, #2f5d4a 0%, #14261f 55%, #0b1411 100%);
  color: #f4ead2;
  font-family: var(--font);
}
.lang {
  position: absolute;
  top: 26px;
  right: 84px;
  z-index: 10;
  padding: 6px 16px;
  font-size: 14px;
  background: rgba(20, 30, 24, 0.7);
  color: #e6c878;
  border-color: #c9a24e;
}
.lang.solo {
  top: calc(16px + env(safe-area-inset-top));
  right: calc(16px + env(safe-area-inset-right));
}
/* 觸控模式右上角放全螢幕鈕，語言鈕往左讓位 */
.lang.solo.with-fs {
  right: calc(70px + env(safe-area-inset-right));
}
.menu-fs {
  position: absolute;
  top: calc(16px + env(safe-area-inset-top));
  right: calc(16px + env(safe-area-inset-right));
  z-index: 10;
}
.mp {
  position: absolute;
  top: calc(16px + env(safe-area-inset-top));
  left: calc(16px + env(safe-area-inset-left));
  z-index: 10;
  padding: 6px 16px;
  font-size: 14px;
  background: rgba(20, 30, 24, 0.7);
  color: #e6c878;
  border-color: #c9a24e;
}
.mp.on {
  display: flex;
  align-items: center;
  padding: 0;
  border: 1px solid #e6c878;
  border-radius: 999px;
  background: rgba(230, 200, 120, 0.18);
  color: #fff3d6;
}
.mp.on button {
  border: none;
  background: none;
  color: inherit;
  font-size: 14px;
}
.mp-open {
  padding: 6px 8px 6px 16px;
}
.mp-x {
  padding: 6px 14px 6px 8px;
  color: #e6c878 !important;
}
.lang:hover,
.mp:hover {
  box-shadow: 0 0 14px rgba(255, 210, 110, 0.45);
}
.gear {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 10;
  width: 56px;
  height: 56px;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid #c9a24e;
  background: rgba(20, 30, 24, 0.7);
  color: #e6c878;
  transition: transform 0.4s, box-shadow 0.3s;
}
.gear svg {
  width: 34px;
  height: 34px;
  display: block;
}
.gear:hover {
  transform: rotate(60deg);
  box-shadow: 0 0 14px rgba(255, 210, 110, 0.45);
}
.glow {
  position: absolute;
  inset: -20%;
  background:
    radial-gradient(circle at 20% 70%, rgba(255, 220, 140, 0.12), transparent 40%),
    radial-gradient(circle at 80% 30%, rgba(160, 230, 140, 0.12), transparent 40%);
  animation: drift 12s ease-in-out infinite alternate;
  pointer-events: none;
}
@keyframes drift {
  to {
    transform: translate(3%, -2%) scale(1.05);
  }
}
header {
  text-align: center;
  z-index: 1;
  opacity: 0;
  transform: translateY(-18px);
  transition:
    opacity 1s ease 0.2s,
    transform 1s cubic-bezier(0.2, 0.8, 0.2, 1) 0.2s;
}
.entered header {
  opacity: 1;
  transform: none;
}
.eyebrow {
  letter-spacing: 0.4em;
  color: #c9b27a;
  font-size: 14px;
  margin: 0;
}
h1 {
  font-size: clamp(22px, 4.6vw, 54px);
  margin: 4px 0;
  color: #fff3d6;
  letter-spacing: 0.15em;
  text-shadow: 0 0 24px rgba(255, 215, 120, 0.45), 0 3px 0 #3b2a12;
  position: relative;
}
/* 淡雅的金色流光：底字維持原色，只在上層掃過一道柔光 */
h1::after {
  content: attr(data-text);
  position: absolute;
  inset: 0;
  color: transparent;
  text-shadow: none;
  background: linear-gradient(105deg, transparent 42%, rgba(255, 246, 214, 0.75) 50%, transparent 58%) 0 0 / 300% 100% no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  pointer-events: none;
  animation: title-shine 7s ease-in-out 1.5s infinite;
}
@keyframes title-shine {
  0% {
    background-position: 100% 0;
  }
  35%,
  100% {
    background-position: 0% 0;
  }
}
.lead {
  margin: 0;
  color: #d6c9a6;
}
.fairy-dust {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: min(900px, 100vw);
  transform: translateX(-50%);
  z-index: 4;
  pointer-events: none;
  mix-blend-mode: screen;
  /* 從上方灑落、往下淡出，集中在卡片周圍 */
  -webkit-mask-image: radial-gradient(ellipse 55% 75% at 50% 40%, #000 35%, transparent 100%);
  mask-image: radial-gradient(ellipse 55% 75% at 50% 40%, #000 35%, transparent 100%);
  animation: dust-burst 3.2s ease-out forwards;
}
@keyframes dust-burst {
  0% {
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  100% {
    opacity: 0.55;
  }
}
.stage {
  position: relative;
  display: flex;
  gap: clamp(24px, 6vw, 90px);
  perspective: 1600px;
  z-index: 1;
}
.card-wrap {
  position: relative;
  width: clamp(240px, 26vw, 340px);
  /* 平板橫向（iPad mini 等）網址列展開時可見高度不足，卡片也依高度縮小，翻牌放大後才不會超出畫面 */
  /* 大螢幕（iPad 13 吋、桌機）卡片放大到 400px，技能說明不必捲動 */
  width: min(clamp(240px, 26vw, 400px), 44dvh);
  aspect-ratio: 0.66;
  transition:
    transform 0.9s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.5s;
  z-index: 1;
}
/* 進場：卡片由下方依序浮現 */
.select:not(.entered) .card-wrap {
  opacity: 0;
  transform: translateY(60px) scale(0.92);
}
.entered .card-wrap {
  transition-delay: 0.5s;
}
.entered .card-wrap + .card-wrap {
  transition-delay: 0.7s;
}
.entered footer {
  opacity: 1;
}
.entered .card-wrap.chosen,
.entered .card-wrap.hidden {
  transition-delay: 0s;
}
.card-wrap.hidden {
  opacity: 0;
  transform: scale(0.8);
  pointer-events: none;
}
.card-wrap.chosen {
  transform: translateX(var(--dx)) scale(1.12);
  z-index: 3;
}
/* 精靈卡飛出：從被點的精靈卡位置展開成兩張 */
.card-wrap.fly:not(.chosen):not(.hidden) {
  animation: fly-out 0.85s cubic-bezier(0.2, 0.9, 0.25, 1.1) both;
}
.card-wrap.fly + .card-wrap.fly:not(.chosen):not(.hidden) {
  animation-delay: 0.08s;
}
@keyframes fly-out {
  0% {
    opacity: 0;
    transform: translateX(var(--from)) translateY(10px) scale(0.82) rotateY(-24deg) rotateZ(-6deg);
  }
  35% {
    opacity: 1;
  }
  100% {
    opacity: 1;
    transform: none;
  }
}
.elf-back {
  z-index: 2;
  margin-top: -1vh;
}
.violin .art {
  /* 原畫是淺色背景：疊一層紫夜漸層（multiply），中央保持明亮、四周暗下來，和其他卡片的色調一致 */
  background-image: var(--art), radial-gradient(ellipse 75% 65% at 50% 38%, #fff 30%, #b89ae0 62%, #3d2466 100%) !important;
  background-blend-mode: multiply;
}
.violin .plate {
  background: linear-gradient(transparent, rgba(36, 18, 60, 0.94) 55%);
}
.violin.card .back,
.card.violin .back {
  background:
    linear-gradient(160deg, rgba(255, 255, 255, 0.05), transparent 40%),
    #231833;
}
.fairy-dust.violet {
  animation-duration: 2.4s;
}
/* 多人大廳：選角標示 */
.pickers {
  position: absolute;
  left: 50%;
  top: 0;
  z-index: 5;
  transform: translate(-50%, -55%);
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px;
  width: max-content;
  max-width: 110%;
  pointer-events: none;
}
.pickers span {
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid #e6c878;
  background: #2a1d08;
  color: #fff3d6;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}
.pickers span.me {
  background: linear-gradient(#f4d983, #c9973a);
  color: #2a1d08;
}
.card-wrap.mine .face {
  box-shadow:
    0 20px 50px rgba(0, 0, 0, 0.55),
    0 0 0 3px #fff3a0,
    0 0 0 7px rgba(30, 20, 8, 0.8),
    0 0 26px 8px rgba(255, 215, 110, 0.6);
}
.card-wrap.taken .face {
  box-shadow:
    0 20px 50px rgba(0, 0, 0, 0.55),
    0 0 0 3px #ff8f7a,
    0 0 0 7px rgba(30, 20, 8, 0.8);
}
.card-wrap.taken .art {
  filter: saturate(0.45) brightness(0.75);
}
.card {
  position: relative;
  width: 100%;
  height: 100%;
  cursor: pointer;
  transform-style: preserve-3d;
  transition: transform 0.9s cubic-bezier(0.3, 0.7, 0.2, 1);
}
/* 滑過卡片：以金色光暈強調，不位移 / 傾斜卡片——並排的兩張卡永遠等高對齊
   （點下精靈卡後游標仍停在豎琴卡上、觸控裝置點擊後 :hover 會殘留，原本的上浮會讓兩張卡一高一低） */
@media (hover: hover) and (pointer: fine) {
  .card-wrap:not(.chosen):not(.hidden):not(.mine):not(.taken) .card:hover .face {
    box-shadow:
      0 20px 50px rgba(0, 0, 0, 0.55),
      0 0 0 2px #e8c770,
      0 0 0 6px rgba(30, 20, 8, 0.8),
      0 0 0 7px #b8913c,
      0 0 24px 6px rgba(255, 215, 120, 0.35);
  }
}
.face {
  transition: box-shadow 0.35s ease;
}
.card-wrap.chosen .card {
  transform: rotateY(180deg);
  cursor: default;
}
/* Safari 的 3D 翻牌：翻到背面後正面仍可能攔截點擊 */
.card-wrap.chosen .front {
  pointer-events: none;
}
.face {
  position: absolute;
  inset: 0;
  border-radius: 18px;
  backface-visibility: hidden;
  overflow: hidden;
  box-shadow:
    0 20px 50px rgba(0, 0, 0, 0.55),
    0 0 0 2px #c9a24e,
    0 0 0 6px rgba(30, 20, 8, 0.8),
    0 0 0 7px #8a6a2a;
}
.art {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center top;
  transition: transform 0.6s;
}
.card:hover .art {
  transform: scale(1.04);
}
/* 卡片邊框的金色光澤 */
.front::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(115deg, transparent 40%, rgba(255, 236, 170, 0.35) 50%, transparent 60%) -100% 0 / 250% 100% no-repeat;
  transition: background-position 0.9s ease;
  pointer-events: none;
}
.card:hover .front::after {
  background-position: 120% 0;
}
.frame {
  position: absolute;
  inset: 10px;
  border: 1px solid rgba(255, 230, 170, 0.6);
  border-radius: 12px;
  pointer-events: none;
}
.plate {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 60px 20px 20px;
  text-align: center;
  background: linear-gradient(transparent, rgba(12, 18, 10, 0.92) 55%);
}
.sub {
  font-family: var(--font-display);
  font-size: 12px;
  letter-spacing: 0.25em;
  color: #e6c878;
  text-transform: uppercase;
}
.plate h2,
.back h2 {
  margin: 2px 0 4px;
  font-size: 30px;
  color: #fff6dc;
  letter-spacing: 0.2em;
}
.plate p {
  margin: 0;
  font-size: 13px;
  color: #e3d8bd;
}
.elf .plate {
  background: linear-gradient(transparent, rgba(20, 40, 30, 0.92) 55%);
}
.goblin .plate {
  background: linear-gradient(transparent, rgba(60, 20, 12, 0.9) 55%);
}
.back {
  transform: rotateY(180deg);
  background:
    linear-gradient(160deg, rgba(255, 255, 255, 0.05), transparent 40%),
    #1d2a22;
}
.goblin .back {
  background:
    linear-gradient(160deg, rgba(255, 255, 255, 0.05), transparent 40%),
    #2e1d16;
}
.back-inner {
  position: absolute;
  inset: 12px;
  border: 1px solid rgba(255, 230, 170, 0.45);
  border-radius: 12px;
  padding: 16px 16px 12px;
  display: flex;
  flex-direction: column;
  text-align: center;
}
.goal {
  margin: 4px 0 10px;
  font-size: 13px;
  color: #ffe9a8;
}
ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
  flex: 1;
  /* 卡片背面高度固定：技能說明放不下時（iPad mini、窄卡片、英文）只有技能清單捲動，
     開始按鈕永遠固定在卡片底部看得到、點得到 */
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  touch-action: pan-y;
  scrollbar-width: none;
}
ul::-webkit-scrollbar {
  display: none;
}
.back-inner > :not(ul) {
  flex: none;
}
li {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 6px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
}
.icon {
  width: 34px;
  height: 34px;
  flex: none;
}
.goal,
.my-pick {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.goal .gi,
.my-pick .gi {
  width: 22px;
  height: 22px;
}
.mp-x {
  display: flex;
  align-items: center;
}
.xi {
  width: 22px;
  height: 22px;
  display: block;
}
li b {
  display: block;
  font-size: 14px;
  color: #fff3d6;
}
li small {
  font-size: 11.5px;
  color: #cfc4a8;
  line-height: 1.4;
  display: block;
}
kbd {
  font-family: ui-monospace, monospace;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: #e6c878;
  color: #2a1d08;
  margin-left: 4px;
}
.controls {
  font-size: 11px;
  color: #a99f86;
  margin: 8px 0;
}
.actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}
button {
  font-family: inherit;
  font-size: 15px;
  border-radius: 999px;
  padding: 9px 20px;
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
  box-shadow: 0 0 18px rgba(255, 210, 110, 0.5);
}
.go:hover {
  filter: brightness(1.1);
}
button:disabled {
  cursor: default;
  opacity: 0.5;
  filter: none;
}
.small {
  font-size: 13px;
  padding: 5px 16px;
}
/* 翻牌後放大的卡片會蓋到副標與戰績：翻牌時淡出；兩張精靈卡畫面也收起戰績，矮視窗才不會被擠出畫面 */
.picked .lead,
.select.picked footer,
.select.elf-menu footer.stats {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease 0s;
}
/* 手機不顯示戰績，把高度留給卡片與按鈕（桌機、平板才顯示） */
@media (max-height: 500px), (max-width: 640px) {
  footer.stats {
    display: none;
  }
}
.lobby-bar {
  align-items: center;
  gap: 12px;
  color: #d6c9a6;
}
footer {
  z-index: 1;
  opacity: 0;
  transition: opacity 1s ease 1.1s;
  font-size: 13px;
  color: #a99f86;
  display: flex;
  gap: 8px;
}
@media (max-width: 640px) {
  h1 {
    letter-spacing: 0.06em;
  }
  .fairy-dust {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: min(900px, 100vw);
  transform: translateX(-50%);
  z-index: 4;
  pointer-events: none;
  mix-blend-mode: screen;
  /* 從上方灑落、往下淡出，集中在卡片周圍 */
  -webkit-mask-image: radial-gradient(ellipse 55% 75% at 50% 40%, #000 35%, transparent 100%);
  mask-image: radial-gradient(ellipse 55% 75% at 50% 40%, #000 35%, transparent 100%);
  animation: dust-burst 3.2s ease-out forwards;
}
@keyframes dust-burst {
  0% {
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  100% {
    opacity: 0.55;
  }
}
  .stage {
    gap: 14px;
  }
  .card-wrap {
    width: min(44vw, 45vh);
    width: min(44vw, 45dvh);
  }
}
/* 中等高度（筆電瀏覽器、iPad mini 橫向）：卡片受高度限制變窄，翻牌後收起標題、卡片放大置中，背面文字稍微緊湊，
   才不會只看得到一個技能 */
@media (min-height: 501px) and (max-height: 760px) {
  .card-wrap.chosen {
    transform: translateX(var(--dx)) translateY(-4dvh) scale(1.22);
  }
  .picked header {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease 0s;
  }
  .back-inner {
    padding: 12px 12px 10px;
  }
  .back h2 {
    font-size: 22px;
    letter-spacing: 0.08em;
    margin: 0 0 2px;
  }
  .goal {
    font-size: 12px;
    margin: 2px 0 8px;
  }
  ul {
    gap: 5px;
  }
  li {
    padding: 5px 6px;
    gap: 8px;
  }
  .icon {
    width: 28px;
    height: 28px;
  }
  li b {
    font-size: 13px;
  }
  li small {
    font-size: 11px;
    line-height: 1.35;
  }
  .controls {
    font-size: 10px;
    margin: 6px 0;
  }
}
/* iOS Safari 的 vh 以工具列收起時的高度計算，網址列 / 分頁列展開時卡片會超出畫面、點不到開始按鈕，
   所以卡片尺寸改用 dvh（實際可見高度） */
/* 矮螢幕（手機橫向）：卡片依高度縮小，翻牌後放大並隱藏標題，背面內容可捲動 */
@media (max-height: 500px) {
  .select {
    gap: 1vh;
    gap: 1dvh;
  }
  .eyebrow,
  .lead {
    font-size: 11px;
  }
  h1 {
    font-size: 20px;
  }
  .card-wrap {
    width: 42vh;
    width: 42dvh;
  }
  .card-wrap.chosen {
    transform: translateX(var(--dx)) translateY(-3vh) scale(1.3);
    transform: translateX(var(--dx)) translateY(-3dvh) scale(1.3);
  }
  .picked header,
  .picked footer {
    opacity: 0;
    pointer-events: none;
  }
  .pickers span {
    font-size: 9px;
    padding: 1px 6px;
  }
  .small {
    font-size: 10px;
    padding: 3px 10px;
  }
  .plate {
    padding: 30px 10px 10px;
  }
  .plate h2,
  .back h2 {
    font-size: 18px;
  }
  .plate p {
    font-size: 10px;
  }
  .back-inner {
    inset: 6px;
    padding: 8px 8px 6px;
  }
  .sub {
    font-size: 8px;
  }
  /* 卡片背面的英文副標只是裝飾，手機上把高度讓給技能清單 */
  .back .sub {
    display: none;
  }
  .back h2 {
    letter-spacing: 0.06em;
    white-space: nowrap;
  }
  .back .icon {
    width: 22px;
    height: 22px;
  }
  .goal .gi {
    width: 16px;
    height: 16px;
  }
  .goal {
    font-size: 9px;
    margin: 2px 0 4px;
  }
  ul {
    gap: 3px;
  }
  li {
    padding: 3px 5px;
    gap: 5px;
  }
  .icon {
    font-size: 13px;
  }
  li b {
    font-size: 9px;
  }
  li small {
    font-size: 7.5px;
  }
  .controls {
    font-size: 7.5px;
    margin: 4px 0;
  }
  .actions button {
    font-size: 10px;
    padding: 4px 12px;
  }
  footer {
    font-size: 11px;
  }
}
</style>
