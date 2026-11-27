<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { ElfKind, Role } from '../game/config'
import { icon, type IconName } from '../icons'
import { t } from '../i18n'
import { touchMode } from '../input/touch'

// 角色詳情頁：桌機版左側為角色 3D 模型、右側技能列表（圓形圖示 + 敘述），底部開始按鈕；
// 手機版只列技能圖示與敘述，開始按鈕放在技能列表上方
export interface DetailSkill {
  icon: IconName
  key: string
  name: string
  desc: string
}

const props = defineProps<{
  role: Role
  kind?: ElfKind
  name: string
  sub: string
  goal: string
  skills: DetailSkill[]
  controls: string
  // 主按鈕：單機為「開始冒險」，多人大廳為「選擇此角色」等
  action: string
  disabled?: boolean
}>()
const emit = defineEmits<{ back: []; confirm: [] }>()

const stage = ref<HTMLElement | null>(null)
const loading = ref(true)
const failed = ref(false)
const showcase = shallowRef<{ dispose(): void } | null>(null)
let alive = true

onMounted(async () => {
  // 手機版不顯示模型，也不載入 three.js 展示場景
  if (touchMode.value || !stage.value) return
  const { CharacterShowcase } = await import('../game/showcase')
  if (!alive || !stage.value) return
  const s = new CharacterShowcase(stage.value, props.role, props.kind ?? 'harp')
  showcase.value = s
  void s.ready.then((ok) => {
    loading.value = false
    failed.value = !ok
  })
})
onBeforeUnmount(() => {
  alive = false
  showcase.value?.dispose()
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('back')
  else if (e.key === 'Enter' && !props.disabled) emit('confirm')
}
onMounted(() => addEventListener('keydown', onKey))
onBeforeUnmount(() => removeEventListener('keydown', onKey))
</script>

<template>
  <section class="detail" :class="[role, kind, { touch: touchMode }]">
    <button class="back" @click="emit('back')">← {{ t('back') }}</button>

    <!-- 桌機版：左側角色模型 -->
    <div v-if="!touchMode" class="model">
      <div ref="stage" class="stage"></div>
      <!-- 載入中只顯示載入動畫（不放程序化替身），載入完成角色才出現 -->
      <div v-if="loading" class="model-loading"><span class="spinner"></span>{{ t('loading') }}…</div>
      <div v-else-if="failed" class="model-loading">{{ t('detailLoadFail') }}</div>
      <p v-if="!loading && !failed" class="drag-hint">{{ t('detailDrag') }}</p>
    </div>

    <div class="info">
      <header>
        <span class="sub">{{ sub }}</span>
        <h2>{{ name }}</h2>
        <p class="goal"><img :src="icon('ui-goal')" alt="" />{{ goal }}</p>
      </header>
      <!-- 手機版：開始按鈕在技能列表上方 -->
      <button v-if="touchMode" class="go" :disabled="disabled" @click="emit('confirm')">{{ action }}</button>
      <ul class="skills">
        <li v-for="s in skills" :key="s.name">
          <span class="ring"><img :src="icon(s.icon)" alt="" /></span>
          <div class="text">
            <b>{{ s.name }}<kbd v-if="!touchMode">{{ s.key }}</kbd></b>
            <p>{{ s.desc }}</p>
          </div>
        </li>
      </ul>
      <p v-if="!touchMode" class="controls">{{ controls }}</p>
    </div>

    <!-- 桌機版：底部開始按鈕 -->
    <footer v-if="!touchMode">
      <button class="go" :disabled="disabled" @click="emit('confirm')">{{ action }}</button>
    </footer>
  </section>
</template>

<style scoped>
/* 綠灰黑色底 */
.detail {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  /* 模型佔左半邊整個高度（含底部按鈕那一列），角色才能放大；按鈕在右側技能下方置中 */
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    'model info'
    'model foot';
  background:
    radial-gradient(ellipse 60% 70% at 26% 55%, rgba(120, 150, 128, 0.22), transparent 70%),
    radial-gradient(ellipse at 70% 20%, #26302a 0%, #161c19 50%, #0a0d0c 100%);
  color: #f4ead2;
  font-family: var(--font);
  animation: detail-in 0.45s ease-out both;
}
@keyframes detail-in {
  from {
    opacity: 0;
    transform: scale(1.02);
  }
}
.back {
  position: absolute;
  top: calc(16px + env(safe-area-inset-top));
  left: calc(16px + env(safe-area-inset-left));
  z-index: 2;
  padding: 7px 18px;
  font: inherit;
  font-size: 14px;
  border-radius: 999px;
  border: 1px solid rgba(230, 200, 120, 0.7);
  background: rgba(16, 22, 19, 0.7);
  color: #e6c878;
  cursor: pointer;
}
.back:hover {
  box-shadow: 0 0 14px rgba(255, 210, 110, 0.4);
}

/* ── 左側：模型 ── */
.model {
  grid-area: model;
  position: relative;
  min-height: 0;
}
.stage {
  position: absolute;
  inset: 0;
}
.model-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: #a9b3a8;
  font-size: 14px;
  letter-spacing: 0.1em;
  pointer-events: none;
}
.spinner {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 3px solid rgba(201, 162, 78, 0.18);
  border-top-color: #e6c878;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.drag-hint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 8px;
  margin: 0;
  text-align: center;
  font-size: 12px;
  color: rgba(200, 212, 200, 0.55);
  pointer-events: none;
}

/* ── 右側：技能 ── */
.info {
  grid-area: info;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: clamp(56px, 9vh, 96px) clamp(24px, 5vw, 80px) 8px 12px;
}
header {
  border-bottom: 1px solid rgba(200, 215, 200, 0.14);
  padding-bottom: 14px;
}
.sub {
  font-family: var(--font-display);
  font-size: 12px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: #9fb5a4;
}
h2 {
  margin: 2px 0 6px;
  font-size: clamp(26px, 3.4vw, 40px);
  letter-spacing: 0.15em;
  color: #fff6dc;
}
.goal {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 14px;
  color: #ffe9a8;
}
.goal img {
  width: 22px;
  height: 22px;
}
/* 技能條列，平均分配高度 */
.skills {
  flex: 1;
  min-height: 0;
  list-style: none;
  margin: 0;
  padding: 8px 0 0;
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;
  gap: 10px;
}
li {
  display: flex;
  align-items: center;
  gap: clamp(14px, 2vw, 28px);
}
.ring {
  flex: none;
  width: clamp(56px, 7.5vh, 84px);
  height: clamp(56px, 7.5vh, 84px);
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 50% 35%, #33433a, #141a17 75%);
  box-shadow:
    0 0 0 2px #c9a24e,
    0 0 0 5px rgba(10, 14, 12, 0.9),
    0 0 0 6px rgba(201, 162, 78, 0.45),
    0 6px 18px rgba(0, 0, 0, 0.5);
}
.ring img {
  width: 78%;
  height: 78%;
  object-fit: contain;
}
.text {
  min-width: 0;
}
.text b {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: clamp(15px, 1.4vw, 18px);
  color: #fff3d6;
}
.text p {
  margin: 4px 0 0;
  font-size: clamp(13px, 1.1vw, 15px);
  line-height: 1.5;
  color: #c8cfc4;
}
kbd {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #e6c878;
  color: #2a1d08;
}

/* ── 底部：開始按鈕 ── */
footer {
  grid-area: foot;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 10px clamp(24px, 5vw, 80px) calc(26px + env(safe-area-inset-bottom)) 12px;
}
.controls {
  margin: 10px 0 0;
  font-size: 12px;
  color: #8f9a8f;
}
.go {
  min-width: min(360px, 80vw);
  padding: 14px 40px;
  font: inherit;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.2em;
  border: 1px solid #fff0b8;
  border-radius: 999px;
  background: linear-gradient(#f8de8c, #c9973a);
  color: #2a1d08;
  cursor: pointer;
  box-shadow:
    0 0 0 4px rgba(201, 151, 58, 0.25),
    0 0 26px rgba(255, 210, 110, 0.55);
  animation: go-pulse 2.2s ease-in-out infinite;
}
.go:hover {
  filter: brightness(1.08);
}
.go:disabled {
  opacity: 0.5;
  cursor: default;
  animation: none;
  filter: none;
}
@keyframes go-pulse {
  50% {
    box-shadow:
      0 0 0 7px rgba(201, 151, 58, 0.18),
      0 0 38px rgba(255, 210, 110, 0.75);
  }
}

/* 桌機的矮視窗（CrazyGames 非全螢幕的 iframe 最小約 821×462）：縮小間距與圖示，技能列表放不下時可捲動，
   不會蓋到下方的操作說明與開始按鈕 */
.detail:not(.touch) .skills {
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(230, 200, 120, 0.35) transparent;
}
@media (max-height: 640px) {
  /* 矮視窗：模型欄縮窄、技能欄加寬，說明文字行數變少，四項技能才放得下 */
  .detail:not(.touch) {
    grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  }
  .detail:not(.touch) .info {
    padding-top: 52px;
    padding-right: 28px;
  }
  .detail:not(.touch) header {
    padding-bottom: 8px;
  }
  .detail:not(.touch) h2 {
    font-size: 26px;
    margin: 0 0 2px;
  }
  .detail:not(.touch) .goal {
    font-size: 13px;
  }
  .detail:not(.touch) .skills {
    justify-content: flex-start;
    gap: 8px;
    padding: 10px 6px 4px 8px;
  }
  .detail:not(.touch) li {
    gap: 14px;
  }
  .detail:not(.touch) .ring {
    width: 42px;
    height: 42px;
  }
  .detail:not(.touch) .text b {
    font-size: 14px;
  }
  .detail:not(.touch) .text p {
    margin-top: 1px;
    font-size: 12.5px;
    line-height: 1.35;
  }
  .detail:not(.touch) .controls {
    margin-top: 6px;
    font-size: 11.5px;
  }
  .detail:not(.touch) footer {
    padding-top: 6px;
    padding-bottom: 14px;
  }
  .detail:not(.touch) .go {
    padding: 9px 32px;
    font-size: 17px;
  }
}

/* 更矮的視窗（約 821×462）：再收緊，四項技能不必捲動也放得下 */
@media (max-height: 500px) {
  .detail:not(.touch) .info {
    padding-top: 44px;
  }
  .detail:not(.touch) h2 {
    font-size: 22px;
  }
  .detail:not(.touch) .skills {
    gap: 4px;
    padding-top: 6px;
  }
  .detail:not(.touch) .ring {
    width: 34px;
    height: 34px;
  }
  .detail:not(.touch) .text b {
    font-size: 13px;
  }
  .detail:not(.touch) .text p {
    font-size: 12px;
    line-height: 1.3;
  }
  .detail:not(.touch) footer {
    padding-bottom: 10px;
  }
}

/* 紫晶精靈：模型背後帶一點紫色光暈 */
.detail.violin {
  background:
    radial-gradient(ellipse 60% 70% at 26% 55%, rgba(150, 120, 190, 0.18), transparent 70%),
    radial-gradient(ellipse at 70% 20%, #26302a 0%, #161c19 50%, #0a0d0c 100%);
}

/* 遊俠精靈：模型背後帶一點森林綠光暈 */
.detail.ranger {
  background:
    radial-gradient(ellipse 60% 70% at 26% 55%, rgba(130, 190, 120, 0.18), transparent 70%),
    radial-gradient(ellipse at 70% 20%, #26302a 0%, #161c19 50%, #0a0d0c 100%);
}

/* ── 手機版：只有技能圖示與敘述，開始按鈕在列表上方 ── */
.detail.touch {
  display: flex;
  flex-direction: column;
}
.touch .info {
  flex: 1;
  padding: calc(12px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left));
}
.touch header {
  /* 返回鈕在左上角，標題往右讓位 */
  padding: 0 0 8px 96px;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 12px;
}
.touch .sub {
  display: none;
}
.touch h2 {
  margin: 0;
  font-size: 22px;
}
.touch .goal {
  font-size: 12px;
}
.touch .goal img {
  width: 16px;
  height: 16px;
}
.touch .back {
  top: calc(10px + env(safe-area-inset-top));
  padding: 5px 14px;
  font-size: 13px;
}
.touch .go {
  align-self: center;
  margin: 10px 0 4px;
  padding: 10px 32px;
  font-size: 17px;
  min-width: min(320px, 80vw);
}
.touch .skills {
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  touch-action: pan-y;
  justify-content: flex-start;
  gap: 12px;
  /* 圓形圖示的金色光環在捲動區內，四周留白才不會被裁切 */
  padding: 10px 8px 10px 8px;
}
@media (min-height: 520px) {
  .touch .skills {
    justify-content: space-evenly;
  }
}
.touch li {
  gap: 14px;
}
.touch .ring {
  width: 48px;
  height: 48px;
}
.touch .text b {
  display: none;
}
.touch .text p {
  margin: 0;
  font-size: 13px;
  line-height: 1.4;
  color: #dfe5dc;
}
</style>
