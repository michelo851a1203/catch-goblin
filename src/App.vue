<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue'
import CharacterSelect from './components/CharacterSelect.vue'
import GameView from './components/GameView.vue'
import RoomSheet from './components/RoomSheet.vue'
import type { Role } from './game/config'
import type { NetLink, Room, RoomError } from './net/room'
import * as poki from './poki'
import { t } from './i18n'

// ?role=elf / ?role=goblin 可直接跳過選角（測試用）
const q = new URLSearchParams(location.search).get('role')
const role = ref<Role | null>(q === 'elf' || q === 'goblin' ? q : null)
const round = ref(0)
let busy = false

// 多人連線：進入畫面時先顯示 bottom sheet；關閉即為單機模式
const sheet = ref(!role.value)
const room = shallowRef<Room | null>(null)
const link = shallowRef<NetLink | null>(null)
const roomError = ref<RoomError | null>(null)

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

// 輸入暱稱並連線成功後收起 sheet，左上角改為「已加入 <房號>」
function attach(r: Room) {
  roomError.value = null
  sheet.value = false
  room.value = r
  r.onStart = (l) => {
    link.value = l
    sheet.value = false
    round.value++
  }
  r.onClose = (why) => {
    room.value = null
    link.value = null
    roomError.value = why
    // 被拒絕 / 房主離開時重新打開 sheet 顯示原因；自己離開則不打開
    if (why) sheet.value = true
  }
  if (r.current) r.onStart(r.current)
}

// 在房間內關閉 sheet 只是收起來，回到選角畫面用卡片選角；不在房間時關閉即為單機模式
function closeSheet() {
  sheet.value = false
  roomError.value = null
}

function leaveLobby() {
  closeSheet()
  room.value?.leave()
}

function backToRoom() {
  link.value = null
  room.value?.backToLobby()
}

// 多人回合之間不播插頁廣告（會讓玩家不同步），離開房間回到單機時才播
async function leaveRoom() {
  room.value?.leave()
  sheet.value = false
  await poki.commercialBreak()
}
</script>

<template>
  <GameView
    v-if="link"
    :key="'mp' + round"
    :role="link.me === 'elf' ? 'elf' : 'goblin'"
    :net="link"
    @restart="backToRoom"
    @menu="leaveRoom"
  />
  <GameView v-else-if="role" :key="round" :role="role" @restart="newRound(role)" @menu="role = null" />
  <template v-else>
    <CharacterSelect :room="room" @start="newRound" @multiplayer="sheet = true" @leave="leaveLobby" />
    <RoomSheet v-if="sheet" :room="room" :error="roomError" @close="closeSheet" @leave="leaveLobby" @room="attach" />
  </template>
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
