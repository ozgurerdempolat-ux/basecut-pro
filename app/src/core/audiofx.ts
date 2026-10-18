// Audio effects: ffmpeg filters for export and a Web Audio description for the
// live preview (same parameters). Effects whose preview cannot be exact (noise
// reduction, pitch) say so in the UI.

export interface AudioFxParam { key: string; label: string; min: number; max: number; step: number; def: number; unit?: string }

export interface AudioFxDef {
  id: string;
  name: string;
  category: 'Temizlik' | 'Ton ve EQ' | 'Dinamik' | 'Stilize';
  params: AudioFxParam[];
  ffmpeg: (p: Record<string, number>, sampleRate: number) => string;
  /** preview graph: a list of Web Audio nodes to build in series */
  preview: (p: Record<string, number>) => PreviewNode[];
  /** true when the preview is only an approximation */
  approxPreview?: boolean;
  desc?: string;
}

export type PreviewNode =
  | { type: 'biquad'; filter: BiquadFilterType; frequency: number; gain?: number; Q?: number }
  | { type: 'compressor'; threshold: number; ratio: number; attack: number; release: number; knee?: number }
  | { type: 'gain'; db: number }
  | { type: 'reverb'; seconds: number; mix: number };

export interface AudioEffect { id: string; type: string; enabled: boolean; params: Record<string, number> }

const f = (n: number) => Number(n.toFixed(5)).toString();

export const AUDIO_EFFECTS: AudioFxDef[] = [
  {
    id: 'voice', name: 'Konuşmayı netleştir', category: 'Temizlik', approxPreview: true,
    desc: 'Uğultuyu keser, arka plan gürültüsünü azaltır, sesi öne çıkarır ve dengeler — tek tıkla röportaj sesi',
    params: [{ key: 'amount', label: 'Miktar', min: 0, max: 100, step: 1, def: 70, unit: '%' }],
    ffmpeg: (p) => { const a = p.amount / 100; return `highpass=f=85,afftdn=nr=${f(6 + 14 * a)}:nf=-30,equalizer=f=3200:t=q:w=1.2:g=${f(4 * a)},equalizer=f=250:t=q:w=1:g=${f(-3 * a)},acompressor=threshold=${f(-24 + 6 * (1 - a))}dB:ratio=${f(2 + 2 * a)}:attack=8:release=120:makeup=${f(1 + 2 * a)}`; },
    preview: (p) => { const a = p.amount / 100; return [{ type: 'biquad', filter: 'highpass', frequency: 85 }, { type: 'biquad', filter: 'peaking', frequency: 3200, Q: 1.2, gain: 4 * a }, { type: 'biquad', filter: 'peaking', frequency: 250, Q: 1, gain: -3 * a }, { type: 'compressor', threshold: -24 + 6 * (1 - a), ratio: 2 + 2 * a, attack: 0.008, release: 0.12 }, { type: 'gain', db: 4 * a }]; },
  },
  {
    id: 'denoise', name: 'Gürültü azalt', category: 'Temizlik', approxPreview: true,
    desc: 'Klima, fan, cızırtı gibi sürekli arka plan seslerini azaltır (tam etki dışa aktarımda)',
    params: [{ key: 'amount', label: 'Azaltma', min: 1, max: 40, step: 1, def: 15, unit: ' dB' }],
    ffmpeg: (p) => `afftdn=nr=${f(p.amount)}:nf=-30:tn=1`,
    preview: () => [{ type: 'biquad', filter: 'highpass', frequency: 70 }],
  },
  {
    id: 'highpass', name: 'Uğultu kesici (alçak frekans)', category: 'Temizlik',
    params: [{ key: 'freq', label: 'Kesim', min: 20, max: 400, step: 1, def: 90, unit: ' Hz' }],
    ffmpeg: (p) => `highpass=f=${f(p.freq)}:poles=2`,
    preview: (p) => [{ type: 'biquad', filter: 'highpass', frequency: p.freq, Q: 0.707 }],
  },
  {
    id: 'deesser', name: 'Sızıltı giderici (de-esser)', category: 'Temizlik', approxPreview: true,
    params: [{ key: 'amount', label: 'Miktar', min: 0, max: 100, step: 1, def: 50, unit: '%' }],
    ffmpeg: (p) => `deesser=i=${f(p.amount / 100)}:m=0.5:f=0.5`,
    preview: (p) => [{ type: 'biquad', filter: 'peaking', frequency: 6500, Q: 2, gain: -8 * (p.amount / 100) }],
  },
  {
    id: 'eq', name: '3 bant EQ', category: 'Ton ve EQ',
    params: [{ key: 'low', label: 'Bas (120 Hz)', min: -15, max: 15, step: 0.5, def: 0, unit: ' dB' }, { key: 'mid', label: 'Orta (1 kHz)', min: -15, max: 15, step: 0.5, def: 0, unit: ' dB' }, { key: 'high', label: 'Tiz (8 kHz)', min: -15, max: 15, step: 0.5, def: 0, unit: ' dB' }],
    ffmpeg: (p) => `bass=g=${f(p.low)}:f=120:t=s:w=0.7,equalizer=f=1000:t=q:w=1:g=${f(p.mid)},treble=g=${f(p.high)}:f=8000:t=s:w=0.7`,
    preview: (p) => [{ type: 'biquad', filter: 'lowshelf', frequency: 120, gain: p.low }, { type: 'biquad', filter: 'peaking', frequency: 1000, Q: 1, gain: p.mid }, { type: 'biquad', filter: 'highshelf', frequency: 8000, gain: p.high }],
  },
  {
    id: 'bassboost', name: 'Bas güçlendirici', category: 'Ton ve EQ',
    params: [{ key: 'gain', label: 'Güç', min: 0, max: 18, step: 0.5, def: 6, unit: ' dB' }],
    ffmpeg: (p) => `bass=g=${f(p.gain)}:f=90:t=s:w=0.6`,
    preview: (p) => [{ type: 'biquad', filter: 'lowshelf', frequency: 90, gain: p.gain }],
  },
  {
    id: 'compressor', name: 'Kompresör', category: 'Dinamik',
    params: [{ key: 'threshold', label: 'Eşik', min: -60, max: 0, step: 1, def: -20, unit: ' dB' }, { key: 'ratio', label: 'Oran', min: 1, max: 20, step: 0.5, def: 4 }, { key: 'makeup', label: 'Telafi', min: 0, max: 24, step: 0.5, def: 4, unit: ' dB' }],
    ffmpeg: (p) => `acompressor=threshold=${f(p.threshold)}dB:ratio=${f(p.ratio)}:attack=10:release=150:makeup=${f(Math.pow(10, p.makeup / 20))}`,
    preview: (p) => [{ type: 'compressor', threshold: p.threshold, ratio: p.ratio, attack: 0.01, release: 0.15 }, { type: 'gain', db: p.makeup }],
  },
  {
    id: 'limiter', name: 'Limitör (patlamayı önle)', category: 'Dinamik',
    params: [{ key: 'ceiling', label: 'Tavan', min: -12, max: 0, step: 0.1, def: -1, unit: ' dB' }],
    ffmpeg: (p) => `alimiter=limit=${f(Math.pow(10, p.ceiling / 20))}:attack=5:release=50:level=disabled`,
    preview: (p) => [{ type: 'compressor', threshold: p.ceiling - 1, ratio: 20, attack: 0.003, release: 0.05, knee: 0 }],
  },
  {
    id: 'gain', name: 'Kazanç', category: 'Dinamik',
    params: [{ key: 'db', label: 'Kazanç', min: -24, max: 24, step: 0.5, def: 6, unit: ' dB' }],
    ffmpeg: (p) => `volume=${f(p.db)}dB`,
    preview: (p) => [{ type: 'gain', db: p.db }],
  },
  {
    id: 'reverb', name: 'Oda yankısı', category: 'Stilize', approxPreview: true,
    params: [{ key: 'size', label: 'Oda', min: 0, max: 100, step: 1, def: 40, unit: '%' }, { key: 'mix', label: 'Karışım', min: 0, max: 100, step: 1, def: 25, unit: '%' }],
    ffmpeg: (p) => { const s = p.size / 100, m = p.mix / 100; const d1 = Math.round(30 + 60 * s), d2 = Math.round(50 + 110 * s); return `aecho=1:${f(1 - m * 0.5)}:${d1}|${d2}:${f(0.45 * m + 0.1)}|${f(0.3 * m + 0.05)}`; },
    preview: (p) => [{ type: 'reverb', seconds: 0.4 + 2 * (p.size / 100), mix: p.mix / 100 }],
  },
  {
    id: 'telephone', name: 'Telefon sesi', category: 'Stilize',
    params: [{ key: 'amount', label: 'Miktar', min: 0, max: 100, step: 1, def: 100, unit: '%' }],
    ffmpeg: (p) => { const a = p.amount / 100; return `highpass=f=${f(80 + 220 * a)},lowpass=f=${f(16000 - 12600 * a)},volume=${f(3 * a)}dB`; },
    preview: (p) => { const a = p.amount / 100; return [{ type: 'biquad', filter: 'highpass', frequency: 80 + 220 * a }, { type: 'biquad', filter: 'lowpass', frequency: 16000 - 12600 * a }, { type: 'gain', db: 3 * a }]; },
  },
  {
    id: 'pitch', name: 'Ses perdesi (ince/kalın)', category: 'Stilize', approxPreview: true,
    desc: 'Konuşma hızını değiştirmeden sesi inceltir ya da kalınlaştırır (dışa aktarımda)',
    params: [{ key: 'semitones', label: 'Yarım ton', min: -12, max: 12, step: 1, def: 4 }],
    ffmpeg: (p, sr) => { const k = Math.pow(2, p.semitones / 12); return `asetrate=${Math.round(sr * k)},aresample=${sr},atempo=${f(1 / k)}`; },
    preview: () => [],
  },
];

export const AUDIO_FX_BY_ID: Record<string, AudioFxDef> = Object.fromEntries(AUDIO_EFFECTS.map((e) => [e.id, e]));

export function defaultAudioParams(id: string): Record<string, number> {
  return Object.fromEntries((AUDIO_FX_BY_ID[id]?.params ?? []).map((p) => [p.key, p.def]));
}

export function audioFxChain(list: AudioEffect[] | undefined, sampleRate: number): string[] {
  const out: string[] = [];
  for (const e of list ?? []) {
    if (!e.enabled) continue;
    const d = AUDIO_FX_BY_ID[e.type];
    if (d) out.push(d.ffmpeg(e.params, sampleRate));
  }
  return out;
}

// ------------------------------------------------------------------ audio crossfades

export const AUDIO_TRANSITIONS: { id: string; name: string; curve: string }[] = [
  { id: 'constant-power', name: 'Sabit güç (önerilen)', curve: 'qsin' },
  { id: 'constant-gain', name: 'Sabit kazanç (doğrusal)', curve: 'tri' },
  { id: 'exponential', name: 'Üstel', curve: 'exp' },
];

export function fadeGain(curve: string, x: number): number {
  const t = Math.max(0, Math.min(1, x));
  if (curve === 'qsin') return Math.sin((t * Math.PI) / 2);
  if (curve === 'exp') return t * t;
  return t;
}
