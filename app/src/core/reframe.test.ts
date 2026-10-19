import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ReframeSample, coverScale, reframeKeyframes, saliency, smoothPath } from './reframe';
import { MediaItem, defaultTransform, param } from './model';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);
const dir = mkdtempSync(join(tmpdir(), 'kurgu-reframe-'));
let clip = '';
// subject x over time (0..1): walks from left to right and stops
const subjectX = (t: number) => 0.2 + 0.6 * Math.min(1, t / 3);

beforeAll(() => {
  clip = join(dir, 'walk.mp4');
  const bg = `color=c=0x405060:s=640x360:r=25:d=4,noise=alls=40:allf=t`;
  // a skin-toned "person" (head + body) walking across
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', bg, '-f', 'lavfi', '-i', 'color=c=0xe0a080:s=80x240:r=25:d=4',
    '-filter_complex', `[0][1]overlay=x='640*(0.2+0.6*min(1\\,t/3))-40':y=60:eval=frame`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
}, 60000);

function analyse(file: string, perSec: number): ReframeSample[] {
  const W = 96, H = 54;
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', `fps=${perSec},scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  const out: ReframeSample[] = [];
  let prev: Uint8Array | null = null;
  for (let o = 0, i = 0; o + W * H * 3 <= raw.length; o += W * H * 3, i++) {
    const f = new Uint8Array(raw.buffer, raw.byteOffset + o, W * H * 3);
    const s = saliency(f, W, H, prev);
    out.push({ t: i / perSec, x: s.x, y: s.y, w: s.weight });
    prev = f;
  }
  return out;
}

describe('auto reframe', () => {
  it('finds the subject and the smoothed path follows it', () => {
    const samples = analyse(clip, 5);
    const path = smoothPath(samples, 0.5, 0.03);
    let worst = 0;
    samples.forEach((s, i) => { if (s.t > 0.4 && s.t < 3.6) worst = Math.max(worst, Math.abs(path[i] - subjectX(s.t + 0.1))); });
    expect(worst).toBeLessThan(0.1);
  }, 60000);

  it('keyframes keep the frame filled and centre the subject', () => {
    const m: MediaItem = { id: 'M', path: clip, name: 'w', kind: 'video', duration: 4, fps: 25, width: 1920, height: 1080, hasVideo: true, hasAudio: false, audioChannels: 0, sampleRate: 0, codec: 'h264', binId: null, label: 'iris', online: true, markIn: null, markOut: null };
    const target = { width: 1080, height: 1920 };
    expect(coverScale(m, target)).toBeCloseTo(100 * (1920 / 1080) / (1080 / 1920), 1);
    const c = { id: 'c', trackId: 'v', mediaId: 'M', stream: 'video' as const, start: 0, duration: 100, srcIn: 0, speed: 1, linkId: null, enabled: true, name: 'w', label: 'iris' as const, transform: defaultTransform(), volumeDb: param(0) };
    const { keys } = reframeKeyframes(c, m, 25, target, [{ t: 0, x: 0.2 }, { t: 2, x: 0.5 }, { t: 3.9, x: 0.95 }]);
    const drawnW = 1920 * (1920 / 1080);
    const maxShift = (drawnW - 1080) / 2;
    expect(keys[0].value).toBeCloseTo((0.5 - 0.2) * drawnW, 0);
    expect(keys[keys.length - 1].value).toBeCloseTo(-maxShift, 0); // clamped at the edge
    expect(keys.every((k) => Math.abs(k.value) <= maxShift + 0.1)).toBe(true);
  });
});
