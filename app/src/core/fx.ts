import { IMPACTS } from './impact';
// Effects and transitions: the shared definitions. Each effect has parameters
// and an ffmpeg filter builder (export); the renderer has a matching preview
// implementation keyed by the same id. Pixel sizes are given as % of the frame
// height so preview (any size) and export (full size) agree.

export interface FxParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  unit?: string;
  /** shown as a colour picker; value stored as 0xRRGGBB */
  color?: boolean;
  /** shown as a dropdown: value = index */
  options?: string[];
}

export interface FxDef {
  id: string;
  name: string;
  category: 'Sabitleme' | 'Bulanıklık ve netlik' | 'Renk ve stil' | 'Bozulma' | 'Stilize' | 'Hareket' | 'Anahtarlama' | 'Kadraj';
  params: FxParamDef[];
  /** ffmpeg filter chain for one clip; input is the decoded clip at its source size (sw×sh), output same size */
  ffmpeg: (p: Record<string, number>, ctx: { fps: number; W: number; H: number; sw: number; sh: number }) => string;
  /** 'motion' effects change the clip's position/scale (see motionOf) instead of filtering pixels */
  kind?: 'filter' | 'motion' | 'blurfill' | 'stabilize';
  /** needs alpha in the output (keying) */
  alpha?: boolean;
  desc?: string;
}

export interface ClipEffect {
  id: string;
  type: string;
  enabled: boolean;
  params: Record<string, number>;
}

export interface TransitionSpec {
  type: string;
  /** frames */
  duration: number;
}

const f = (n: number) => Number(n.toFixed(5)).toString();
const hex = (v: number) => `0x${Math.round(v).toString(16).padStart(6, '0')}`;

/** deterministic pseudo-random jitter used by shake/glitch, same formula in preview and export */
export const JITTER = {
  // value in -1..1 that changes every `hold` frames
  expr: (seed: number, hold: number) => `(2*random(${seed})-1)`, // not used for export (random() isn't reproducible); see sinExpr
  sinExpr: (k: number, phase: number, v = 'n') => `sin(${v}*${f(k)}+${f(phase)})*cos(${v}*${f(k * 0.53)}+${f(phase * 1.7)})`,
  sin: (n: number, k: number, phase: number) => Math.sin(n * k + phase) * Math.cos(n * k * 0.53 + phase * 1.7),
};

export const EFFECTS: FxDef[] = [
  // --------------------------------------------------- stabilisation (rendered in the background, core/stabilize.ts)
  {
    id: 'warpstab', name: 'Warp Stabilizer (sabitleyici)', category: 'Sabitleme', kind: 'stabilize',
    desc: 'Titrek elde çekimi pürüzsüzleştirir ya da tripod gibi sabitler. Arka planda analiz eder; önizleme ve dışa aktarım birebir aynıdır.',
    params: [
      { key: 'mode', label: 'Sonuç', min: 0, max: 1, step: 1, def: 0, options: ['Pürüzsüz hareket', 'Hareketsiz (tripod)'] },
      { key: 'smooth', label: 'Pürüzsüzlük', min: 0, max: 100, step: 1, def: 50, unit: '%' },
      { key: 'edges', label: 'Kenarlar', min: 0, max: 3, step: 1, def: 0, options: ['Kırp ve büyüt (otomatik)', 'Uyarlamalı zoom', 'Kenarları sentezle', 'Siyah kenar (kırpma yok)'] },
      { key: 'zoom', label: 'Ek ölçek', min: 0, max: 40, step: 1, def: 0, unit: '%' },
      { key: 'sharpen', label: 'Netleştir', min: 0, max: 100, step: 1, def: 30, unit: '%' },
      { key: 'detail', label: 'Analiz', min: 0, max: 1, step: 1, def: 0, options: ['Hızlı', 'Detaylı (az dokulu çekimler)'] },
    ],
    ffmpeg: () => 'null',
  },
  // --------------------------------------------------- blur & sharpen
  {
    id: 'blur', name: 'Gauss bulanıklığı', category: 'Bulanıklık ve netlik',
    params: [{ key: 'amount', label: 'Miktar', min: 0, max: 10, step: 0.05, def: 1.5, unit: '%' }],
    ffmpeg: (p, c) => (p.amount > 0 ? `gblur=sigma=${f((p.amount / 100) * c.sh * 0.5)}` : 'null'),
  },
  {
    id: 'sharpen', name: 'Keskinleştir', category: 'Bulanıklık ve netlik',
    params: [{ key: 'amount', label: 'Miktar', min: 0, max: 3, step: 0.05, def: 1 }],
    ffmpeg: (p) => `unsharp=5:5:${f(p.amount)}:5:5:0`,
  },
  {
    id: 'blurfill', name: 'Bulanık arka plan (dikey video)', category: 'Kadraj',
    desc: 'Kenarlardaki siyah boşlukları klibin bulanık, yakınlaştırılmış kopyasıyla doldurur',
    params: [{ key: 'blur', label: 'Bulanıklık', min: 1, max: 10, step: 0.1, def: 4, unit: '%' }, { key: 'dim', label: 'Karartma', min: 0, max: 80, step: 1, def: 25, unit: '%' }],
    ffmpeg: () => 'null', kind: 'blurfill', // handled by the render graph (a blurred layer under the clip)
  },
  // --------------------------------------------------- colour & style
  {
    id: 'bw', name: 'Siyah beyaz', category: 'Renk ve stil',
    params: [{ key: 'amount', label: 'Miktar', min: 0, max: 100, step: 1, def: 100, unit: '%' }],
    ffmpeg: (p) => `hue=s=${f(1 - p.amount / 100)}`,
  },
  {
    id: 'sepia', name: 'Sepya', category: 'Renk ve stil',
    params: [{ key: 'amount', label: 'Miktar', min: 0, max: 100, step: 1, def: 100, unit: '%' }],
    ffmpeg: (p) => {
      const a = p.amount / 100, b = 1 - a;
      // CSS sepia() matrix, mixed with identity by amount
      const m = [0.393 * a + b, 0.769 * a, 0.189 * a, 0.349 * a, 0.686 * a + b, 0.168 * a, 0.272 * a, 0.534 * a, 0.131 * a + b];
      return `colorchannelmixer=rr=${f(m[0])}:rg=${f(m[1])}:rb=${f(m[2])}:gr=${f(m[3])}:gg=${f(m[4])}:gb=${f(m[5])}:br=${f(m[6])}:bg=${f(m[7])}:bb=${f(m[8])}`;
    },
  },
  {
    id: 'invert', name: 'Ters renk (negatif)', category: 'Renk ve stil', params: [],
    ffmpeg: () => 'negate',
  },
  {
    id: 'hue', name: 'Renk tonu kaydır', category: 'Renk ve stil',
    params: [{ key: 'deg', label: 'Açı', min: -180, max: 180, step: 1, def: 90, unit: '°' }],
    ffmpeg: (p) => `hue=h=${f(p.deg)}`,
  },
  {
    id: 'brightcontrast', name: 'Parlaklık ve kontrast', category: 'Renk ve stil',
    params: [{ key: 'brightness', label: 'Parlaklık', min: -100, max: 100, step: 1, def: 0 }, { key: 'contrast', label: 'Kontrast', min: -100, max: 100, step: 1, def: 0 }],
    ffmpeg: (p) => `eq=brightness=${f(p.brightness / 200)}:contrast=${f(1 + p.contrast / 100)}`,
  },
  {
    id: 'posterize', name: 'Posterize', category: 'Stilize',
    params: [{ key: 'levels', label: 'Seviye', min: 2, max: 16, step: 1, def: 5 }],
    ffmpeg: (p) => { const l = Math.max(2, Math.round(p.levels)) - 1; const e = `'floor(val/255*${l}+0.5)*255/${l}'`; return `format=rgb24,lutrgb=r=${e}:g=${e}:b=${e}`; },
  },
  {
    id: 'tint', name: 'Renklendir', category: 'Renk ve stil',
    params: [{ key: 'color', label: 'Renk', min: 0, max: 0xffffff, step: 1, def: 0xff6a3d, color: true }, { key: 'amount', label: 'Miktar', min: 0, max: 100, step: 1, def: 40, unit: '%' }],
    ffmpeg: (p) => {
      const c = Math.round(p.color), r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255, a = p.amount / 100;
      // luminance-preserving tint: mix grey→colour by amount
      return `colorchannelmixer=rr=${f(1 - a + a * r * 0.299)}:rg=${f(a * r * 0.587)}:rb=${f(a * r * 0.114)}:gr=${f(a * g * 0.299)}:gg=${f(1 - a + a * g * 0.587)}:gb=${f(a * g * 0.114)}:br=${f(a * b * 0.299)}:bg=${f(a * b * 0.587)}:bb=${f(1 - a + a * b * 0.114)}`;
    },
  },
  // --------------------------------------------------- distort
  {
    id: 'pixelate', name: 'Pikselleştir', category: 'Bozulma',
    params: [{ key: 'size', label: 'Blok boyutu', min: 0.2, max: 10, step: 0.1, def: 2, unit: '%' }],
    ffmpeg: (p, c) => {
      const b = Math.max(1, (p.size / 100) * c.sh);
      return `scale=${Math.max(2, Math.round(c.sw / b))}:${Math.max(2, Math.round(c.sh / b))}:flags=area,scale=${c.sw}:${c.sh}:flags=neighbor`;
    },
  },
  {
    id: 'mirror', name: 'Ayna', category: 'Bozulma',
    params: [{ key: 'mode', label: 'Yön (0 yatay, 1 dikey, 2 ikisi)', min: 0, max: 2, step: 1, def: 0 }],
    ffmpeg: (p) => (p.mode === 1 ? 'vflip' : p.mode === 2 ? 'hflip,vflip' : 'hflip'),
  },
  {
    id: 'rgbsplit', name: 'RGB ayrışması', category: 'Bozulma',
    params: [{ key: 'amount', label: 'Kayma', min: 0, max: 3, step: 0.05, def: 0.6, unit: '%' }],
    ffmpeg: (p, c) => { const px = Math.round((p.amount / 100) * c.sh); return `rgbashift=rh=${-px}:bh=${px}:edge=smear`; },
  },
  {
    id: 'glitch', name: 'Glitch', category: 'Bozulma',
    desc: 'Sarsıntı, renk kanalı kayması ve parazit',
    params: [{ key: 'amount', label: 'Şiddet', min: 0, max: 100, step: 1, def: 50, unit: '%' }],
    ffmpeg: (p, c) => {
      // colour shift + noise here; the frame jumps are motion (see motionOf)
      const a = p.amount / 100, px = Math.max(1, Math.round(a * 0.012 * c.sh));
      return `rgbashift=rh=${-px}:gh=${Math.round(px / 2)}:bh=${px}:edge=smear,noise=alls=${Math.round(a * 22)}:allf=t`;
    },
  },
  {
    id: 'vhs', name: 'VHS', category: 'Stilize',
    params: [{ key: 'amount', label: 'Şiddet', min: 0, max: 100, step: 1, def: 60, unit: '%' }],
    ffmpeg: (p, c) => {
      const a = p.amount / 100, px = Math.max(1, Math.round(a * 0.006 * c.sh));
      return `hue=s=${f(1 - 0.35 * a)},eq=contrast=${f(1 + 0.15 * a)}:brightness=${f(0.03 * a)},rgbashift=rh=${px}:bh=${-px}:edge=smear,` +
        `gblur=sigma=${f((0.6 * a + 0.1) * c.sh / 1080)},noise=alls=${Math.round(a * 16)}:allf=t,drawgrid=w=0:h=${Math.max(2, Math.round(c.sh / 270))}:t=1:c=black@${f(0.22 * a)}`;
    },
  },
  {
    id: 'grain', name: 'Film greni', category: 'Stilize',
    params: [{ key: 'amount', label: 'Miktar', min: 0, max: 100, step: 1, def: 35, unit: '%' }],
    ffmpeg: (p) => `noise=alls=${Math.round(p.amount * 0.4)}:allf=t+u`,
  },
  {
    id: 'edges', name: 'Kenar bulma', category: 'Stilize',
    params: [{ key: 'low', label: 'Hassasiyet', min: 2, max: 40, step: 1, def: 10, unit: '%' }],
    ffmpeg: (p) => `edgedetect=mode=colormix:low=${f(p.low / 100)}:high=${f(Math.min(0.95, (p.low / 100) * 3))}`,
  },
  {
    id: 'letterbox', name: 'Sinema bantları', category: 'Kadraj',
    params: [{ key: 'size', label: 'Bant', min: 0, max: 30, step: 0.5, def: 12, unit: '%' }],
    ffmpeg: (p) => `drawbox=x=0:y=0:w=iw:h=ih*${f(p.size / 100)}:c=black:t=fill,drawbox=x=0:y=ih-ih*${f(p.size / 100)}:w=iw:h=ih*${f(p.size / 100)}:c=black:t=fill`,
  },
  // --------------------------------------------------- motion
  {
    id: 'shake', name: 'Kamera sallantısı', category: 'Hareket',
    params: [{ key: 'amount', label: 'Şiddet', min: 0, max: 5, step: 0.05, def: 1.2, unit: '%' }, { key: 'speed', label: 'Hız', min: 0.1, max: 3, step: 0.05, def: 1 }],
    ffmpeg: () => 'null', kind: 'motion',
  },
  {
    id: 'pulse', name: 'Ritim zoom (pulse)', category: 'Hareket',
    params: [{ key: 'amount', label: 'Zoom', min: 0, max: 30, step: 0.5, def: 8, unit: '%' }, { key: 'bpm', label: 'Tempo (BPM)', min: 30, max: 200, step: 1, def: 120 }],
    ffmpeg: () => 'null', kind: 'motion',
  },
  {
    id: 'strobe', name: 'Flaş / strobe', category: 'Hareket',
    params: [{ key: 'amount', label: 'Parlaklık', min: 0, max: 100, step: 1, def: 60, unit: '%' }, { key: 'every', label: 'Her N karede', min: 2, max: 30, step: 1, def: 8 }],
    ffmpeg: (p) => `eq=brightness='${f(p.amount / 100 * 0.6)}*lt(mod(n,${Math.round(p.every)}),1)':eval=frame`,
  },
  // --------------------------------------------------- keying
  {
    id: 'chromakey', name: 'Yeşil/mavi perde (chroma key)', category: 'Anahtarlama', alpha: true,
    params: [{ key: 'color', label: 'Anahtar renk', min: 0, max: 0xffffff, step: 1, def: 0x00b140, color: true }, { key: 'similarity', label: 'Benzerlik', min: 1, max: 60, step: 0.5, def: 18, unit: '%' }, { key: 'blend', label: 'Yumuşaklık', min: 0, max: 40, step: 0.5, def: 8, unit: '%' }],
    ffmpeg: (p) => `format=yuva420p,chromakey=color=${hex(p.color)}:similarity=${f(p.similarity / 100)}:blend=${f(p.blend / 100)}`,
  },
  {
    id: 'lumakey', name: 'Siyahı şeffaf yap (luma key)', category: 'Anahtarlama', alpha: true,
    params: [{ key: 'threshold', label: 'Eşik', min: 0, max: 60, step: 0.5, def: 12, unit: '%' }, { key: 'blend', label: 'Yumuşaklık', min: 0, max: 40, step: 0.5, def: 8, unit: '%' }],
    ffmpeg: (p) => `format=yuva420p,colorkey=color=0x000000:similarity=${f(p.threshold / 100)}:blend=${f(p.blend / 100)}`,
  },
];

// ------------------------------------------------------------------ motion effects (same formulas for preview and export)

export interface Motion { dx: string; dy: string; scale: string }

/**
 * Extra position (px at output size) and scale (multiplier) from motion effects,
 * as ffmpeg expressions of `L` (frame index inside the clip) — and the same thing
 * evaluated in JS for the preview by motionAt().
 */
export function motionOf(effects: ClipEffect[] | undefined, H: number, fps: number): Motion | null {
  const on = (effects ?? []).filter((e) => e.enabled && (EFFECT_BY_ID[e.type]?.kind === 'motion' || e.type === 'glitch'));
  if (!on.length) return null;
  const dx: string[] = [], dy: string[] = [], sc: string[] = [];
  for (const e of on) {
    const p = e.params;
    if (e.type === 'shake') {
      const m = (p.amount / 100) * H, k = 0.9 * p.speed;
      dx.push(`${f(m)}*${JITTER.sinExpr(k, 0, 'L')}`);
      dy.push(`${f(m)}*${JITTER.sinExpr(k * 1.31, 2.1, 'L')}`);
      sc.push(`${f(1 + 2.2 * (p.amount / 100))}`);
    }
    if (e.type === 'pulse') {
      const period = (60 / p.bpm) * fps;
      sc.push(`(1+${f(p.amount / 100)}*pow(1-mod(L,${f(period)})/${f(period)},3))`);
    }
    if (e.type === 'glitch') {
      const a = p.amount / 100;
      dx.push(`${f(a * 0.04 * H)}*gt(mod(L,9),5)*${JITTER.sinExpr(1.7, 0.3, 'L')}`);
    }
  }
  return { dx: dx.join('+') || '0', dy: dy.join('+') || '0', scale: sc.join('*') || '1' };
}

export function motionAt(effects: ClipEffect[] | undefined, H: number, fps: number, L: number): { dx: number; dy: number; scale: number } {
  let dx = 0, dy = 0, scale = 1;
  for (const e of effects ?? []) {
    if (!e.enabled) continue;
    const p = e.params;
    if (e.type === 'shake') {
      const m = (p.amount / 100) * H, k = 0.9 * p.speed;
      dx += m * JITTER.sin(L, k, 0); dy += m * JITTER.sin(L, k * 1.31, 2.1); scale *= 1 + 2.2 * (p.amount / 100);
    }
    if (e.type === 'pulse') {
      const period = (60 / p.bpm) * fps;
      scale *= 1 + (p.amount / 100) * Math.pow(1 - (((L % period) + period) % period) / period, 3);
    }
    if (e.type === 'glitch') {
      const a = p.amount / 100;
      dx += a * 0.04 * H * (L % 9 > 5 ? 1 : 0) * JITTER.sin(L, 1.7, 0.3);
    }
  }
  return { dx, dy, scale };
}

export const EFFECT_BY_ID: Record<string, FxDef> = Object.fromEntries(EFFECTS.map((e) => [e.id, e]));

export function defaultParams(id: string): Record<string, number> {
  return Object.fromEntries((EFFECT_BY_ID[id]?.params ?? []).map((p) => [p.key, p.def]));
}

// ------------------------------------------------------------------ transitions

export interface TransitionDef { id: string; name: string; xfade: string; group: 'Impact (sinematik)' | 'Çözülme' | 'Silme' | 'Kaydırma' | 'Şekil' | 'Özel'; desc?: string }

export const TRANSITIONS: TransitionDef[] = [
  { id: 'cross', name: 'Çapraz geçiş', xfade: 'fade', group: 'Çözülme' },
  { id: 'black', name: 'Siyaha geçiş', xfade: 'fadeblack', group: 'Çözülme' },
  { id: 'white', name: 'Beyaza geçiş (flaş)', xfade: 'fadewhite', group: 'Çözülme' },
  { id: 'grays', name: 'Griden geçiş', xfade: 'fadegrays', group: 'Çözülme' },
  { id: 'dissolve', name: 'Toz dağılması', xfade: 'dissolve', group: 'Çözülme' },
  { id: 'pixelize', name: 'Piksel geçişi', xfade: 'pixelize', group: 'Çözülme' },
  { id: 'blur', name: 'Bulanık geçiş', xfade: 'hblur', group: 'Çözülme' },
  { id: 'distance', name: 'Işık geçişi', xfade: 'distance', group: 'Çözülme' },
  { id: 'wipeleft', name: 'Silme ←', xfade: 'wipeleft', group: 'Silme' },
  { id: 'wiperight', name: 'Silme →', xfade: 'wiperight', group: 'Silme' },
  { id: 'wipeup', name: 'Silme ↑', xfade: 'wipeup', group: 'Silme' },
  { id: 'wipedown', name: 'Silme ↓', xfade: 'wipedown', group: 'Silme' },
  { id: 'smoothleft', name: 'Yumuşak silme ←', xfade: 'smoothleft', group: 'Silme' },
  { id: 'smoothright', name: 'Yumuşak silme →', xfade: 'smoothright', group: 'Silme' },
  { id: 'diagtl', name: 'Çapraz silme ↖', xfade: 'diagtl', group: 'Silme' },
  { id: 'diagbr', name: 'Çapraz silme ↘', xfade: 'diagbr', group: 'Silme' },
  { id: 'radial', name: 'Saat silmesi', xfade: 'radial', group: 'Silme' },
  { id: 'slideleft', name: 'Kaydır ←', xfade: 'slideleft', group: 'Kaydırma' },
  { id: 'slideright', name: 'Kaydır →', xfade: 'slideright', group: 'Kaydırma' },
  { id: 'slideup', name: 'Kaydır ↑', xfade: 'slideup', group: 'Kaydırma' },
  { id: 'slidedown', name: 'Kaydır ↓', xfade: 'slidedown', group: 'Kaydırma' },
  { id: 'coverleft', name: 'Üstünü ört ←', xfade: 'coverleft', group: 'Kaydırma' },
  { id: 'revealright', name: 'Açığa çıkar →', xfade: 'revealright', group: 'Kaydırma' },
  { id: 'squeezeh', name: 'Sıkıştır (yatay)', xfade: 'squeezeh', group: 'Kaydırma' },
  { id: 'circleopen', name: 'Daire açılması', xfade: 'circleopen', group: 'Şekil' },
  { id: 'circleclose', name: 'Daire kapanması', xfade: 'circleclose', group: 'Şekil' },
  { id: 'horzopen', name: 'Perde açılması (yatay)', xfade: 'horzopen', group: 'Şekil' },
  { id: 'vertopen', name: 'Perde açılması (dikey)', xfade: 'vertopen', group: 'Şekil' },
  { id: 'rectcrop', name: 'Kare kırpma', xfade: 'rectcrop', group: 'Şekil' },
  { id: 'hlslice', name: 'Dilimler', xfade: 'hlslice', group: 'Şekil' },
  { id: 'zoomin', name: 'Yakınlaşarak geçiş', xfade: 'zoomin', group: 'Özel' },
  { id: 'hlwind', name: 'Rüzgâr', xfade: 'hlwind', group: 'Özel' },
  // cinematic motion transitions (core/impact.ts); listed first in the library
  ...IMPACTS.map((d): TransitionDef => ({ id: d.id, name: d.name, xfade: 'impact', group: 'Impact (sinematik)', desc: d.desc })),
];

export const TRANSITION_BY_ID: Record<string, TransitionDef> = Object.fromEntries(TRANSITIONS.map((t) => [t.id, t]));

// ------------------------------------------------------------------ transition windows (shared by preview and export)

export interface TransitionWindow {
  a: number; b: number;
  /** outgoing / incoming side; null = nothing (from/to black or the tracks below) */
  A: import('./model').Clip | null; B: import('./model').Clip | null;
  type: string;
  /** the clip that stores the transition and on which side */
  owner: import('./model').Clip; side: 'in' | 'out';
}

/** selection key for a transition ("clipId:in" / "clipId:out") */
export const transKey = (clipId: string, side: 'in' | 'out') => `${clipId}:${side}`;
export function parseTransKey(k: string): { id: string; side: 'in' | 'out' } {
  const i = k.lastIndexOf(':');
  const side = k.slice(i + 1);
  return side === 'out' || side === 'in' ? { id: k.slice(0, i), side } : { id: k, side: 'in' };
}

/** where each transition on a track plays, and where the neighbouring clips stop being drawn on their own */
export function transitionWindows(clips: import('./model').Clip[]): { windows: TransitionWindow[]; cutStart: Map<string, number>; cutEnd: Map<string, number> } {
  const end = (c: import('./model').Clip) => c.start + c.duration;
  const windows: TransitionWindow[] = [];
  const cutStart = new Map<string, number>();
  const cutEnd = new Map<string, number>();
  const cut = (A: import('./model').Clip, B: import('./model').Clip, tr: TransitionSpec, owner: import('./model').Clip, side: 'in' | 'out') => {
    const d = Math.min(tr.duration, A.duration + B.duration - 2);
    const half = Math.floor(d / 2);
    const a = Math.max(A.start + 1, B.start - half);
    const b = Math.min(end(B) - 1, a + d);
    if (b - a < 2) return;
    windows.push({ a, b, A, B, type: tr.type, owner, side });
    cutEnd.set(A.id, Math.min(cutEnd.get(A.id) ?? Infinity, a));
    cutStart.set(B.id, Math.max(cutStart.get(B.id) ?? -Infinity, b));
  };
  // heads: a cut transition, or from nothing
  for (const B of clips) {
    const tr = B.transIn;
    if (!tr || tr.duration < 2) continue;
    const A = clips.find((x) => end(x) === B.start && x.id !== B.id) ?? null;
    if (A) { cut(A, B, tr, B, 'in'); continue; }
    const a = B.start, b = Math.min(end(B), B.start + tr.duration);
    if (b - a < 2) continue;
    windows.push({ a, b, A: null, B, type: tr.type, owner: B, side: 'in' });
    cutStart.set(B.id, Math.max(cutStart.get(B.id) ?? -Infinity, b));
  }
  // tails: to nothing (fade out / dip to black at the end), or into a neighbour that has no head transition
  for (const A of clips) {
    const tr = A.transOut;
    if (!tr || tr.duration < 2) continue;
    const N = clips.find((x) => x.start === end(A) && x.id !== A.id) ?? null;
    if (N) { if (!N.transIn) cut(A, N, tr, A, 'out'); continue; }
    const b = end(A);
    const a = Math.max(b - tr.duration, cutStart.get(A.id) ?? A.start);
    if (b - a < 2) continue;
    windows.push({ a, b, A, B: null, type: tr.type, owner: A, side: 'out' });
    cutEnd.set(A.id, Math.min(cutEnd.get(A.id) ?? Infinity, a));
  }
  windows.sort((x, y) => x.a - y.a);
  return { windows, cutStart, cutEnd };
}
