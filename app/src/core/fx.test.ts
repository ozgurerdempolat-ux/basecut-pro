import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { EFFECTS, TRANSITIONS, defaultParams, motionAt, motionOf } from './fx';
import { MediaItem, makeProject, makeSequence, tracksOfKind } from './model';
import * as ops from './ops';
import { buildRenderPlan, defaultExport } from './render-graph';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);
const FFPROBE = process.env.FFPROBE ?? (req('ffprobe-static') as { path: string }).path;
const dir = mkdtempSync(join(tmpdir(), 'kurgu-fx-'));
let red = '', blue = '';

const media = (id: string, path: string): MediaItem => ({
  id, path, name: id, kind: 'video', duration: 3, fps: 25, width: 320, height: 180, hasVideo: true, hasAudio: true,
  audioChannels: 2, sampleRate: 48000, codec: 'h264', binId: null, label: 'iris', online: true, markIn: null, markOut: null,
});

beforeAll(() => {
  red = join(dir, 'red.mp4'); blue = join(dir, 'blue.mp4');
  for (const [file, c] of [[red, 'red'], [blue, 'blue']]) {
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=25:d=3`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  }
}, 60000);

function twoClips() {
  const p = makeProject();
  const s = makeSequence({ width: 320, height: 180, fps: 25 });
  const R = media('R', red), B = media('B', blue);
  p.media = { R, B };
  const V1 = tracksOfKind(s, 'video')[0].id, A1 = tracksOfKind(s, 'audio')[0].id;
  const [r] = ops.overwriteEdit(s, { media: R, srcIn: 0.5, srcOut: 1.5 }, 0, V1, A1); // 0-25
  const [b] = ops.overwriteEdit(s, { media: B, srcIn: 0.5, srcOut: 1.5 }, 25, V1, A1); // 25-50
  return { p, s, r, b };
}

function frameAt(file: string, sec: number): Buffer {
  return execFileSync(FFMPEG, ['-v', 'error', '-ss', `${sec}`, '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
}

describe('transitions render with ffmpeg', () => {
  it('cross dissolve blends in the middle and keeps duration', () => {
    const { p, s, b } = twoClips();
    s.clips[b].transIn = { type: 'cross', duration: 20 };
    const out = join(dir, 'cross.mp4');
    execFileSync(FFMPEG, buildRenderPlan(p, s, defaultExport(out)).args, { stdio: 'pipe' });
    const d = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
    expect(d).toBeCloseTo(2, 1);
    const before = frameAt(out, 0.2), mid = frameAt(out, 1.0), after = frameAt(out, 1.8);
    expect(before[0]).toBeGreaterThan(200); // red
    expect(after[2]).toBeGreaterThan(200); // blue
    expect(mid[0]).toBeGreaterThan(60); expect(mid[0]).toBeLessThan(200); // mix
    expect(mid[2]).toBeGreaterThan(60); expect(mid[2]).toBeLessThan(200);
  }, 60000);

  it('fade in from black when nothing is before the clip', () => {
    const { p, s, r } = twoClips();
    s.clips[r].transIn = { type: 'cross', duration: 20 };
    const out = join(dir, 'fadein.mp4');
    execFileSync(FFMPEG, buildRenderPlan(p, s, defaultExport(out)).args, { stdio: 'pipe' });
    expect(frameAt(out, 0.0)[0]).toBeLessThan(60);
    expect(frameAt(out, 0.9)[0]).toBeGreaterThan(200);
  }, 60000);

  it('every transition type renders', () => {
    const { p, s, b } = twoClips();
    const out = join(dir, 'all.mp4');
    for (const t of TRANSITIONS) {
      s.clips[b].transIn = { type: t.id, duration: 10 };
      execFileSync(FFMPEG, buildRenderPlan(p, { ...s, inPoint: 18, outPoint: 32 }, { ...defaultExport(out), range: 'inout', preset: 'ultrafast' }).args, { stdio: 'pipe' });
    }
    expect(TRANSITIONS.length).toBeGreaterThanOrEqual(30);
  }, 300000);
});

describe('effects render with ffmpeg', () => {
  for (const e of EFFECTS) {
    it(`effect "${e.name}" renders`, () => {
      const { p, s, r } = twoClips();
      s.clips[r].effects = [{ id: 'e1', type: e.id, enabled: true, params: defaultParams(e.id) }];
      const out = join(dir, `fx-${e.id}.mp4`);
      execFileSync(FFMPEG, buildRenderPlan(p, { ...s, inPoint: 0, outPoint: 12 }, { ...defaultExport(out), range: 'inout', preset: 'ultrafast' }).args, { stdio: 'pipe' });
      const px = frameAt(out, 0.2);
      if (e.id === 'invert') expect(px[1]).toBeGreaterThan(200); // red → cyan
      if (e.id === 'bw') expect(Math.abs(px[0] - px[1])).toBeLessThan(12);
    }, 60000);
  }

  it('blurred background fills the sides of a vertical frame', () => {
    const { p, s, r } = twoClips();
    s.width = 180; s.height = 320; // vertical sequence, landscape clip
    s.clips[r].effects = [{ id: 'e1', type: 'blurfill', enabled: true, params: defaultParams('blurfill') }];
    const out = join(dir, 'blurfill.mp4');
    execFileSync(FFMPEG, buildRenderPlan(p, { ...s, inPoint: 0, outPoint: 10 }, { ...defaultExport(out), range: 'inout' }).args, { stdio: 'pipe' });
    const top = execFileSync(FFMPEG, ['-v', 'error', '-ss', '0.1', '-i', out, '-frames:v', '1', '-vf', 'crop=iw:20:0:5,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect(top[0]).toBeGreaterThan(80); // red-ish instead of black bars
  }, 60000);

  it('motion effects use the same formula in preview and export', () => {
    const fx = [{ id: 'a', type: 'shake', enabled: true, params: defaultParams('shake') }, { id: 'b', type: 'pulse', enabled: true, params: defaultParams('pulse') }];
    const m = motionOf(fx, 1080, 30)!;
    for (const L of [0, 7, 15, 31]) {
      const js = motionAt(fx, 1080, 30, L);
      // evaluate the ffmpeg expressions in JS (they only use sin/cos/mod/pow and *, +)
      const ev = (e: string) => Function('L', 'sin', 'cos', 'mod', 'pow', 'gt', `return ${e};`)(L, Math.sin, Math.cos, (a: number, b: number) => ((a % b) + b) % b, Math.pow, (a: number, b: number) => (a > b ? 1 : 0));
      expect(ev(m.dx)).toBeCloseTo(js.dx, 6);
      expect(ev(m.dy)).toBeCloseTo(js.dy, 6);
      expect(ev(m.scale)).toBeCloseTo(js.scale, 6);
    }
  });
});
