<script setup lang="ts">
import { isCrazyGames } from '../platform'
import { computed, onMounted, ref } from 'vue'
import { FloatingParticles, Shader, Sparkle } from 'shaders/vue'
import elfArt from '../assets/art/elf-card.webp'
import goblinArt from '../assets/art/goblin-card.webp'
import violinArt from '../assets/art/violin-card.webp'
import logoZh from '../assets/brand/logo-zh.webp'
import logoEn from '../assets/brand/logo-en.webp'
import { CONFIG, type ElfKind, type Role } from '../game/config'
import { sfx } from '../game/audio'
import { loadStats } from '../stats'
import { keyLabel, loadKeybinds } from '../keybinds'
import KeybindSettings from './KeybindSettings.vue'
import { locale, setLocale, t } from '../i18n'
import { touchMode } from '../input/touch'
import { fullscreenSupported } from '../input/fullscreen'
import FullscreenButton from './FullscreenButton.vue'
import IconText from './IconText.vue'
import CharacterDetail from './CharacterDetail.vue'
import { icon, type IconName } from '../icons'
import { displayName, type Room } from '../net/room'
import type { Pick } from '../net/assign'

// room：在多人房間大廳時，卡片改為選角（精靈 / 哥布林），選擇結果標示在卡片邊框上
const props = defineProps<{ room?: Room | null }>()
const emit = defineEmits<{ start: [role: Role, kind: ElfKind]; multiplayer: []; leave: [] }>()

// 卡片：精靈 → 點下後飛出兩張精靈卡（豎琴 / 紫晶）；哥布林 / 豎琴 / 紫晶 → 進入角色詳情頁（模型 + 技能，見 CharacterDetail）
type CardId = 'elf' | 'goblin' | ElfKind
const detailId = ref<CardId | null>(null)
const elfMenu = ref(false)
// 飛出動畫的起點（相對於最終位置的水平位移）
const flyFrom = ref<Record<CardId, number>>({ elf: 0, goblin: 0, harp: 0, violin: 0 })
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

// 標題 logo 依語系切換；另一語系的 logo 先預載，切換語言時不會閃一下空白
const logo = computed(() => (locale.value === 'zh' ? logoZh : logoEn))
onMounted(() => (new Image().src = locale.value === 'zh' ? logoEn : logoZh))

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
      { icon: 'skill-capture', key: keyLabel(b.elf.capture), name: t('skillCapture'), desc: t('skillCaptureDesc', { s: CONFIG.elf.capture.packTime }) },
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
          { icon: 'skill-stealth', key: keyLabel(b.elf.gaze), name: t('skillStealth'), desc: t('skillStealthDesc', { fear: CONFIG.violin.stealth.fearTime }) },
          { icon: 'skill-eye', key: keyLabel(b.elf.music), name: t('skillEye'), desc: t('skillEyeDesc') },
          { icon: 'skill-charge', key: keyLabel(b.elf.stun), name: t('skillCharge'), desc: t('skillChargeDesc', { stun: CONFIG.violin.charge.stun, lock: CONFIG.violin.eye.lockTime }) },
          { icon: 'skill-capture', key: keyLabel(b.elf.capture), name: t('skillCapture'), desc: t('skillCaptureDesc', { s: CONFIG.elf.capture.packTime }) },
        ],
      },
    ]
  return [
    { ...harp, id: 'elf', kind: undefined, sub: 'Sylvan Harpist', tagline: t('elfTagline') },
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
  detailId.value = null
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

function choose(id: CardId) {
  if (detailId.value) return
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
  detailId.value = id
}

// 詳情頁返回 → 回到原本的卡片（精靈詳情回到兩張精靈卡）；兩張精靈卡返回 → 回到陣營選擇
function back() {
  sfx.flip()
  if (detailId.value) detailId.value = null
  else elfMenu.value = false
}

const detail = computed(() => cards.value.find((c) => c.id === detailId.value) ?? null)
const controlsText = computed(() => (touchMode.value ? t('controlsTouch') : t('controls', { keys: moveKeys.value, lock: isCrazyGames ? '' : t('lockHint') })))
// 詳情頁的主按鈕：單機直接開始；多人大廳為選角（已選則取消）
const detailAction = computed(() => {
  const c = detail.value
  if (!c) return { label: '', disabled: false }
  if (!lobby.value) return { label: t('startAdventure'), disabled: false }
  if (isMine(c)) return { label: t('mpUnpick'), disabled: false }
  const ok = canPick(c.role)
  return { label: ok ? t('mpPickThis') : c.role === 'elf' ? t('mpTaken') : t('mpGoblinFull'), disabled: !ok }
})
function confirm() {
  const c = detail.value
  if (!c) return
  sfx.unlock()
  if (!lobby.value) return emit('start', c.role, c.kind ?? 'harp')
  pickRole(isMine(c) ? 'random' : c.role, isMine(c) ? undefined : c.kind)
}
</script>

<template>
  <div class="select" :class="{ entered, 'elf-menu': elfMenu }">
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
      <!-- 標題以 logo 呈現；h1 保留、alt 為 logo 上的完整文字，螢幕閱讀器與 SEO 仍讀得到標題 -->
      <h1 class="logo" :style="{ '--logo': `url(${logo})` }"><img :src="logo" :alt="t('logoAlt')" width="1120" height="560" decoding="async" fetchpriority="high" draggable="false" /></h1>
      <p class="lead">{{ elfMenu ? t('chooseElf') : t('chooseSide') }}</p>
    </header>

    <!-- 精靈卡飛出時的紫色星塵 -->
    <!-- disable-telemetry：shaders 套件預設會在 5% 的連線把網域 / 瀏覽器 / 裝置 / 效能資料送到 shaders.com -->
    <Shader v-if="elfMenu && !detailId" key="elf-menu" class="fairy-dust violet" disable-telemetry>
      <FloatingParticles shape="glow" particle-color="#c9a0ff" :count="160" :particle-size="2.4" :softness="0.9" :speed="0.14" :angle="270" :angle-variance="50" :speed-variance="0.5" :randomness="0.6" :twinkle="0.9" />
      <FloatingParticles particle-color="#f0e4ff" :count="500" :particle-size="0.9" :softness="0.3" :speed="0.2" :angle="270" :angle-variance="30" :speed-variance="0.6" :randomness="0.45" :twinkle="1" />
      <Sparkle :size="60" :intensity="7" :threshold="0.5" :ray-length="6" :colorize="0.8" :speed="1.2" />
    </Shader>

    <div class="stage">
      <div
        v-for="c in cards"
        :key="c.id"
        :ref="(el) => (cardEls[c.id] = el as HTMLElement)"
        class="card-wrap"
        :class="{
          mine: isMine(c),
          taken: lobby && !canPick(c.role) && myPick !== c.role,
          fly: !!c.kind,
        }"
        :style="{ '--from': flyFrom[c.id] + 'px' }"
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
        </div>
      </div>
    </div>
    <button v-if="elfMenu" class="ghost elf-back" @click="back">← {{ t('back') }}</button>

    <CharacterDetail
      v-if="detail"
      :key="detail.id"
      :role="detail.role"
      :kind="detail.kind"
      :name="detail.name"
      :sub="detail.sub"
      :goal="detail.goal"
      :skills="detail.skills"
      :controls="controlsText"
      :action="detailAction.label"
      :disabled="detailAction.disabled"
      @back="back"
      @confirm="confirm"
    />

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
/* 標題 logo：高度跟著可見高度（dvh）縮放，卡片才放得下；寬度另外以 vw 封頂，窄螢幕不會撐破版面。
   兩種語系的 logo 都裁成同樣的 2:1 畫布，切換語言時版面不會跳動 */
h1.logo {
  --logo-h: clamp(64px, 17vh, 190px);
  margin: 2px 0 0;
  line-height: 0;
  position: relative;
  width: min(calc(var(--logo-h) * 2), 92vw);
  aspect-ratio: 2 / 1;
  margin-inline: auto;
}
/* 自訂屬性不會因為瀏覽器不認得 dvh 而退回上一行，所以 dvh 版本要包在 @supports 裡 */
@supports (height: 1dvh) {
  h1.logo {
    --logo-h: clamp(64px, 17dvh, 190px);
  }
}
h1.logo img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  -webkit-user-drag: none;
  user-select: none;
  filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.45));
}
/* 淡雅的金色流光：以 logo 本身的透明度當遮罩，只在圖案上掃過一道柔光 */
h1.logo::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 42%, rgba(255, 246, 214, 0.55) 50%, transparent 58%) 0 0 / 300% 100% no-repeat;
  -webkit-mask: var(--logo) center / contain no-repeat;
  mask: var(--logo) center / contain no-repeat;
  mix-blend-mode: soft-light;
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
  /* 依可見高度縮小，平板橫向（iPad mini 等）網址列展開時也放得下 */
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
/* 精靈卡飛出：從被點的精靈卡位置展開成兩張 */
.card-wrap.fly {
  animation: fly-out 0.85s cubic-bezier(0.2, 0.9, 0.25, 1.1) both;
}
.card-wrap.fly + .card-wrap.fly {
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
}
/* 兩張精靈卡下方多了返回鈕：卡片再縮一點，矮視窗（CrazyGames 821×462）返回鈕才不會壓到卡片 */
.select.elf-menu .card-wrap {
  width: min(clamp(240px, 26vw, 400px), 40dvh);
}
.violin .art {
  /* 原畫是淺色背景：疊一層紫夜漸層（multiply），中央保持明亮、四周暗下來，和其他卡片的色調一致 */
  background-image: var(--art), radial-gradient(ellipse 75% 65% at 50% 38%, #fff 30%, #b89ae0 62%, #3d2466 100%) !important;
  background-blend-mode: multiply;
}
.violin .plate {
  background: linear-gradient(transparent, rgba(36, 18, 60, 0.94) 55%);
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
}
/* 滑過卡片：以金色光暈強調，不位移 / 傾斜卡片——並排的兩張卡永遠等高對齊
   （點下精靈卡後游標仍停在豎琴卡上、觸控裝置點擊後 :hover 會殘留，原本的上浮會讓兩張卡一高一低） */
@media (hover: hover) and (pointer: fine) {
  .card-wrap:not(.mine):not(.taken) .card:hover .face {
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
.face {
  position: absolute;
  inset: 0;
  border-radius: 18px;
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
.plate h2 {
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
.my-pick {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
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
/* 兩張精靈卡畫面收起戰績，矮視窗才不會被擠出畫面 */
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
  .select.elf-menu .card-wrap {
    width: min(44vw, 40dvh);
  }
}
/* iOS Safari 的 vh 以工具列收起時的高度計算，網址列 / 分頁列展開時卡片會超出畫面、點不到開始按鈕，
   所以卡片尺寸改用 dvh（實際可見高度） */
/* 矮螢幕（手機橫向）：卡片依高度縮小 */
@media (max-height: 500px) {
  .select {
    gap: 1vh;
    gap: 1dvh;
  }
  /* 手機橫向高度很少：副標題收起，空間留給 logo，logo 才看得清楚 */
  .eyebrow {
    display: none;
  }
  .lead {
    font-size: 11px;
  }
  h1.logo {
    --logo-h: 24vh;
  }
  @supports (height: 1dvh) {
    h1.logo {
      --logo-h: 24dvh;
    }
  }
  .card-wrap {
    width: 42vh;
    width: 42dvh;
  }
  .select.elf-menu .card-wrap {
    width: 36dvh;
  }
  .pickers span {
    font-size: 9px;
    padding: 1px 6px;
  }
  .small {
    font-size: 12px;
    padding: 4px 12px;
  }
  .plate {
    padding: 30px 10px 10px;
  }
  .plate h2 {
    font-size: 18px;
  }
  .plate p {
    font-size: 10px;
  }
  .sub {
    font-size: 8px;
  }
  footer {
    font-size: 11px;
  }
}
</style>
