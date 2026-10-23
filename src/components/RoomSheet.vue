<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Room, type RoomError } from '../net/room'
import { MAX_PLAYERS, type Pick } from '../net/assign'
import { sfx } from '../game/audio'
import { t, type TKey } from '../i18n'

// 多人連線的 bottom sheet：建立 / 加入房間，以及房間大廳（選角色、開始遊戲）
const props = defineProps<{ room: Room | null; error: RoomError | null }>()
const emit = defineEmits<{ close: []; room: [room: Room] }>()

const code = ref('')
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
const me = computed(() => s.value?.players.find((p) => p.id === s.value!.me))
const picks = computed<{ pick: Pick; icon: string; label: string; off: string }[]>(() => {
  const r = props.room
  return [
    { pick: 'elf', icon: '🧝‍♀️', label: t('elfName'), off: r && !r.canPick('elf') ? t('mpTaken') : '' },
    { pick: 'goblin', icon: '👺', label: t('goblinName'), off: r && !r.canPick('goblin') ? t('mpGoblinFull') : '' },
    { pick: 'random', icon: '🎲', label: t('mpPickRandom'), off: '' },
  ]
})
const ICON: Record<Pick, string> = { elf: '🧝‍♀️', goblin: '👺', random: '🎲' }

async function connect(kind: 'create' | 'join') {
  if (busy.value) return
  sfx.unlock()
  err.value = ''
  if (kind === 'join' && !/^\d{4}$/.test(code.value)) {
    err.value = t('mpErrCode')
    return
  }
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

function pick(p: Pick) {
  sfx.unlock()
  sfx.flip()
  props.room?.setPick(p)
}

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
</script>

<template>
  <div class="backdrop" @click.self="close">
    <section class="sheet" role="dialog" :aria-label="t('mpTitle')">
      <div class="grip"></div>
      <button class="x" :aria-label="room ? t('mpLeave') : t('mpSolo')" :title="room ? t('mpLeave') : t('mpSolo')" @click="close">✕</button>

      <!-- 建立 / 加入 -->
      <template v-if="!room">
        <h2>{{ t('mpTitle') }}</h2>
        <p class="lead">{{ t('mpLead') }}</p>
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

        <h3>{{ t('mpPlayers', { n: s.players.length, max: MAX_PLAYERS }) }}</h3>
        <ul class="players">
          <li v-for="p in s.players" :key="p.id" :class="{ me: p.id === s.me }">
            <span class="ico">{{ ICON[p.pick] }}</span>
            <span class="name">{{ p.id === s.me ? t('you') : t('playerN', { n: p.n }) }}</span>
            <span v-if="p.n === 1" class="tag">{{ t('mpHost') }}</span>
          </li>
        </ul>

        <h3>{{ t('mpPickTitle') }}</h3>
        <div class="picks">
          <button
            v-for="o in picks"
            :key="o.pick"
            class="pick"
            :class="{ on: me?.pick === o.pick }"
            :disabled="!!o.off && me?.pick !== o.pick"
            @click="pick(o.pick)"
          >
            <span class="ico">{{ o.icon }}</span>
            <span>{{ o.label }}</span>
            <small v-if="o.off && me?.pick !== o.pick">{{ o.off }}</small>
          </button>
        </div>
        <p class="rule">{{ t('mpRule') }}</p>

        <div class="foot">
          <button class="ghost" @click="close">{{ t('mpLeave') }}</button>
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
.picks {
  display: flex;
  justify-content: center;
  gap: 10px;
}
.pick {
  flex: 1;
  max-width: 140px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 6px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  color: #f4ead2;
  border-color: rgba(230, 200, 120, 0.4);
}
.pick .ico {
  font-size: 26px;
}
.pick small {
  font-size: 10px;
  color: #ff9f8f;
}
.pick.on {
  background: rgba(230, 200, 120, 0.2);
  border-color: #fff3a0;
  box-shadow: 0 0 14px rgba(255, 210, 110, 0.4);
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
  .pick {
    flex-direction: row;
    justify-content: center;
    padding: 6px;
    gap: 6px;
  }
  .pick .ico {
    font-size: 18px;
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
