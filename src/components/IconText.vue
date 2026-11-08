<script setup lang="ts">
import { computed } from 'vue'
import { icon, splitIcon } from '../icons'

// 顯示翻譯字串：開頭的 emoji 換成遊戲圖示
const props = defineProps<{ text: string }>()
const parts = computed(() => splitIcon(props.text))
</script>

<template>
  <span class="icon-text"><img v-if="parts.icon" class="gi" :src="icon(parts.icon)" alt="" />{{ parts.text }}</span>
</template>

<style scoped>
.icon-text {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
}
.gi {
  width: 1.45em;
  height: 1.45em;
  flex: none;
}
</style>
