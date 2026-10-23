<script setup lang="ts">
import { onMounted, ref } from 'vue'
import CharacterSelect from './components/CharacterSelect.vue'
import GameView from './components/GameView.vue'
import type { Role } from './game/config'
import * as poki from './poki'

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
</template>
