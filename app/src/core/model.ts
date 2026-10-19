// Core data model. Pure data, no Electron, no DOM: everything here is
// testable in plain Node and is what gets saved to disk.
//
// Units:
//   timeline positions/durations: integer frames at the sequence frame rate
//   source positions: seconds (float) in the media file's own time
//   speed: 1 = normal, 2 = twice as fast, 0.5 = slow motion. Negative = reverse.

export type Id = string;

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaItem {
  id: Id;
  path: string;
  name: string;
  kind: MediaKind;
  /** seconds; Infinity for stills */
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioChannels: number;
  sampleRate: number;
  codec: string;
  binId: Id | null;
  label: LabelColor;
  online: boolean;
  /** remembered source-monitor marks, seconds */
  markIn: number | null;
  markOut: number | null;
  /** set for generated titles: the design the image was rendered from */
  title?: import('./title').TitleData;
  /** generated items: adjustment layer (applies its effects to everything below) or colour matte */
  synthetic?: { type: 'adjustment' | 'matte' | 'multicam' | 'nest'; color?: number; seqId?: Id };
}

export interface Bin {
  id: Id;
  name: string;
  parentId: Id | null;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: Id;
  kind: TrackKind;
  name: string;
  locked: boolean;
  syncLock: boolean;
  /** video: eye toggle; audio: mute */
  muted: boolean;
  solo: boolean;
  targeted: boolean;
  height: number;
  volumeDb: number;
  /** -100 (left) .. 100 (right), audio tracks */
  pan?: number;
}

export type LabelColor =
  | 'violet' | 'iris' | 'caribbean' | 'lavender' | 'cerulean' | 'forest'
  | 'rose' | 'mango' | 'purple' | 'blue' | 'teal' | 'magenta' | 'tan'
  | 'green' | 'brown' | 'yellow';

export interface Keyframe {
  frame: number; // relative to clip start
  value: number;
  /** interpolation of the segment that starts at this keyframe */
  ease: KeyEase;
}

/**
 * linear · hold (step) · ease (slow out and in) · in (slow arrival at the next key)
 * · out (slow departure from this key) · fast (punchy: quick, then settles)
 */
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light' | 'hard-light' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'difference' | 'exclusion' | 'add';
export const BLEND_MODES: { id: BlendMode; name: string; group: string }[] = [
  { id: 'normal', name: 'Normal', group: '' },
  { id: 'darken', name: 'Koyulaştır', group: 'Koyulaştırma' }, { id: 'multiply', name: 'Çarp', group: 'Koyulaştırma' }, { id: 'color-burn', name: 'Renk yanması', group: 'Koyulaştırma' },
  { id: 'lighten', name: 'Açıklaştır', group: 'Açıklaştırma' }, { id: 'screen', name: 'Ekran', group: 'Açıklaştırma' }, { id: 'color-dodge', name: 'Renk soldurma', group: 'Açıklaştırma' }, { id: 'add', name: 'Doğrusal ekle (parlama)', group: 'Açıklaştırma' },
  { id: 'overlay', name: 'Bindirme', group: 'Kontrast' }, { id: 'soft-light', name: 'Yumuşak ışık', group: 'Kontrast' }, { id: 'hard-light', name: 'Sert ışık', group: 'Kontrast' },
  { id: 'difference', name: 'Fark', group: 'Fark' }, { id: 'exclusion', name: 'Dışlama', group: 'Fark' },
];

export type KeyEase = 'linear' | 'hold' | 'ease' | 'in' | 'out' | 'fast';
export const KEY_EASES: { id: KeyEase; name: string }[] = [
  { id: 'linear', name: 'Doğrusal' },
  { id: 'ease', name: 'Yumuşak (giriş + çıkış)' },
  { id: 'out', name: 'Yavaş çıkış (hızlanarak)' },
  { id: 'in', name: 'Yavaş varış (yavaşlayarak)' },
  { id: 'fast', name: 'Sert (hızlı başla, yumuşak otur)' },
  { id: 'hold', name: 'Sabit (sıçrama)' },
];

/** shaped progress for a segment, t in 0..1 */
export function easeT(e: KeyEase, t: number): number {
  switch (e) {
    case 'ease': return t * t * (3 - 2 * t);
    case 'out': return t * t;
    case 'in': return 1 - (1 - t) * (1 - t);
    case 'fast': return 1 - Math.pow(1 - t, 4);
    case 'hold': return 0;
    default: return t;
  }
}

export interface AnimatableParam {
  value: number;
  keyframes: Keyframe[];
}

export interface ClipTransform {
  posX: AnimatableParam; // pixels, relative to sequence center
  posY: AnimatableParam;
  scale: AnimatableParam; // percent
  rotation: AnimatableParam; // degrees
  opacity: AnimatableParam; // percent
}

export interface Clip {
  id: Id;
  trackId: Id;
  mediaId: Id;
  /** which stream of the media this clip plays */
  stream: 'video' | 'audio';
  start: number; // frames
  duration: number; // frames, >= 1
  srcIn: number; // seconds
  speed: number;
  /** clips sharing a linkId are a linked A/V pair */
  linkId: Id | null;
  enabled: boolean;
  name: string;
  label: LabelColor;
  transform: ClipTransform;
  volumeDb: AnimatableParam;
  /** colour grade (Color panel); absent = untouched */
  color?: import('./color').ColorGrade;
  /** applied video effects, in order */
  effects?: import('./fx').ClipEffect[];
  /** transition into this clip (from the clip that ends where this one starts, or from black/silence) */
  transIn?: import('./fx').TransitionSpec;
  /** transition out of this clip at its tail (to black/silence, or into the next clip when that has none) */
  transOut?: import('./fx').TransitionSpec;
  /** audio effects (audio clips) */
  audioFx?: import('./audiofx').AudioEffect[];
  /** multicam clip: shows one angle of a multicam source sequence (srcIn = seconds on that sequence) */
  mc?: import('./multicam').MulticamRef;
  /** nested sequence clip: shows another sequence (srcIn = seconds on that sequence) */
  nest?: { seqId: Id };
  /** time remapping (speed ramps): speed in % over the clip, keyframed; video only, forward only */
  remap?: AnimatableParam;
  /** frame hold: the clip shows this source time (seconds) as a still, silent */
  freeze?: number;
  /** opacity masks (core/mask.ts) and their rasterised alpha image */
  masks?: import('./mask').Mask[];
  maskImage?: { key: string; path: string };
  /** how the clip mixes with the tracks below (Opacity › Blend Mode) */
  blend?: BlendMode;
  /** finished Warp Stabilizer render for this clip (see core/stabilize.ts) */
  stab?: import('./stabilize').StabResult;
}

export interface Marker {
  id: Id;
  frame: number;
  duration: number;
  name: string;
  comment: string;
  color: 'green' | 'red' | 'purple' | 'orange' | 'yellow' | 'white' | 'blue' | 'cyan';
}

export interface Sequence {
  id: Id;
  name: string;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  tracks: Track[]; // video tracks then audio tracks; order within kind = V1, V2... / A1, A2...
  clips: Record<Id, Clip>;
  markers: Marker[];
  playhead: number;
  inPoint: number | null;
  outPoint: number | null;
  binId: Id | null;
  /** caption track (automatic or imported subtitles) */
  captions?: import('./captions').CaptionTrackData;
  /** set on multicam source sequences: the camera angles */
  multicam?: { angles: { name: string; track: number; media: Id }[] };
  /** speech transcript in sequence frames (text-based editing) */
  transcript?: { language: string; words: import('./captions').CaptionWord[] };
}

export interface Project {
  format: 'kurgu-project';
  version: 1;
  name: string;
  media: Record<Id, MediaItem>;
  bins: Record<Id, Bin>;
  sequences: Record<Id, Sequence>;
  activeSequenceId: Id | null;
}

// ---------- ids ----------
let counter = 0;
export function newId(prefix = 'id'): Id {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- factories ----------
export function param(value: number): AnimatableParam {
  return { value, keyframes: [] };
}

export function defaultTransform(): ClipTransform {
  return { posX: param(0), posY: param(0), scale: param(100), rotation: param(0), opacity: param(100) };
}

export function makeTrack(kind: TrackKind, index: number): Track {
  return {
    id: newId(kind === 'video' ? 'v' : 'a'),
    kind,
    name: `${kind === 'video' ? 'V' : 'A'}${index}`,
    locked: false,
    syncLock: true,
    muted: false,
    solo: false,
    targeted: index === 1,
    height: kind === 'video' ? 56 : 48,
    volumeDb: 0,
  };
}

export function makeSequence(opts: Partial<Pick<Sequence, 'name' | 'width' | 'height' | 'fps'>> = {}): Sequence {
  return {
    id: newId('seq'),
    name: opts.name ?? 'Sekans 01',
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    fps: opts.fps ?? 30,
    sampleRate: 48000,
    tracks: [makeTrack('video', 1), makeTrack('video', 2), makeTrack('video', 3),
      makeTrack('audio', 1), makeTrack('audio', 2), makeTrack('audio', 3)],
    clips: {},
    markers: [],
    playhead: 0,
    inPoint: null,
    outPoint: null,
    binId: null,
  };
}

export function makeProject(name = 'Adsız Proje'): Project {
  return { format: 'kurgu-project', version: 1, name, media: {}, bins: {}, sequences: {}, activeSequenceId: null };
}

// ---------- derived values ----------
export function clipEnd(c: Clip): number {
  return c.start + c.duration;
}

/** seconds of source consumed by the clip */
export function clipSrcSpan(c: Clip, fps: number): number {
  if (hasRemap(c)) return remapAdvance(c, c.duration, fps);
  return (c.duration / fps) * Math.abs(c.speed);
}

// ------------------------------------------------------------------ time remapping

export const hasRemap = (c: Clip): c is Clip & { remap: AnimatableParam } => !!c.remap && c.speed > 0 && c.stream === 'video' && (c.remap.keyframes.length > 0 || c.remap.value !== 100);

/** playback speed (×) at a clip-local frame */
export function remapSpeedAt(c: Clip, f: number): number {
  if (!hasRemap(c)) return Math.abs(c.speed);
  return Math.max(0.05, evalParam(c.remap, Math.max(0, f)) / 100);
}

const prefixCache = new WeakMap<object, { fps: number; sig: string; sums: Float64Array }>();
const remapSig = (p: AnimatableParam) => `${p.value}|${p.keyframes.map((k) => `${k.frame}:${k.value}:${k.ease}`).join(',')}`;
/** cumulative source seconds at the start of each local frame (cached per remap curve) */
function remapPrefix(c: Clip & { remap: AnimatableParam }, n: number, fps: number): Float64Array {
  let e = prefixCache.get(c.remap);
  const sig = remapSig(c.remap);
  if (!e || e.fps !== fps || e.sig !== sig || e.sums.length < n + 1) {
    const len = Math.max(n + 1, e && e.sig === sig ? e.sums.length * 2 : 0, 256);
    const sums = new Float64Array(len);
    for (let k = 1; k < len; k++) sums[k] = sums[k - 1] + Math.max(0.05, evalParam(c.remap, k - 1) / 100) / fps;
    e = { fps, sig, sums };
    prefixCache.set(c.remap, e);
  }
  return e.sums;
}

/** source seconds covered by local frames [0, frames) — fractional frames interpolate, negative frames extrapolate */
export function remapAdvance(c: Clip, frames: number, fps: number): number {
  if (!hasRemap(c)) return (frames / fps) * Math.abs(c.speed);
  if (frames <= 0) return (frames / fps) * remapSpeedAt(c, 0);
  const whole = Math.floor(frames);
  const sums = remapPrefix(c, whole + 1, fps);
  return sums[whole] + (frames - whole) * (remapSpeedAt(c, whole) / fps);
}

export function clipSrcOut(c: Clip, fps: number): number {
  return c.srcIn + clipSrcSpan(c, fps);
}

/** source time (seconds) shown at timeline frame f, or null if f is outside the clip */
export function sourceTimeAt(c: Clip, f: number, fps: number): number | null {
  if (f < c.start || f >= clipEnd(c)) return null;
  if (c.freeze !== undefined) return c.freeze;
  if (hasRemap(c)) return c.srcIn + remapAdvance(c, f - c.start, fps);
  const local = (f - c.start) / fps;
  if (c.speed >= 0) return c.srcIn + local * c.speed;
  return clipSrcOut(c, fps) - local * Math.abs(c.speed);
}

export function sequenceDuration(s: Sequence): number {
  let end = 0;
  for (const c of Object.values(s.clips)) end = Math.max(end, clipEnd(c));
  return end;
}

export function tracksOfKind(s: Sequence, kind: TrackKind): Track[] {
  return s.tracks.filter((t) => t.kind === kind);
}

export function clipsOnTrack(s: Sequence, trackId: Id): Clip[] {
  return Object.values(s.clips)
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
}

export function evalParam(p: AnimatableParam, frame: number): number {
  const k = p.keyframes;
  if (k.length === 0) return p.value;
  if (frame <= k[0].frame) return k[0].value;
  const last = k[k.length - 1];
  if (frame >= last.frame) return last.value;
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i], b = k[i + 1];
    if (frame >= a.frame && frame < b.frame) {
      if (a.ease === 'hold') return a.value;
      return a.value + (b.value - a.value) * easeT(a.ease, (frame - a.frame) / (b.frame - a.frame));
    }
  }
  return last.value;
}

export function framesToTimecode(frames: number, fps: number): string {
  const f = Math.max(0, Math.round(frames));
  const fpsInt = Math.round(fps);
  const ff = f % fpsInt;
  const totalSec = Math.floor(f / fpsInt);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

export function timecodeToFrames(tc: string, fps: number): number | null {
  const t = tc.trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const parts = t.split(/[:;.]/).map((x) => parseInt(x, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  const fpsInt = Math.round(fps);
  while (parts.length < 4) parts.unshift(0);
  const [hh, mm, ss, ff] = parts.slice(-4);
  return ((hh * 60 + mm) * 60 + ss) * fpsInt + ff;
}
