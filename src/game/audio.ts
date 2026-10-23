// 以 WebAudio 合成的簡易音效，不需要外部音檔
let ctx: AudioContext | null = null
let master: GainNode | null = null
let muted = false
const VOLUME = 0.35

function ac() {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = muted ? 0 : VOLUME
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

// 廣告播放或分頁隱藏時靜音
export function setMuted(on: boolean) {
  muted = on
  if (master) master.gain.value = on ? 0 : VOLUME
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.4, when = 0, slideTo?: number) {
  const c = ac()
  const t = c.currentTime + when
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t)
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(master!)
  o.start(t)
  o.stop(t + dur + 0.05)
}

const harpScale = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.5]

export const sfx = {
  unlock() {
    ac()
  },
  flip() {
    tone(400, 0.25, 'triangle', 0.25, 0, 900)
  },
  gaze() {
    tone(880, 0.35, 'sine', 0.3, 0, 1760)
    tone(1320, 0.3, 'sine', 0.15, 0.05, 2000)
  },
  harpNote(i: number) {
    const f = harpScale[i % harpScale.length]
    tone(f, 1.2, 'triangle', 0.22)
    tone(f * 2, 0.6, 'sine', 0.06)
  },
  stun() {
    tone(180, 0.18, 'square', 0.25, 0, 60)
    tone(1200, 0.25, 'triangle', 0.12, 0.08, 1600)
  },
  pack() {
    tone(220, 0.08, 'sawtooth', 0.08)
  },
  captured() {
    ;[392, 494, 587, 784].forEach((f, i) => tone(f, 0.3, 'triangle', 0.25, i * 0.09))
  },
  dash() {
    tone(300, 0.3, 'sawtooth', 0.1, 0, 900)
  },
  breakFree() {
    tone(150, 0.4, 'square', 0.25, 0, 600)
    tone(600, 0.3, 'triangle', 0.2, 0.1, 1200)
  },
  interfere() {
    tone(260, 0.15, 'square', 0.2, 0, 520)
    tone(520, 0.15, 'square', 0.15, 0.08, 260)
  },
  alarm() {
    tone(988, 0.12, 'square', 0.12)
    tone(988, 0.12, 'square', 0.12, 0.18)
  },
  tick() {
    tone(660, 0.1, 'sine', 0.2)
  },
  win() {
    ;[523, 659, 784, 1047].forEach((f, i) => tone(f, 0.5, 'triangle', 0.3, i * 0.15))
  },
  lose() {
    ;[392, 330, 262, 196].forEach((f, i) => tone(f, 0.5, 'triangle', 0.3, i * 0.18))
  },
}
