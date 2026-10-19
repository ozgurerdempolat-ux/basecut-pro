// Auto Reframe: turn a landscape edit into 9:16 / 1:1 / 4:5 (or back) by
// following the interesting part of every shot. Each clip is sampled a few
// times per second at low resolution; a saliency map (people/skin tones, motion,
// detail, centre bias) gives the subject position; the camera path is smoothed
// with a dead zone so it glides instead of twitching, then written as ordinary
// Position keyframes you can fine-tune.

import type { Clip, Keyframe, MediaItem, Sequence } from './model';
import { clipSrcOut } from './model';

export interface ReframeSample { t: number; x: number; y: number; w: number }

/** subject centre (0..1) of one small RGB frame; prev = previous frame for motion */
export function saliency(rgb: Uint8Array, w: number, h: number, prev: Uint8Array | null): { x: number; y: number; weight: number } {
  const n = w * h;
  const skin = new Float32Array(n), detail = new Float32Array(n), motion = new Float32Array(n);
  let ms = 0, md = 0, mm = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x, i = p * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      // skin likelihood in YCbCr (people are usually the subject)
      const Y = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      skin[p] = Y > 50 && cb > 77 && cb < 127 && cr > 133 && cr < 175 ? 1 : 0;
      const il = i - 3, ir = i + 3, iu = i - w * 3, id = i + w * 3;
      detail[p] = Math.abs(rgb[ir] - rgb[il]) + Math.abs(rgb[ir + 1] - rgb[il + 1]) + Math.abs(rgb[id] - rgb[iu]) + Math.abs(rgb[id + 1] - rgb[iu + 1]);
      if (prev) motion[p] = Math.abs(r - prev[i]) + Math.abs(g - prev[i + 1]) + Math.abs(b - prev[i + 2]);
      ms += skin[p]; md += detail[p]; mm += motion[p];
    }
  }
  const inner = (w - 2) * (h - 2);
  ms /= inner; md /= inner; mm /= inner;
  // only what stands out from the frame counts (uniform noise or texture cancels out)
  const sdev = (arr: Float32Array, mean: number) => { let v = 0; for (let p = 0; p < n; p++) v += (arr[p] - mean) ** 2; return Math.sqrt(v / n) + 1e-6; };
  const dd = sdev(detail, md), dm = sdev(motion, mm);
  const skinShare = ms; // a frame full of "skin" (e.g. a wall) is no evidence
  let sx = 0, sy = 0, sw = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const sk = skinShare < 0.5 ? skin[p] * 3 : 0;
      const de = Math.max(0, (detail[p] - md) / dd - 1) * 0.4;
      const mo = prev ? Math.max(0, (motion[p] - mm) / dm - 1) * 0.8 : 0;
      const cx = x / w - 0.5, cy = y / h - 0.45;
      const centre = 1 - Math.min(1, cx * cx * 1.2 + cy * cy * 2.5);
      const s = (sk + de + mo) * (0.35 + 0.65 * centre);
      sx += s * x; sy += s * y; sw += s;
    }
  }
  if (sw < 1e-6) return { x: 0.5, y: 0.5, weight: 0 };
  return { x: sx / sw / w, y: sy / sw / h, weight: Math.min(1, sw / inner) };
}

/**
 * Smooth camera path from noisy samples. `speed` 0..1: 0 = slow & steady
 * (interviews), 1 = follows fast action. A dead zone keeps the frame still
 * while the subject only moves a little.
 */
export function smoothPath(samples: ReframeSample[], speed: number, deadZone: number): number[] {
  if (!samples.length) return [];
  // weighted moving average (low-weight samples count less)
  const r = Math.max(1, Math.round(6 - 5 * speed));
  const avg = samples.map((_, i) => {
    let a = 0, wsum = 0;
    for (let k = -r; k <= r; k++) {
      const s = samples[i + k];
      if (!s) continue;
      const wgt = (0.2 + s.w) * (1 - Math.abs(k) / (r + 1));
      a += s.x * wgt; wsum += wgt;
    }
    return wsum ? a / wsum : 0.5;
  });
  // dead zone + limited pan speed
  const out: number[] = [];
  let cur = avg[0];
  const maxStep = 0.04 + 0.16 * speed; // fraction of the source width per sample
  for (const x of avg) {
    const d = x - cur;
    if (Math.abs(d) > deadZone) cur += Math.sign(d) * Math.min(Math.abs(d) - deadZone, maxStep);
    out.push(cur);
  }
  // second pass backwards so moves start a little before the subject gets there
  for (let i = out.length - 2; i >= 0; i--) out[i] = out[i] * 0.7 + out[i + 1] * 0.3;
  return out;
}

export interface ReframeTarget { width: number; height: number }

export const REFRAME_PRESETS: { id: string; name: string; w: number; h: number }[] = [
  { id: '9:16', name: 'Dikey 9:16 (Reels, TikTok, Shorts)', w: 1080, h: 1920 },
  { id: '4:5', name: 'Dikey 4:5 (Instagram gönderi)', w: 1080, h: 1350 },
  { id: '1:1', name: 'Kare 1:1', w: 1080, h: 1080 },
  { id: '16:9', name: 'Yatay 16:9', w: 1920, h: 1080 },
];

/** scale (%) that makes the clip cover the new frame */
export function coverScale(m: MediaItem, target: ReframeTarget): number {
  const iw = m.width || target.width, ih = m.height || target.height;
  const fit = Math.min(target.width / iw, target.height / ih);
  const cover = Math.max(target.width / iw, target.height / ih);
  return (cover / fit) * 100;
}

/** Position X keyframes (pixels of the new sequence) that put the subject path at the centre, never showing past the edge */
export function reframeKeyframes(c: Clip, m: MediaItem, seqFps: number, target: ReframeTarget, path: { t: number; x: number }[]): { scale: number; keys: Keyframe[] } {
  const scale = coverScale(m, target);
  const iw = m.width || target.width, ih = m.height || target.height;
  const fit = Math.min(target.width / iw, target.height / ih);
  const drawnW = iw * fit * (scale / 100);
  const maxShift = Math.max(0, (drawnW - target.width) / 2);
  const keys: Keyframe[] = [];
  const srcOut = clipSrcOut(c, seqFps);
  for (const p of path) {
    // source time → clip-local frame
    if (p.t < Math.min(c.srcIn, srcOut) - 1e-6 || p.t > Math.max(c.srcIn, srcOut) + 1e-6) continue;
    const local = c.speed >= 0 ? (p.t - c.srcIn) / c.speed : (c.srcIn + (c.duration / seqFps) * Math.abs(c.speed) - p.t) / Math.abs(c.speed);
    const frame = Math.round(local * seqFps);
    if (frame < 0 || frame >= c.duration) continue;
    const px = Math.max(-maxShift, Math.min(maxShift, (0.5 - p.x) * drawnW));
    const last = keys[keys.length - 1];
    if (last && frame <= last.frame) continue;
    keys.push({ frame, value: Math.round(px * 10) / 10, ease: 'ease' });
  }
  // drop keys that don't change anything (keeps the timeline tidy)
  const slim = keys.filter((k, i) => i === 0 || i === keys.length - 1 || Math.abs(k.value - keys[i - 1].value) > 0.5 || Math.abs(k.value - (keys[i + 1]?.value ?? k.value)) > 0.5);
  return { scale, keys: slim.length > 1 ? slim : slim.slice(0, 1) };
}

/** source range a clip needs analysed (seconds) */
export function reframeRange(c: Clip, fps: number): [number, number] {
  const a = c.srcIn, b = clipSrcOut(c, fps);
  return [Math.min(a, b), Math.max(a, b)];
}

/** sample times inside a range (seconds) */
export function sampleTimes(range: [number, number], perSecond: number): number[] {
  const out: number[] = [];
  const n = Math.max(2, Math.ceil((range[1] - range[0]) * perSecond) + 1);
  for (let i = 0; i < n; i++) out.push(range[0] + ((range[1] - range[0]) * i) / (n - 1));
  return out;
}

export type ReframeSeq = Sequence;
