<script setup lang="ts">
import { fullscreenSupported, isFullscreen, toggleFullscreen } from '../input/fullscreen'
import { touchMode } from '../input/touch'
import { t } from '../i18n'
</script>

<template>
  <button
    v-if="touchMode && fullscreenSupported"
    class="fs"
    data-fs-toggle
    :aria-label="isFullscreen ? t('fullscreenExit') : t('fullscreenEnter')"
    :title="isFullscreen ? t('fullscreenExit') : t('fullscreenEnter')"
    @click="toggleFullscreen"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        v-if="!isFullscreen"
        d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"
      />
      <path v-else d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" />
    </svg>
  </button>
</template>

<style scoped>
.fs {
  width: 44px;
  height: 44px;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid rgba(240, 210, 140, 0.6);
  background: rgba(20, 16, 10, 0.62);
  color: #e6c878;
  cursor: pointer;
  touch-action: manipulation;
}
.fs svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
