<script setup lang="ts">
import { onMounted, ref } from 'vue'
import CharacterSelect from './components/CharacterSelect.vue'
import GameView from './components/GameView.vue'
import type { Role } from './game/config'
import * as poki from './poki'
import { t } from './i18n'

// ?role=elf / ?role=goblin 可直接跳過選角（測試用）
const q = new URLSearchParams(location.search).get('role')
const role = ref<Role | null>(q === 'elf' || q === 'goblin' ? q : null)
const round = ref(0)
let busy = false

onMounted(() => void poki.loadingFinished())

// 每回合開始前播插頁廣告（是否真的播放由 Poki 決定）
async function newRound(r: Role) {
  if (busy) return
  busy = true
  await poki.commercialBreak()
  busy = false
  role.value = r
  round.value++
}
</script>

<template>
  <CharacterSelect v-if="!role" @start="newRound" />
  <GameView v-else :key="round" :role="role" @restart="newRound(role)" @menu="role = null" />
  <div class="rotate">📱↻<span>{{ t('rotate') }}</span></div>
</template>

<style scoped>
/* 手機直拿時提示轉成橫向（遊戲本身也會暫停，見 Game.resize） */
.rotate {
  display: none;
}
@media (orientation: portrait) and (pointer: coarse) {
  .rotate {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    background: #0b1411;
    color: #fff3d6;
    font-family: var(--font);
    font-size: 48px;
  }
  .rotate span {
    font-size: 18px;
  }
}
</style>
