<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NAME_MAX, Room, cleanName, displayName, loadName, saveName, type RoomError } from '../net/room'
import { MAX_PLAYERS, type Pick } from '../net/assign'
import { sfx } from '../game/audio'
import { t, type TKey } from '../i18n'

// 多人連線的 bottom sheet：暱稱、建立 / 加入房間，以及房間大廳（房號、玩家、開始遊戲）
// 選角改在選角畫面的卡片上進行；在房間內關閉 sheet 不會離開房間
const props = defineProps<{ room: Room | null; error: RoomError | null }>()
const emit = defineEmits<{ close: []; leave: []; room: [room: Room] }>()

const code = ref('')
const nick = ref(props.room?.myName ?? loadName())
let nickTimer = 0
const busy = ref<'create' | 'join' | null>(null)
const err = ref('')
const copied = ref(false)
// 連線中按下關閉後，晚到的結果要丟棄
let token = 0

const ERR: Record<RoomError, TKey> = {
  full: 'mpErrFull',
  notFound: 'mpErrNotFound',
  started: 'mpErrStarted',
  netFail: 'mpErrNetFail',
  hostLeft: 'mpErrHostLeft',
  version: 'mpErrVersion',
}
watch(
  () => props.error,
  (e) => {
    if (e) err.value = t(ERR[e])
  },
  { immediate: true },
)

const s = computed(() => props.room?.state)
const ICON: Record<Pick, string> = { elf: '🧝‍♀️', goblin: '👺', random: '🎲' }

async function connect(kind: 'create' | 'join') {
  if (busy.value) return
  sfx.unlock()
  err.value = ''
  if (kind === 'join' && !/^\d{4}$/.test(code.value)) {
    err.value = t('mpErrCode')
    return
  }
  saveName(cleanName(nick.value))
  const my = ++token
  busy.value = kind
  try {
    const r = kind === 'create' ? await Room.create() : await Room.join(code.value)
    if (my !== token) return r.leave()
    sfx.flip()
    emit('room', r)
  } catch (e) {
    if (my === token) err.value = t(ERR[(e as RoomError) in ERR ? (e as RoomError) : 'netFail'])
  } finally {
    if (my === token) busy.value = null
  }
}

function onCode(e: Event) {
  const el = e.target as HTMLInputElement
  code.value = el.value.replace(/\D/g, '').slice(0, 4)
  el.value = code.value
  err.value = ''
}

// 房間內修改暱稱：停止輸入一下再送出，避免每個字都廣播一次
function onNick(e: Event) {
  nick.value = (e.target as HTMLInputElement).value
  clearTimeout(nickTimer)
  if (props.room) nickTimer = window.setTimeout(flushNick, 400)
}
function flushNick() {
  clearTimeout(nickTimer)
  if (props.room) props.room.setName(nick.value)
  else saveName(cleanName(nick.value))
}
onBeforeUnmount(flushNick)

async function copy() {
  try {
    await navigator.clipboard.writeText(s.value!.code)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    /* iframe 內可能不允許剪貼簿，房號仍顯示在畫面上 */
  }
}

function close() {
  token++
  busy.value = null
  sfx.flip()
  emit('close')
}

function leave() {
  sfx.flip()
  emit('leave')
}
</script>

<template>
  <div class="backdrop" @click.self="close">
    <section class="sheet" role="dialog" :aria-label="t('mpTitle')">
      <div class="grip"></div>
      <button class="x" :aria-label="room ? t('mpGoPick') : t('mpSolo')" :title="room ? t('mpGoPick') : t('mpSolo')" @click="close">✕</button>

      <!-- 建立 / 加入 -->
      <template v-if="!room">
        <h2>{{ t('mpTitle') }}</h2>
        <p class="lead">{{ t('mpLead') }}</p>
        <label class="nick">
          <span>{{ t('mpNick') }}</span>
          <input :value="nick" :maxlength="NAME_MAX" autocomplete="nickname" :placeholder="t('mpNickPh')" :disabled="!!busy" @input="onNick" @change="flushNick" />
        </label>
        <div class="entry">
          <button class="go" :disabled="!!busy" @click="connect('create')">
            {{ busy === 'create' ? t('mpConnecting') : t('mpCreate') }}
          </button>
          <span class="or">{{ t('mpOr') }}</span>
          <form class="join" @submit.prevent="connect('join')">
            <input
              :value="code"
              inputmode="numeric"
              autocomplete="off"
              maxlength="4"
              pattern="[0-9]*"
              :placeholder="t('mpCodePh')"
              :disabled="!!busy"
              @input="onCode"
            />
            <button class="ghost" type="submit" :disabled="!!busy">
              {{ busy === 'join' ? t('mpConnecting') : t('mpJoin') }}
            </button>
          </form>
        </div>
        <p v-if="err" class="err" role="alert">{{ err }}</p>
        <button class="link" @click="close">{{ t('mpSolo') }} →</button>
      </template>

      <!-- 房間大廳 -->
      <template v-else-if="s">
        <div class="code">
          <span class="label">{{ t('mpRoom') }}</span>
          <b>{{ s.code }}</b>
          <button class="ghost small" @click="copy">{{ copied ? t('mpCopied') : t('mpCopy') }}</button>
        </div>
        <p class="lead">{{ t('mpShare') }}</p>
        <label class="nick">
          <span>{{ t('mpNick') }}</span>
          <input :value="nick" :maxlength="NAME_MAX" autocomplete="nickname" :placeholder="t('mpNickPh')" @input="onNick" @change="flushNick" />
        </label>

        <h3>{{ t('mpPlayers', { n: s.players.length, max: MAX_PLAYERS }) }}</h3>
        <ul class="players">
          <li v-for="p in s.players" :key="p.id" :class="{ me: p.id === s.me }">
            <span class="ico">{{ ICON[p.pick] }}</span>
            <span class="name">{{ displayName(p) }}<template v-if="p.id === s.me"> ({{ t('you') }})</template></span>
            <span v-if="p.n === 1" class="tag">{{ t('mpHost') }}</span>
          </li>
        </ul>

        <p class="rule">{{ t('mpPickHint') }}<br />{{ t('mpRule') }}</p>

        <div class="foot">
          <button class="ghost" @click="leave">{{ t('mpLeave') }}</button>
          <button class="ghost" @click="close">{{ t('mpGoPick') }}</button>
          <button v-if="s.host" class="go" :disabled="s.players.length < 2" :title="s.players.length < 2 ? t('mpNeedTwo') : ''" @click="room.start()">
            {{ t('mpStart') }}
          </button>
          <span v-else class="wait">{{ t('mpWaiting') }}</span>
        </div>
        <p v-if="s.host && s.players.length < 2" class="hint">{{ t('mpNeedTwo') }}</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(5, 10, 8, 0.55);
  animation: fade 0.3s;
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
.sheet {
  position: relative;
  width: min(560px, 100%);
  max-height: 92vh;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 14px 24px calc(20px + env(safe-area-inset-bottom));
  border-radius: 22px 22px 0 0;
  background: linear-gradient(170deg, rgba(255, 255, 255, 0.05), transparent 40%), #1d2a22;
  border: 1px solid #c9a24e;
  border-bottom: none;
  box-shadow: 0 -20px 60px rgba(0, 0, 0, 0.6);
  color: #f4ead2;
  font-family: var(--font);
  text-align: center;
  animation: up 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes up {
  from {
    transform: translateY(100%);
  }
}
.grip {
  width: 44px;
  height: 4px;
  margin: 0 auto 8px;
  border-radius: 2px;
  background: rgba(230, 200, 120, 0.45);
}
.x {
  position: absolute;
  top: 10px;
  right: 12px;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(230, 200, 120, 0.6);
  background: rgba(20, 30, 24, 0.7);
  color: #e6c878;
  font-size: 16px;
  cursor: pointer;
}
h2 {
  margin: 4px 0 6px;
  font-size: 24px;
  letter-spacing: 0.15em;
  color: #fff3d6;
}
h3 {
  margin: 14px 0 6px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: #c9b27a;
}
.lead {
  margin: 0 0 14px;
  font-size: 13px;
  color: #d6c9a6;
}
button {
  font-family: inherit;
  font-size: 15px;
  border-radius: 999px;
  padding: 9px 20px;
  cursor: pointer;
  border: 1px solid #e6c878;
}
button:disabled {
  cursor: default;
  opacity: 0.5;
}
.ghost {
  background: transparent;
  color: #e6c878;
}
.go {
  background: linear-gradient(#f4d983, #c9973a);
  color: #2a1d08;
  font-weight: 700;
  box-shadow: 0 0 18px rgba(255, 210, 110, 0.4);
}
.small {
  font-size: 12px;
  padding: 4px 12px;
}
.entry {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.entry > .go {
  min-width: 220px;
}
.or {
  font-size: 12px;
  color: #a99f86;
}
.join {
  display: flex;
  gap: 8px;
}
.join input {
  width: 150px;
  box-sizing: border-box;
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid #c9a24e;
  background: rgba(0, 0, 0, 0.3);
  color: #fff3d6;
  font-family: ui-monospace, monospace;
  font-size: 18px;
  letter-spacing: 0.3em;
  text-align: center;
  outline: none;
}
.join input::placeholder {
  font-family: var(--font);
  font-size: 13px;
  letter-spacing: 0;
  color: #8f866f;
}
.join input:focus {
  box-shadow: 0 0 0 2px rgba(230, 200, 120, 0.35);
}
.err {
  margin: 12px 0 0;
  padding: 8px 14px;
  border-radius: 10px;
  background: rgba(190, 40, 40, 0.25);
  border: 1px solid rgba(255, 120, 110, 0.6);
  color: #ffd0c8;
  font-size: 14px;
  font-weight: 600;
}
.link {
  margin-top: 14px;
  border: none;
  background: none;
  color: #a99f86;
  font-size: 13px;
  text-decoration: underline;
}
.code {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 4px;
}
.code .label {
  font-size: 13px;
  color: #c9b27a;
}
.code b {
  font-family: ui-monospace, monospace;
  font-size: 40px;
  letter-spacing: 0.25em;
  color: #fff3d6;
  text-shadow: 0 0 18px rgba(255, 215, 120, 0.4);
}
.players {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.players li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  font-size: 13px;
  min-width: 0;
}
.players li.me {
  background: rgba(230, 200, 120, 0.14);
  box-shadow: inset 0 0 0 1px rgba(230, 200, 120, 0.5);
}
.players .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  margin-left: auto;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #e6c878;
  color: #2a1d08;
}
.nick {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 0 0 14px;
  font-size: 13px;
  color: #c9b27a;
}
.nick input {
  width: 200px;
  box-sizing: border-box;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid #c9a24e;
  background: rgba(0, 0, 0, 0.3);
  color: #fff3d6;
  font-family: inherit;
  font-size: 15px;
  text-align: center;
  outline: none;
}
.nick input::placeholder {
  font-size: 13px;
  color: #8f866f;
}
.nick input:focus {
  box-shadow: 0 0 0 2px rgba(230, 200, 120, 0.35);
}
.rule {
  margin: 8px 0 0;
  font-size: 11px;
  color: #a99f86;
}
.foot {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}
.wait {
  font-size: 13px;
  color: #d6c9a6;
}
.hint {
  margin: 6px 0 0;
  font-size: 11px;
  color: #a99f86;
}

/* 矮螢幕（手機橫向）：壓縮間距，內容可捲動 */
@media (max-height: 500px) {
  .sheet {
    padding: 8px 18px calc(10px + env(safe-area-inset-bottom));
  }
  h2 {
    font-size: 18px;
  }
  .lead {
    margin-bottom: 8px;
    font-size: 11px;
  }
  h3 {
    margin: 8px 0 4px;
  }
  .code b {
    font-size: 28px;
  }
  .players {
    grid-template-columns: repeat(5, 1fr);
  }
  .players li {
    padding: 3px 6px;
    font-size: 11px;
  }
  .nick {
    margin-bottom: 8px;
  }
  .nick input {
    padding: 4px 12px;
    font-size: 13px;
  }
  .foot {
    margin-top: 10px;
  }
}
@media (max-width: 420px) {
  .players {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
