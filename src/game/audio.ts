/**
 * Geräusche, komplett mit WebAudio erzeugt (keine Tondateien): Wurf, Aufprall, Rollen,
 * Platschen, Stein, Zieljubel. Startet erst nach der ersten Berührung (Browser-Regel).
 */

const KEY = 'bosel.sound';

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private roll: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  enabled = true;

  constructor() {
    try {
      this.enabled = localStorage.getItem(KEY) !== 'off';
    } catch {
      // ohne Speicher bleibt der Ton an
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
      // egal
    }
    if (this.master) this.master.gain.value = on ? 0.8 : 0;
  }

  /** Bei einer Berührung aufrufen: erst dann darf der Browser Ton abspielen. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.8 : 0;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  private burst(duration: number, type: BiquadFilterType, freq: number, q: number, volume: number, attack = 0.005): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + duration + 0.05);
  }

  private tone(freq: number, start: number, duration: number, volume: number, type: OscillatorType = 'sine'): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    const t = ctx.currentTime + start;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  /** Luftzug beim Abwurf. */
  whoosh(power: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.2;
    const t = ctx.currentTime;
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.exponentialRampToValueAtTime(1600 + power * 1400, t + 0.25);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.25 + power * 0.3, t + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + 0.5);
  }

  /** Dumpfes „Tock“ der Gummikugel auf Asphalt; `soft` für Gras. */
  bounce(strength: number, soft = false): void {
    const v = Math.min(1, strength);
    this.tone(soft ? 70 : 110 + v * 40, 0, soft ? 0.12 : 0.09, 0.35 * v, 'sine');
    this.burst(soft ? 0.08 : 0.05, 'lowpass', soft ? 500 : 1800, 0.7, 0.4 * v);
  }

  splash(): void {
    this.burst(0.5, 'bandpass', 900, 0.6, 0.6, 0.01);
    this.burst(0.25, 'highpass', 3000, 0.5, 0.25);
  }

  clack(): void {
    this.tone(900, 0, 0.05, 0.3, 'square');
    this.burst(0.06, 'highpass', 2500, 1, 0.4);
  }

  /** Kurze Fanfare im Ziel. */
  fanfare(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.12, i === 3 ? 0.6 : 0.2, 0.22, 'triangle'));
  }

  /** Rollgeräusch: Rauschen, dessen Lautstärke und Höhe dem Tempo folgen (0 = still). */
  rolling(speed: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    if (!this.roll) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      this.roll = { gain, filter };
    }
    const t = ctx.currentTime;
    this.roll.gain.gain.setTargetAtTime(Math.min(0.35, speed * 0.03), t, 0.05);
    this.roll.filter.frequency.setTargetAtTime(200 + speed * 90, t, 0.05);
  }
}

export const sound = new Sound();

/** Kurzes Vibrieren (Android); still, wo es nicht geht. */
export function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // nicht unterstützt
  }
}
