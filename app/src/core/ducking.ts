// Auto-ducking: lower music under speech by writing volume keyframes on the
// music clips (so it works the same in preview and export, and stays editable).
import { Clip, Keyframe, Sequence, clipEnd } from './model';

export interface DuckOptions {
  /** how much to lower the music, dB (negative) */
  amountDb: number;
  /** speech is "on" when the level is above this (0..1 peak) */
  threshold: number;
  attackSec: number;
  releaseSec: number;
  /** speech gaps shorter than this are bridged */
  holdSec: number;
}

export const DEFAULT_DUCK: DuckOptions = { amountDb: -14, threshold: 0.06, attackSec: 0.2, releaseSec: 0.5, holdSec: 0.6 };

/** frames where speech is present, from per-frame levels of the speech tracks */
export function speechRegions(levels: Float32Array, fps: number, o: DuckOptions): [number, number][] {
  const out: [number, number][] = [];
  let s = -1;
  for (let f = 0; f <= levels.length; f++) {
    const on = f < levels.length && levels[f] > o.threshold;
    if (on && s < 0) s = f;
    if (!on && s >= 0) { out.push([s, f]); s = -1; }
  }
  // bridge short gaps
  const hold = Math.round(o.holdSec * fps);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= hold) last[1] = r[1];
    else merged.push([...r]);
  }
  // ignore blips (clicks, short noises)
  return merged.filter(([a, b]) => b - a >= Math.round(fps * 0.15));
}

/** volume keyframes (clip-local frames) that duck a music clip under the regions */
export function duckKeyframes(c: Clip, regions: [number, number][], fps: number, o: DuckOptions): Keyframe[] {
  const base = c.volumeDb.keyframes.length ? c.volumeDb.keyframes[0].value : c.volumeDb.value;
  const low = base + o.amountDb;
  const att = Math.max(1, Math.round(o.attackSec * fps)), rel = Math.max(1, Math.round(o.releaseSec * fps));
  const k: Keyframe[] = [];
  const s0 = c.start, s1 = clipEnd(c);
  const push = (frame: number, value: number) => {
    const local = Math.round(frame - s0);
    if (local < 0 || frame > s1) return;
    const prev = k[k.length - 1];
    if (prev && local <= prev.frame) { if (local === prev.frame) prev.value = Math.min(prev.value, value); return; }
    k.push({ frame: local, value, ease: 'ease' });
  }; 
  for (const [a, b] of regions) {
    if (b + rel < s0 || a - att > s1) continue;
    push(Math.max(s0, a - att), a - att < s0 ? low : base);
    push(Math.max(s0, a), low);
    push(Math.min(s1, b), low);
    push(Math.min(s1, b + rel), b + rel > s1 ? low : base);
  }
  if (!k.length) return [];
  if (k[0].frame > 0) k.unshift({ frame: 0, value: base, ease: 'linear' });
  return k;
}

/** per-frame peak level of the given tracks, from waveform peaks (peaksPerSecond values per second of source) */
export function trackLevels(seq: Sequence, trackIds: string[], peaksOf: (mediaId: string) => { peaks: number[]; pps: number } | null): Float32Array {
  const end = Math.max(0, ...Object.values(seq.clips).map(clipEnd));
  const out = new Float32Array(end);
  for (const c of Object.values(seq.clips)) {
    if (!trackIds.includes(c.trackId) || c.stream !== 'audio' || !c.enabled) continue;
    const p = peaksOf(c.mediaId);
    if (!p) continue;
    const gain = Math.pow(10, c.volumeDb.value / 20);
    for (let f = c.start; f < clipEnd(c); f++) {
      const t = c.speed >= 0 ? c.srcIn + ((f - c.start) / seq.fps) * c.speed : c.srcIn + ((clipEnd(c) - f) / seq.fps) * -c.speed;
      const i = Math.floor(t * p.pps);
      const v = Math.max(p.peaks[i] ?? 0, p.peaks[i + 1] ?? 0) * gain;
      if (v > out[f]) out[f] = v;
    }
  }
  return out;
}
