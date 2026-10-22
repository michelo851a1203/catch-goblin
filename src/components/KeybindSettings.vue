<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ACTION_LABELS,
  DEFAULT_KEYBINDS,
  RESERVED_KEYS,
  actionLabel,
  assignKey,
  defaultKeybinds,
  keyLabel,
  saveKeybinds,
  type Group,
  type Keybinds,
} from '../keybinds'
import { sfx } from '../game/audio'

const props = defineProps<{ modelValue: Keybinds }>()
const emit = defineEmits<{ 'update:modelValue': [k: Keybinds]; close: [] }>()

const groups: { group: Group; title: string }[] = [
  { group: 'move', title: '🧭 移動' },
  { group: 'elf', title: '🧝‍♀️ 女精靈技能' },
  { group: 'goblin', title: '👺 哥布林技能' },
]

// 正在等待輸入的欄位
const listening = ref<{ group: Group; action: string } | null>(null)
const notice = ref<{ text: string; kind: 'info' | 'warn' } | null>(null)
let noticeTimer = 0

function rows(group: Group) {
  const labels = ACTION_LABELS[group] as Record<string, string>
  return Object.keys(labels).map((action) => ({ action, label: labels[action] }))
}
function bound(group: Group, action: string) {
  return (props.modelValue[group] as Record<string, string>)[action]
}
function isDefault(group: Group, action: string) {
  return bound(group, action) === (DEFAULT_KEYBINDS[group] as Record<string, string>)[action]
}
const allDefault = computed(() => groups.every(({ group }) => rows(group).every((r) => isDefault(group, r.action))))

function say(text: string, kind: 'info' | 'warn' = 'info') {
  notice.value = { text, kind }
  clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.value = null), 3500)
}

function commit(next: Keybinds) {
  saveKeybinds(next)
  emit('update:modelValue', next)
}

function startListen(group: Group, action: string) {
  sfx.unlock()
  listening.value = { group, action }
}

function apply(group: Group, action: string, code: string) {
  const next: Keybinds = JSON.parse(JSON.stringify(props.modelValue))
  const res = assignKey(next, group, action, code)
  const name = (ACTION_LABELS[group] as Record<string, string>)[action]
  if (!res.ok) {
    say(`「${keyLabel(code)}」已被「${actionLabel(res.blocked)}」使用，且無法互換，請改用其他按鍵`, 'warn')
    return
  }
  if (res.swapped.length) {
    const old = keyLabel((props.modelValue[group] as Record<string, string>)[action])
    say(`按鍵衝突：「${res.swapped.map(actionLabel).join('、')}」已改為 ${old}，「${name}」改為 ${keyLabel(code)}`, 'warn')
  }
  commit(next)
}

function resetOne(group: Group, action: string) {
  apply(group, action, (DEFAULT_KEYBINDS[group] as Record<string, string>)[action])
}

function resetAll() {
  commit(defaultKeybinds())
  say('已回復所有預設按鍵')
}

function onKey(e: KeyboardEvent) {
  if (!listening.value) {
    if (e.code === 'Escape') emit('close')
    return
  }
  e.preventDefault()
  e.stopPropagation()
  const { group, action } = listening.value
  listening.value = null
  if (e.code === 'Escape') return
  if (RESERVED_KEYS.has(e.code)) {
    say(`「${keyLabel(e.code)}」是系統保留鍵，無法設定`, 'warn')
    return
  }
  apply(group, action, e.code)
}

onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="panel" role="dialog" aria-label="按鍵設定">
      <header>
        <h2>⚙️ 按鍵設定</h2>
        <button class="x" aria-label="關閉" @click="emit('close')">✕</button>
      </header>
      <p class="tip">點選按鍵後按下新的按鍵即可變更（Esc 取消）。若與其他動作衝突，兩者會自動互換。</p>

      <section v-for="g in groups" :key="g.group">
        <h3>{{ g.title }}</h3>
        <div v-for="r in rows(g.group)" :key="r.action" class="row">
          <span class="name">{{ r.label }}</span>
          <button
            class="key"
            :class="{ listening: listening?.group === g.group && listening?.action === r.action }"
            @click="startListen(g.group, r.action)"
          >
            {{ listening?.group === g.group && listening?.action === r.action ? '請按下按鍵…' : keyLabel(bound(g.group, r.action)) }}
          </button>
          <button
            class="reset"
            :disabled="isDefault(g.group, r.action)"
            :title="`回復預設（${keyLabel((DEFAULT_KEYBINDS[g.group] as Record<string, string>)[r.action])}）`"
            @click="resetOne(g.group, r.action)"
          >
            ↺
          </button>
        </div>
      </section>

      <p class="note">數字鍵 1～4 與滑鼠左右鍵為固定備用鍵；Tab（觀戰切換）、Esc 為系統保留鍵。</p>

      <div class="msg" :class="notice?.kind">{{ notice?.text }}</div>

      <footer>
        <button class="ghost" :disabled="allDefault" @click="resetAll">回復全部預設</button>
        <button class="go" @click="emit('close')">完成</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(5, 10, 8, 0.6);
  backdrop-filter: blur(3px);
}
.panel {
  width: min(440px, 100%);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 18px 20px 16px;
  border-radius: 16px;
  background:
    linear-gradient(160deg, rgba(255, 255, 255, 0.05), transparent 40%),
    #1d2a22;
  box-shadow:
    0 20px 50px rgba(0, 0, 0, 0.55),
    0 0 0 2px #c9a24e,
    0 0 0 6px rgba(30, 20, 8, 0.8);
  color: #f4ead2;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 20px;
  letter-spacing: 0.15em;
  color: #fff6dc;
}
.x {
  background: transparent;
  border: none;
  color: #e6c878;
  font-size: 18px;
  cursor: pointer;
}
.tip,
.note {
  font-size: 12px;
  color: #a99f86;
  margin: 6px 0 4px;
}
h3 {
  font-size: 14px;
  color: #e6c878;
  margin: 12px 0 6px;
  letter-spacing: 0.1em;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  margin-bottom: 4px;
}
.name {
  flex: 1;
  font-size: 14px;
}
button {
  font-family: inherit;
  cursor: pointer;
}
.key {
  min-width: 110px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #c9a24e;
  background: #e6c878;
  color: #2a1d08;
  font-family: ui-monospace, monospace;
  font-weight: 700;
  font-size: 13px;
}
.key.listening {
  background: transparent;
  color: #ffe9a8;
  animation: blink 1s ease-in-out infinite;
}
@keyframes blink {
  50% {
    border-color: transparent;
  }
}
.reset {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid rgba(230, 200, 120, 0.5);
  background: transparent;
  color: #e6c878;
  font-size: 14px;
}
.reset:disabled {
  opacity: 0.25;
  cursor: default;
}
.msg {
  min-height: 18px;
  font-size: 12.5px;
  margin: 6px 0;
  color: #cfe8c4;
}
.msg.warn {
  color: #ffc98a;
}
footer {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
footer button {
  font-size: 14px;
  border-radius: 999px;
  padding: 8px 18px;
  border: 1px solid #e6c878;
}
.ghost {
  background: transparent;
  color: #e6c878;
}
.ghost:disabled {
  opacity: 0.4;
  cursor: default;
}
.go {
  background: linear-gradient(#f4d983, #c9973a);
  color: #2a1d08;
  font-weight: 700;
}
</style>
