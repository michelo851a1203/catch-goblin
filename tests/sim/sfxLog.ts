// 模擬中播放的音效（audio 模組的替身寫入；不能 import 其他 src 模組，避免 vi.mock 循環等待）
export const sfxLog: string[] = []
