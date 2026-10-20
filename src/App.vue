<script setup lang="ts">
import { ref } from 'vue'
import CharacterSelect from './components/CharacterSelect.vue'
import GameView from './components/GameView.vue'
import type { Role } from './game/config'

// ?role=elf / ?role=goblin 可直接跳過選角（測試用）
const q = new URLSearchParams(location.search).get('role')
const role = ref<Role | null>(q === 'elf' || q === 'goblin' ? q : null)
const round = ref(0)

function start(r: Role) {
  role.value = r
  round.value++
}
</script>

<template>
  <CharacterSelect v-if="!role" @start="start" />
  <GameView v-else :key="round" :role="role" @restart="round++" @menu="role = null" />
</template>
