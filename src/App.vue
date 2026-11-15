<script setup lang="ts">
import { onMounted, ref, shallowRef, watch } from 'vue'
import CharacterSelect from './components/CharacterSelect.vue'
import GameView from './components/GameView.vue'
import RoomSheet from './components/RoomSheet.vue'
import { isElfKind, type ElfKind, type Role } from './game/config'
import type { Room } from './net/room'
import * as screens from './screen'
import * as crazygames from './crazygames'
import { MAX_PLAYERS } from './net/assign'
import { t } from './i18n'
import { music } from './game/music'
import { icon } from './icons'
import { preloadElves } from './game/elf/preload'
import { isCrazyGames } from './platform'
import { isNewPlayer } from './tutorial'
import { canPrompt, installGuide, promptInstall } from './input/install'

// ?role=elf / ?role=goblin 可直接跳過選角（測試用）
const q = new URLSearchParams(location.search).get('role')
const qRole: Role | null = q === 'elf' || q === 'goblin' ? q : null
// ?elf=violin / ?elf=harp 指定精靈角色（測試用）；單機當哥布林時，精靈（AI）沒指定就隨機
const qElf = new URLSearchParams(location.search).get('elf')
const elfKind = ref<ElfKind>(isElfKind(qElf) ? qElf : 'harp')
const round = ref(0)
let busy = false

// 畫面狀態機（見 screen.ts）。CrazyGames 的邀請 / 即時多人在 SDK 載入 App 前就決定好，RoomSheet 掛載時才讀得到
// 新手（CrazyGames 版）：直接進入遊戲（平台規定新玩家要落在遊戲中，最多點一下），
// 當操作最簡單的哥布林、對手是招式最好懂的豎琴精靈，由遊戲中的教學卡帶著玩；第二局起才看到選角畫面。
// 好友邀請 / 即時多人優先；開局前不播廣告
const invite = crazygames.startupInvite()
const instant = !invite && crazygames.isInstantMultiplayer()
const screen = shallowRef<screens.Screen>(
  screens.initialScreen({ role: qRole, invite, instant, newPlayer: isCrazyGames && !qRole && isNewPlayer(), sheetOnStart: !isCrazyGames }),
)
// 多人房間的連線：在大廳（選角畫面）與多人對局之間都存在
const room = shallowRef<Room | null>(null)

function go(next: screens.Screen) {
  screen.value = next
}

function joinInvite(code: string) {
  room.value?.leave()
  go(screens.invited(code))
}

// ?role=goblin 直接進入、或新玩家當哥布林時也要決定 AI 精靈（新玩家固定豎琴精靈）
if (screen.value.kind === 'solo' && screen.value.role === 'goblin' && !isElfKind(qElf))
  elfKind.value = qRole ? (Math.random() < 0.5 ? 'harp' : 'violin') : 'harp'

onMounted(() => {
  crazygames.loadingFinished()
  crazygames.onInvite(joinInvite)
  // 在選角畫面時就於背景下載精靈模型（這局會用到的先），開局時不必等下載。
  // 另一位精靈等第一次進入遊玩後才下載（CrazyGames 的初始下載量算到第一次 gameplayStart；網站版立即放行）
  const [first, second] = elfKind.value === 'violin' ? (['violin', 'harp'] as const) : (['harp', 'violin'] as const)
  void preloadElves([first])
    .then(() => crazygames.afterFirstGameplay())
    .then(() => preloadElves([second]))
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
  () => screen.value.kind === 'menu',
  (inMenu) => inMenu && music.play('menu'),
  { immediate: true },
)

// 每回合開始前播插頁廣告（是否真的播放由 CrazyGames 決定）。
// 廣告期間畫面可能已經變了（例如收到好友邀請而回到選角畫面並自動加入房間），這時不再進入單機對局
async function newRound(r: Role, kind?: ElfKind) {
  if (busy) return
  busy = true
  const from = screen.value
  await crazygames.commercialBreak()
  busy = false
  if (screen.value !== from) return
  go(screens.startSolo(from, r))
  if (r === 'elf') elfKind.value = kind ?? elfKind.value
  else if (!isElfKind(qElf)) elfKind.value = Math.random() < 0.5 ? 'harp' : 'violin'
  round.value++
}

function attach(r: Room) {
  go(screens.roomAttached(screen.value))
  room.value = r
  r.onStart = (l) => {
    go(screens.roomStarted(l))
    round.value++
  }
  r.onClose = (why) => {
    room.value = null
    go(screens.roomClosed(screen.value, why))
  }
  if (r.current) r.onStart(r.current)
}

function leaveLobby() {
  go(screens.closeSheet(screen.value))
  room.value?.leave()
}

function backToRoom() {
  go(screens.backToLobby(screen.value))
  room.value?.backToLobby()
}

// 多人回合之間不播插頁廣告（會讓玩家不同步）；CrazyGames 也不允許在導覽按鈕上播廣告，離開房間不播
function leaveRoom() {
  room.value?.leave()
  go(screens.closeSheet(screen.value))
}
</script>

<template>
  <GameView
    v-if="screen.kind === 'online'"
    :key="'mp' + round"
    :role="screen.link.me === 'elf' ? 'elf' : 'goblin'"
    :net="screen.link"
    @restart="backToRoom"
    @menu="leaveRoom"
  />
  <GameView
    v-else-if="screen.kind === 'solo'"
    :key="round"
    :role="screen.role"
    :elf-kind="elfKind"
    @restart="newRound(screen.role, elfKind)"
    @menu="go(screens.toMenu(screen))"
  />
  <template v-else>
    <CharacterSelect :room="room" @start="newRound" @multiplayer="go(screens.openSheet(screen))" @leave="leaveLobby" />
    <RoomSheet
      v-if="screen.sheet"
      :key="screen.sheet.auto?.kind === 'join' ? screen.sheet.auto.code : ''"
      :auto="screen.sheet.auto"
      :room="room"
      :error="screen.sheet.error"
      @close="go(screens.closeSheet(screen))"
      @leave="leaveLobby"
      @room="attach"
    />
  </template>
  <div class="rotate">
    <img :src="icon('ui-rotate')" alt="" />
    <span>{{ t('rotate') }}</span>
    <!-- 網站版：教玩家加入主畫面（之後以全螢幕開啟，見 input/install.ts） -->
    <section v-if="installGuide" class="install">
      <h2>{{ t('installTitle') }}</h2>
      <ol v-if="installGuide === 'ios'">
        <li>
          <template v-for="(part, i) in t('installIos1').split('{share}')" :key="i">
            <svg v-if="i" class="share" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M8 10H6v10h12V10h-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>{{ part }}
          </template>
        </li>
        <li>{{ t('installIos2') }}</li>
        <li>{{ t('installIos3') }}</li>
      </ol>
      <template v-else>
        <button v-if="canPrompt" class="install-btn" @click="promptInstall">{{ t('installButton') }}</button>
        <ol>
          <li>{{ t('installAndroid1') }}</li>
          <li>{{ t('installAndroid2') }}</li>
          <li>{{ t('installAndroid3') }}</li>
        </ol>
      </template>
    </section>
  </div>
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
    padding: 24px 16px;
    overflow-y: auto;
    box-sizing: border-box;
    background: #0b1411;
    color: #fff3d6;
    font-family: var(--font);
    font-size: 48px;
  }
  .rotate img {
    width: 96px;
    height: 96px;
  }
  .rotate span {
    font-size: 18px;
  }
  .install {
    width: min(100%, 360px);
    margin-top: 12px;
    padding: 16px 18px;
    border: 1px solid rgba(255, 240, 200, 0.25);
    border-radius: 14px;
    background: rgba(255, 243, 214, 0.06);
    font-size: 15px;
    line-height: 1.5;
    text-align: left;
  }
  .install h2 {
    margin: 0 0 10px;
    font-size: 16px;
    color: #ffd98a;
  }
  .install ol {
    margin: 0;
    padding-left: 1.3em;
  }
  .install li + li {
    margin-top: 6px;
  }
  .install .share {
    width: 1.2em;
    height: 1.2em;
    margin: 0 2px;
    vertical-align: -0.2em;
  }
  .install-btn {
    display: block;
    width: 100%;
    margin-bottom: 12px;
    padding: 10px;
    border: 0;
    border-radius: 10px;
    background: linear-gradient(#ffd98a, #c9a24e);
    color: #2a1d08;
    font: inherit;
    font-weight: 700;
  }
}
</style>
