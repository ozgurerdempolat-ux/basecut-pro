import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MediaItem, clipSrcOut, makeProject, makeSequence, remapAdvance, sourceTimeAt, tracksOfKind } from './model';
import * as ops from './ops';
import { buildRenderPlan, defaultExport } from './render-graph';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);
const dir = mkdtempSync(join(tmpdir(), 'kurgu-remap-'));
let src = '';
// frame n has luma 16 + n (n < 220): the shown source frame can be read back from the brightness
beforeAll(() => {
  src = join(dir, 'count.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:r=25:d=8.8,format=gray,geq=lum=16+N', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', src]);
}, 60000);
const media = (): MediaItem => ({ id: 'M', path: src, name: 'c', kind: 'video', duration: 8.8, fps: 25, width: 64, height: 36, hasVideo: true, hasAudio: false, audioChannels: 0, sampleRate: 0, codec: 'h264', binId: null, label: 'iris', online: true, markIn: null, markOut: null });

function setup() {
  const p = makeProject();
  const s = makeSequence({ width: 64, height: 36, fps: 25 });
  p.media = { M: media() };
  const [v] = ops.overwriteEdit(s, { media: p.media.M, srcIn: 0, srcOut: 4 }, 0, tracksOfKind(s, 'video')[0].id, null);
  // normal speed for 1 s, ramps to 3× over 1 s, stays fast
  s.clips[v].remap = { value: 100, keyframes: [{ frame: 0, value: 100, ease: 'linear' }, { frame: 25, value: 100, ease: 'linear' }, { frame: 50, value: 300, ease: 'linear' }] };
  return { p, s, v };
}

describe('time remapping (speed ramps)', () => {
  it('source time integrates the speed curve', () => {
    const { s, v } = setup();
    const c = s.clips[v];
    expect(remapAdvance(c, 25, 25)).toBeCloseTo(1, 5);
    // ramp 1→3 over 25 frames: average 2 → 2 s of source
    expect(remapAdvance(c, 50, 25)).toBeCloseTo(1 + 2, 1);
    expect(sourceTimeAt(c, 75, 25)).toBeCloseTo(3 + 3, 1);
    expect(clipSrcOut(c, 25)).toBeGreaterThan(6);
  });
  it('trimming the head moves the source by the ramp, not by the base speed', () => {
    const { s, v } = setup();
    const before = sourceTimeAt(s.clips[v], 60, 25)!;
    ops.trimEdge(s, { M: media() }, v, 'in', 40, 'normal');
    const c = s.clips[v];
    expect(c.start).toBe(40);
    expect(sourceTimeAt(c, 60, 25)).toBeCloseTo(before, 5);
  });
  it('split keeps every frame where it was', () => {
    const { s, v } = setup();
    const want = [10, 30, 45, 60, 90].map((f) => sourceTimeAt(s.clips[v], f, 25)!);
    ops.splitAt(s, 37, [s.clips[v].trackId]);
    const clips = Object.values(s.clips);
    const at = (f: number) => clips.map((c) => sourceTimeAt(c, f, 25)).find((x) => x !== null)!;
    [10, 30, 45, 60, 90].forEach((f, i) => expect(at(f)).toBeCloseTo(want[i], 5));
  });
  it('export shows the same source frames as the preview', () => {
    const { p, s, v } = setup();
    const out = join(dir, 'ramp.mp4');
    const args = buildRenderPlan(p, s, defaultExport(out)).args;
    const fi = args.indexOf('-filter_complex');
    writeFileSync(join(dir, 'graph.txt'), args[fi + 1]);
    args.splice(fi, 2, '-filter_complex_script', join(dir, 'graph.txt'));
    const ci = args.indexOf('-crf'); if (ci > 0) args[ci + 1] = '0';
    execFileSync(FFMPEG, args, { stdio: 'pipe' });
    const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', out, '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-']);
    for (const f of [5, 20, 30, 40, 55, 70, 90]) {
      const want = Math.round(sourceTimeAt(s.clips[v], f, 25)! * 25);
      const got = raw[f] - 16;
      expect([f, Math.abs(got - want) <= 1]).toEqual([f, true]);
    }
  }, 60000);
});
