<script setup lang="ts">
import { onMounted, ref, shallowRef, watch } from 'vue'
import CharacterSelect from './components/CharacterSelect.vue'
import GameView from './components/GameView.vue'
import RoomSheet from './components/RoomSheet.vue'
import { isElfKind, type ElfKind, type Role } from './game/config'
import type { NetLink, Room, RoomError } from './net/room'
import * as crazygames from './crazygames'
import { MAX_PLAYERS } from './net/assign'
import { t } from './i18n'
import { music } from './game/music'

// ?role=elf / ?role=goblin 可直接跳過選角（測試用）
const q = new URLSearchParams(location.search).get('role')
const role = ref<Role | null>(q === 'elf' || q === 'goblin' ? q : null)
// ?elf=violin / ?elf=harp 指定精靈角色（測試用）；單機當哥布林時，精靈（AI）沒指定就隨機
const qElf = new URLSearchParams(location.search).get('elf')
const elfKind = ref<ElfKind>(isElfKind(qElf) ? qElf : 'harp')
const round = ref(0)
let busy = false

// 多人連線：進入畫面時先顯示 bottom sheet；關閉即為單機模式
const sheet = ref(!role.value)
const room = shallowRef<Room | null>(null)
const link = shallowRef<NetLink | null>(null)
const roomError = ref<RoomError | null>(null)

// CrazyGames 的邀請 / 即時多人：直接連線，跳過建立 / 加入與暱稱的步驟
// SDK 在載入 App 前就初始化完成，這裡要先決定好，RoomSheet 掛載時才讀得到
const auto = ref<{ kind: 'create' } | { kind: 'join'; code: string } | null>(null)

function joinInvite(code: string) {
  room.value?.leave()
  link.value = null
  role.value = null
  roomError.value = null
  auto.value = { kind: 'join', code }
  sheet.value = true
}

const invite = crazygames.startupInvite()
if (invite) joinInvite(invite)
else if (crazygames.isInstantMultiplayer()) {
  role.value = null
  auto.value = { kind: 'create' }
  sheet.value = true
}

onMounted(() => {
  crazygames.loadingFinished()
  crazygames.onInvite(joinInvite)
})

// 回報房間狀態給 CrazyGames，好友才能加入：只有大廳還有空位時可加入
watch(
  () => {
    const s = room.value?.state
    return s ? `${s.code}|${s.phase === 'lobby' && s.players.length < MAX_PLAYERS}` : ''
  },
  (now, prev) => {
    if (now) {
      const [code, joinable] = now.split('|')
      crazygames.updateRoom(code, joinable === 'true')
    } else if (prev) crazygames.leftRoom()
  },
)

// 背景音樂：回到選角畫面或大廳時播主選單音樂；遊戲中的音樂（陣營、勝利）由 GameView 決定
watch(
  () => !link.value && !role.value,
  (inMenu) => inMenu && music.play('menu'),
  { immediate: true },
)

// 每回合開始前播插頁廣告（是否真的播放由 CrazyGames 決定）
async function newRound(r: Role, kind?: ElfKind) {
  if (busy) return
  busy = true
  await crazygames.commercialBreak()
  busy = false
  role.value = r
  if (r === 'elf') elfKind.value = kind ?? elfKind.value
  else if (!isElfKind(qElf)) elfKind.value = Math.random() < 0.5 ? 'harp' : 'violin'
  round.value++
}
// ?role=goblin 直接進入時也要決定 AI 精靈
if (role.value === 'goblin' && !isElfKind(qElf)) elfKind.value = Math.random() < 0.5 ? 'harp' : 'violin'

// 輸入暱稱並連線成功後收起 sheet，左上角改為「已加入 <房號>」
function attach(r: Room) {
  roomError.value = null
  auto.value = null
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
  auto.value = null
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

// 多人回合之間不播插頁廣告（會讓玩家不同步）；CrazyGames 也不允許在導覽按鈕上播廣告，離開房間不播
function leaveRoom() {
  room.value?.leave()
  sheet.value = false
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
  <GameView v-else-if="role" :key="round" :role="role" :elf-kind="elfKind" @restart="newRound(role, elfKind)" @menu="role = null" />
  <template v-else>
    <CharacterSelect :room="room" @start="newRound" @multiplayer="sheet = true" @leave="leaveLobby" />
    <RoomSheet v-if="sheet" :key="auto?.kind === 'join' ? auto.code : ''" :auto="auto" :room="room" :error="roomError" @close="closeSheet" @leave="leaveLobby" @room="attach" />
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
