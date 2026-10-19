// Multi-camera editing. A multicam source sequence holds one angle per video
// track (audio on the matching audio tracks), synced by audio waveform or by
// in-points. A multicam clip in an edit shows one angle; switching angles cuts
// the clip. For playback and export multicam clips are expanded into the plain
// clips of the chosen angle (expandMulticam), so every other feature — effects,
// colour, transitions, export — works on them unchanged.

import type { Clip, MediaItem, Project, Sequence } from './model';
import { clipEnd, makeSequence, makeTrack, newId, param, defaultTransform } from './model';

export interface MulticamRef { seqId: string; angle: number }

// ------------------------------------------------------------------ audio sync

/**
 * Offset (seconds) to add to b's timeline position so it lines up with a,
 * from loudness envelopes sampled `rate` times per second. Coarse-to-fine
 * normalised cross-correlation; returns confidence 0..1.
 */
export function syncOffset(a: Float32Array, b: Float32Array, rate: number, maxShiftSec = 120): { offset: number; confidence: number } {
  const norm = (x: Float32Array) => {
    // onset strength: positive change of the envelope (robust to different mic gains)
    const o = new Float32Array(x.length);
    for (let i = 1; i < x.length; i++) o[i] = Math.max(0, x[i] - x[i - 1]);
    let m = 0; for (const v of o) m += v; m /= o.length || 1;
    let sd = 0; for (const v of o) sd += (v - m) ** 2; sd = Math.sqrt(sd / (o.length || 1)) || 1;
    for (let i = 0; i < o.length; i++) o[i] = (o[i] - m) / sd;
    return o;
  };
  const decim = (x: Float32Array, k: number) => { const o = new Float32Array(Math.floor(x.length / k)); for (let i = 0; i < o.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += x[i * k + j]; o[i] = s / k; } return o; };
  const corr = (x: Float32Array, y: Float32Array, lag: number) => {
    // b shifted by lag samples against a
    let s = 0, n = 0;
    const lo = Math.max(0, lag), hi = Math.min(x.length, y.length + lag);
    for (let i = lo; i < hi; i++) { s += x[i] * y[i - lag]; n++; }
    return n > 20 ? s / n : -Infinity;
  };
  const A = norm(a), B = norm(b);
  const maxLag = Math.round(maxShiftSec * rate);
  // coarse pass at 1/10 resolution
  const k = Math.max(1, Math.round(rate / 10));
  const a1 = decim(A, k), b1 = decim(B, k);
  const ml1 = Math.ceil(maxLag / k);
  let best = 0, bestV = -Infinity;
  for (let l = -ml1; l <= ml1; l++) { const v = corr(a1, b1, l); if (v > bestV) { bestV = v; best = l; } }
  // fine pass around the coarse peak
  let fine = best * k, fineV = -Infinity;
  for (let l = best * k - 2 * k; l <= best * k + 2 * k; l++) { const v = corr(A, B, l); if (v > fineV) { fineV = v; fine = l; } }
  // confidence: peak vs typical correlation
  let others = 0, cnt = 0;
  for (let l = -ml1; l <= ml1; l += Math.max(1, Math.floor(ml1 / 50))) { const v = corr(a1, b1, l); if (Number.isFinite(v) && Math.abs(l - best) > 5) { others += Math.abs(v); cnt++; } }
  const confidence = Math.max(0, Math.min(1, (bestV - (cnt ? others / cnt : 0)) / (Math.abs(bestV) + 1e-6)));
  return { offset: fine / rate, confidence };
}

// ------------------------------------------------------------------ building the source sequence

/**
 * Multicam source sequence: angle i on video track i (and its audio on audio
 * track i), positioned by `offsets` (seconds, relative to the earliest angle).
 */
export function makeMulticamSource(name: string, media: MediaItem[], offsets: number[], fps: number): Sequence {
  const first = media.find((m) => m.kind === 'video') ?? media[0];
  const s = makeSequence({ name, width: first?.width || 1920, height: first?.height || 1080, fps });
  s.tracks = [];
  media.forEach((_, i) => s.tracks.push(makeTrack('video', i + 1)));
  media.forEach((_, i) => s.tracks.push(makeTrack('audio', i + 1)));
  const minOff = Math.min(...offsets);
  media.forEach((m, i) => {
    const start = Math.round((offsets[i] - minOff) * fps);
    const dur = Math.max(1, Math.round(m.duration * fps));
    const link = m.hasVideo && m.hasAudio ? newId('link') : null;
    const base = { mediaId: m.id, start, duration: dur, srcIn: 0, speed: 1, linkId: link, enabled: true, name: m.name, label: 'iris' as const, transform: defaultTransform(), volumeDb: param(0) };
    if (m.hasVideo) { const id = newId('clip'); s.clips[id] = { ...base, id, trackId: s.tracks[i].id, stream: 'video' }; }
    if (m.hasAudio) { const id = newId('clip'); s.clips[id] = { ...base, id, trackId: s.tracks[media.length + i].id, stream: 'audio' }; }
  });
  s.multicam = { angles: media.map((m, i) => ({ name: `Kamera ${i + 1}`, track: i, media: m.id })) };
  return s;
}

export function angleCount(src: Sequence): number {
  return src.multicam?.angles.length ?? src.tracks.filter((t) => t.kind === 'video').length;
}

// ------------------------------------------------------------------ expansion for playback/export

const cache = new WeakMap<Sequence, { project: Project['sequences']; out: Sequence }>();

/** the sequence with every multicam clip replaced by the clips of its active angle */
export function expandMulticam(seq: Sequence, sequences: Project['sequences']): Sequence {
  if (!Object.values(seq.clips).some((c) => c.mc)) return seq;
  const hit = cache.get(seq);
  if (hit && hit.project === sequences) return hit.out;
  const out: Sequence = { ...seq, clips: {} };
  for (const c of Object.values(seq.clips)) {
    if (!c.mc) { out.clips[c.id] = c; continue; }
    const src = sequences[c.mc.seqId];
    if (!src) continue;
    const kind = c.stream;
    const tracks = src.tracks.filter((t) => t.kind === kind);
    const track = tracks[Math.min(c.mc.angle, tracks.length - 1)];
    if (!track) continue;
    const scale = src.fps / seq.fps;
    const from = c.srcIn * src.fps; // source-sequence frame at the clip head
    const to = from + c.duration * scale;
    const inner = Object.values(src.clips).filter((x) => x.trackId === track.id && x.stream === kind && x.enabled && clipEnd(x) > from && x.start < to);
    for (const x of inner) {
      const a = Math.max(x.start, from), b = Math.min(clipEnd(x), to);
      const start = c.start + Math.round((a - from) / scale);
      const end = c.start + Math.round((b - from) / scale);
      if (end <= start) continue;
      const v: Clip = {
        ...x,
        id: `${c.id}>${x.id}`,
        trackId: c.trackId,
        start,
        duration: end - start,
        srcIn: x.srcIn + ((a - x.start) / src.fps) * Math.abs(x.speed),
        linkId: c.linkId,
        enabled: c.enabled,
        transform: c.transform,
        volumeDb: kind === 'audio' ? c.volumeDb : x.volumeDb,
        effects: [...(x.effects ?? []), ...(c.effects ?? [])],
        audioFx: [...(x.audioFx ?? []), ...(c.audioFx ?? [])],
        color: c.color ?? x.color,
        blend: c.blend,
        masks: c.masks,
        maskImage: c.maskImage,
        transIn: start === c.start ? c.transIn : undefined,
        transOut: end === clipEnd(c) ? c.transOut : undefined,
        mc: undefined,
      };
      out.clips[v.id] = v;
    }
  }
  cache.set(seq, { project: sequences, out });
  return out;
}
