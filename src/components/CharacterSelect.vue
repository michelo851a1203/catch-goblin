<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { FloatingParticles, Shader, Sparkle } from 'shaders/vue'
import elfArt from '../assets/art/elf-card.png'
import goblinArt from '../assets/art/goblin-card.png'
import type { Role } from '../game/config'
import { sfx } from '../game/audio'
import { loadStats } from '../stats'

const emit = defineEmits<{ start: [role: Role] }>()

const chosen = ref<Role | null>(null)
const offsets = ref<Record<Role, number>>({ elf: 0, goblin: 0 })
const stage = ref<HTMLElement | null>(null)
const cardEls = ref<Record<string, HTMLElement | null>>({})
const stats = loadStats()
// 進場動畫：掛載後下一幀才加上 class，讓 CSS transition 生效
const entered = ref(false)
onMounted(() => requestAnimationFrame(() => (entered.value = true)))

const cards: {
  role: Role
  name: string
  sub: string
  art: string
  tagline: string
  goal: string
  skills: { icon: string; key: string; name: string; desc: string }[]
}[] = [
  {
    role: 'elf',
    name: '女精靈',
    sub: 'Sylvari Huntress',
    art: elfArt,
    tagline: '以琴聲與凝視狩獵的森林守護者',
    goal: '在 10 分鐘內捕獲所有哥布林',
    skills: [
      { icon: '💗', key: 'Q', name: '凝視', desc: '射出愛心眼神射線，被看到的哥布林定身 2 秒' },
      { icon: '🎵', key: 'E', name: '彈奏樂器', desc: '原地彈奏，範圍內哥布林被吸引 3 秒，10 秒內更容易被捕獲' },
      { icon: '💫', key: 'F', name: '打暈', desc: '近距離立即打暈哥布林 2 秒' },
      { icon: '🎒', key: 'R', name: '捕獲', desc: '把暈眩的哥布林打包，3 秒後完成捕獲' },
    ],
  },
  {
    role: 'goblin',
    name: '哥布林',
    sub: 'Cave Goblin',
    art: goblinArt,
    tagline: '群居在山洞裡、機靈又膽小的小傢伙',
    goal: '和夥伴們一起撐過 10 分鐘',
    skills: [
      { icon: '💨', key: 'Shift', name: '加速', desc: '短時間衝刺 2 秒，冷卻 10 秒' },
      { icon: '🤜', key: 'F', name: '攪局', desc: '衝到正在打包的精靈身旁，救出被抓的同伴' },
      { icon: '💥', key: 'R', name: '大招・掙脫', desc: '被打包時掙脫束縛，整場只能用一次' },
      { icon: '📡', key: '被動', name: '哥布林雷達', desc: '精靈進入你所在的山洞時，頭上會跳出警告' },
    ],
  },
]

async function choose(role: Role) {
  if (chosen.value) return
  sfx.unlock()
  sfx.flip()
  const st = stage.value!.getBoundingClientRect()
  const el = cardEls.value[role]!.getBoundingClientRect()
  offsets.value[role] = st.left + st.width / 2 - (el.left + el.width / 2)
  await nextTick()
  chosen.value = role
}

function back() {
  sfx.flip()
  chosen.value = null
}
</script>

<template>
  <div class="select" :class="{ entered }">
    <div class="glow"></div>
    <header>
      <p class="eyebrow">— 草原上的捉迷藏 —</p>
      <h1 data-text="快逃啊，哥布林！女精靈來山洞了">快逃啊，哥布林！女精靈來山洞了</h1>
      <p class="lead">選擇你的陣營</p>
    </header>

    <!-- 翻牌時灑落的夢幻藍色靈粉（Shaders：天藍光暈 + 冰藍光點 + 薰衣草藍光暈 + 閃爍星芒） -->
    <Shader v-if="chosen" :key="chosen" class="fairy-dust">
      <FloatingParticles shape="glow" particle-color="#8fd3ff" :count="260" :particle-size="2.6" :softness="0.9" :speed="0.16" :angle="270" :angle-variance="40" :speed-variance="0.5" :randomness="0.6" :twinkle="0.9" />
      <FloatingParticles shape="glow" particle-color="#b4a6ff" :count="90" :particle-size="3.4" :softness="1" :speed="0.1" :angle="270" :angle-variance="50" :speed-variance="0.5" :randomness="0.7" :twinkle="0.7" />
      <FloatingParticles particle-color="#e4f6ff" :count="900" :particle-size="0.9" :softness="0.3" :speed="0.22" :angle="270" :angle-variance="25" :speed-variance="0.6" :randomness="0.45" :twinkle="1" />
      <Sparkle :size="70" :intensity="9" :threshold="0.45" :ray-length="7" :colorize="0.75" :speed="1.2" />
    </Shader>

    <div ref="stage" class="stage">
      <div
        v-for="c in cards"
        :key="c.role"
        :ref="(el) => (cardEls[c.role] = el as HTMLElement)"
        class="card-wrap"
        :class="{ chosen: chosen === c.role, hidden: chosen && chosen !== c.role }"
        :style="{ '--dx': offsets[c.role] + 'px' }"
      >
        <div class="card" :class="c.role" @click="choose(c.role)">
          <div class="face front">
            <div class="art" :style="{ backgroundImage: `url(${c.art})` }"></div>
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
              <p class="goal">🎯 {{ c.goal }}</p>
              <ul>
                <li v-for="s in c.skills" :key="s.name">
                  <span class="icon">{{ s.icon }}</span>
                  <div>
                    <b>{{ s.name }} <kbd>{{ s.key }}</kbd></b>
                    <small>{{ s.desc }}</small>
                  </div>
                </li>
              </ul>
              <p class="controls">WASD 移動・拖曳滑鼠（或雙擊鎖定）轉動視角・滾輪縮放</p>
              <div class="actions">
                <button class="ghost" @click.stop="back">返回</button>
                <button class="go" @click.stop="emit('start', c.role)">開始冒險</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <footer>
      <span>精靈勝場 {{ stats.elfWins }}</span>
      <span>・</span>
      <span>哥布林勝場 {{ stats.goblinWins }}</span>
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
  background: radial-gradient(ellipse at 50% 30%, #2f5d4a 0%, #14261f 55%, #0b1411 100%);
  color: #f4ead2;
  font-family: 'Noto Serif TC', serif;
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
  width: clamp(240px, 26vw, 340px);
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
.card {
  position: relative;
  width: 100%;
  height: 100%;
  cursor: pointer;
  transform-style: preserve-3d;
  transition: transform 0.9s cubic-bezier(0.3, 0.7, 0.2, 1);
}
.card-wrap:not(.chosen):not(.hidden) .card:hover {
  transform: translateY(-10px) rotateX(4deg);
}
.card-wrap.chosen .card {
  transform: rotateY(180deg);
  cursor: default;
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
  font-family: 'Cinzel', serif;
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
  font-size: 22px;
  line-height: 1;
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
    width: 44vw;
  }
}
</style>
