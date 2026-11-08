// 遊戲圖示（由 assets/img 的預覽圖裁切成圓形 WebP，含金框）；取代原本的 emoji
const files = import.meta.glob('./assets/icons/*.webp', { eager: true, import: 'default' }) as Record<string, string>

export const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.replace(/^.*\/(.+)\.webp$/, '$1'), url]),
)

export type IconName =
  | 'skill-gaze' | 'skill-music' | 'skill-stun' | 'skill-capture' | 'skill-stealth' | 'skill-reveal' | 'skill-eye' | 'skill-blink'
  | 'skill-charge' | 'skill-dash' | 'skill-interfere' | 'skill-ult' | 'skill-ult-used' | 'skill-radar'
  | 'icon-elf-harp' | 'icon-elf-violin' | 'icon-goblin' | 'icon-goblin-caught' | 'icon-random' | 'icon-stunned'
  | 'ui-timer' | 'ui-goal' | 'ui-settings' | 'ui-move' | 'ui-multiplayer' | 'ui-spectate' | 'ui-fast' | 'ui-play'
  | 'ui-close' | 'ui-rotate' | 'ui-alert' | 'ui-warning'

export function icon(name: IconName): string {
  return ICONS[name] ?? ''
}

// 文字開頭的 emoji → 圖示（翻譯字串、提示訊息、3D 標籤共用），回傳去掉 emoji 後的文字
const LEADING: [string, IconName][] = [
  ['🧝‍♀️', 'icon-elf-harp'],
  ['👁️', 'skill-eye'],
  ['⚙️', 'ui-settings'],
  ['❗', 'ui-alert'],
  ['⚠', 'ui-warning'],
  ['💜', 'skill-stealth'],
  ['🎵', 'skill-music'],
  ['👀', 'ui-spectate'],
  ['⏩', 'ui-fast'],
  ['▶', 'ui-play'],
  ['🧭', 'ui-move'],
  ['👺', 'icon-goblin'],
  ['👥', 'ui-multiplayer'],
  ['💥', 'icon-stunned'],
]

export function splitIcon(text: string): { icon: IconName | null; text: string } {
  for (const [e, name] of LEADING) {
    if (text.startsWith(e)) return { icon: name, text: text.slice(e.length).replace(/^[️\s]+/, '') }
  }
  return { icon: null, text }
}
