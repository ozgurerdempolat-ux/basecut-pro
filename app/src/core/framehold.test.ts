import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MediaItem, easeT, evalParam, makeProject, makeSequence, tracksOfKind } from './model';
import * as ops from './ops';
import { buildRenderPlan, defaultExport } from './render-graph';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);
const dir = mkdtempSync(join(tmpdir(), 'kurgu-hold-'));
let src = '';
const media = (path: string): MediaItem => ({
  id: 'M', path, name: 'M', kind: 'video', duration: 4, fps: 25, width: 320, height: 180, hasVideo: true, hasAudio: true,
  audioChannels: 2, sampleRate: 48000, codec: 'h264', binId: null, label: 'iris', online: true, markIn: null, markOut: null,
});
beforeAll(() => {
  // brightness ramps with time: frame n has luma ≈ 20 + n*2
  src = join(dir, 'ramp.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25:d=4,geq=lum=20+N*2:cb=128:cr=128', '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=4', '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
}, 60000);
const lumaAt = (file: string, sec: number) => execFileSync(FFMPEG, ['-v', 'error', '-ss', `${sec}`, '-i', file, '-frames:v', '1', '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-']).readUInt8(0);

function setup() {
  const p = makeProject();
  const s = makeSequence({ width: 320, height: 180, fps: 25 });
  p.media = { M: media(src) };
  const V1 = tracksOfKind(s, 'video')[0].id, A1 = tracksOfKind(s, 'audio')[0].id;
  const [v] = ops.overwriteEdit(s, { media: p.media.M, srcIn: 0, srcOut: 3 }, 0, V1, A1);
  return { p, s, v, V1, A1 };
}

describe('frame hold', () => {
  it("'after' freezes the rest of the clip on the playhead frame and drops its audio", () => {
    const { p, s, v } = setup();
    const ids = ops.frameHold(s, [v], 25, 'after');
    expect(ids).toHaveLength(1);
    const hold = s.clips[ids[0]];
    expect(hold.start).toBe(25); expect(hold.freeze).toBeCloseTo(1, 5);
    const audio = Object.values(s.clips).filter((c) => c.stream === 'audio');
    expect(audio).toHaveLength(1); expect(audio[0].duration).toBe(25);
    const out = join(dir, 'after.mp4');
    execFileSync(FFMPEG, buildRenderPlan(p, s, defaultExport(out)).args, { stdio: 'pipe' });
    const a = lumaAt(out, 1.2), b = lumaAt(out, 2.6);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(3); // still
    expect(lumaAt(out, 0.2)).toBeLessThan(a - 20); // it was moving before
  }, 60000);

  it("'segment' inserts a still and ripples the rest", () => {
    const { s, v } = setup();
    ops.frameHold(s, [v], 25, 'segment', 50);
    const vids = Object.values(s.clips).filter((c) => c.stream === 'video').sort((a, b) => a.start - b.start);
    expect(vids.map((c) => [c.start, c.duration, c.freeze !== undefined])).toEqual([[0, 25, false], [25, 50, true], [75, 50, false]]);
    const aud = Object.values(s.clips).filter((c) => c.stream === 'audio').sort((a, b) => a.start - b.start);
    expect(aud.map((c) => c.start)).toEqual([0, 75]);
  });
});

describe('keyframe interpolation', () => {
  it('eases have the right shape', () => {
    expect(easeT('linear', 0.5)).toBe(0.5);
    expect(easeT('out', 0.25)).toBeLessThan(0.25);
    expect(easeT('in', 0.25)).toBeGreaterThan(0.25);
    expect(easeT('fast', 0.25)).toBeGreaterThan(easeT('in', 0.25));
    const p = { value: 0, keyframes: [{ frame: 0, value: 0, ease: 'hold' as const }, { frame: 10, value: 100, ease: 'linear' as const }] };
    expect(evalParam(p, 9)).toBe(0); expect(evalParam(p, 10)).toBe(100);
  });
  it('export follows each ease like the preview', () => {
    for (const ease of ['linear', 'ease', 'in', 'out', 'fast'] as const) {
      const p = makeProject();
      const s = makeSequence({ width: 64, height: 36, fps: 25 });
      p.media = { M: { ...media(src), hasAudio: false } };
      const V1 = tracksOfKind(s, 'video')[0].id;
      const [v] = ops.overwriteEdit(s, { media: p.media.M, srcIn: 0, srcOut: 2 }, 0, V1, null);
      s.clips[v].freeze = 3; // bright still
      s.clips[v].transform.opacity.keyframes = [{ frame: 0, value: 0, ease }, { frame: 40, value: 100, ease: 'linear' }];
      const out = join(dir, `ease-${ease}.mp4`);
      execFileSync(FFMPEG, buildRenderPlan(p, s, defaultExport(out)).args, { stdio: 'pipe' });
      const full = lumaAt(out, 1.8);
      const got = lumaAt(out, 10 / 25 + 0.01) / full;
      const want = evalParam(s.clips[v].transform.opacity, 10) / 100;
      expect([ease, Math.abs(got - want) < 0.08]).toEqual([ease, true]);
    }
  }, 120000);
});
