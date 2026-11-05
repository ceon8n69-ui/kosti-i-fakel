/**
 * Звук на Web Audio: синтез без файлов (этапы 0–4). Финальные сэмплы подменяются через манифест.
 * Контекст создаётся по первому касанию — так требуют мобильные браузеры.
 */
type Kind = "dice" | "hit" | "block" | "heal" | "death" | "victory" | "defeat" | "crit" | "fumble" | "torch" | "tap";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = (() => {
  try {
    return localStorage.getItem("kf.muted") === "1";
  } catch {
    return false;
  }
})();

export function unlockAudio(): void {
  if (ctx) {
    if (ctx.state === "suspended") void ctx.resume();
    return;
  }
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.6;
  master.connect(ctx.destination);
}

export const isMuted = () => muted;
export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem("kf.muted", m ? "1" : "0");
  } catch {
    /* приватный режим */
  }
  if (master) master.gain.value = m ? 0 : 0.6;
}

function noise(dur: number): AudioBufferSourceNode {
  const c = ctx!;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
  const s = c.createBufferSource();
  s.buffer = buf;
  return s;
}

function tone(freq: number, dur: number, type: OscillatorType, vol: number, at = 0, slideTo?: number): void {
  const c = ctx!;
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** strength 0..1 — сила удара кубика о стол. */
export function play(kind: Kind, strength = 1): void {
  if (!ctx || !master || muted) return;
  const c = ctx;
  switch (kind) {
    case "dice": {
      const s = noise(0.06);
      const f = c.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 1800 + Math.random() * 1600;
      f.Q.value = 4;
      const g = c.createGain();
      g.gain.value = 0.25 + 0.6 * strength;
      s.connect(f).connect(g).connect(master);
      s.start();
      break;
    }
    case "hit": {
      tone(140, 0.18, "sine", 0.6, 0, 50);
      const s = noise(0.08);
      const g = c.createGain();
      g.gain.value = 0.35;
      s.connect(g).connect(master);
      s.start();
      break;
    }
    case "block":
      tone(880, 0.25, "triangle", 0.25);
      tone(1320, 0.2, "sine", 0.12, 0.01);
      break;
    case "heal":
      tone(523, 0.18, "sine", 0.2);
      tone(784, 0.25, "sine", 0.18, 0.08);
      break;
    case "death":
      tone(220, 0.6, "sawtooth", 0.15, 0, 55);
      break;
    case "victory":
      [392, 494, 587, 784].forEach((f, i) => tone(f, 0.35, "triangle", 0.22, i * 0.12));
      break;
    case "defeat":
      [330, 262, 196].forEach((f, i) => tone(f, 0.5, "sine", 0.22, i * 0.2));
      break;
    case "crit":
      [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.4, "triangle", 0.2, i * 0.06));
      break;
    case "fumble":
      tone(196, 0.7, "sawtooth", 0.18, 0, 98);
      break;
    case "torch": {
      const s = noise(0.25);
      const f = c.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 600;
      const g = c.createGain();
      g.gain.value = 0.2;
      s.connect(f).connect(g).connect(master);
      s.start();
      break;
    }
    case "tap":
      tone(660, 0.05, "sine", 0.08);
      break;
  }
}
