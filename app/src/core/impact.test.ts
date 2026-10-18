import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { IMPACTS, flashAt, formulaFf, formulaJs, parseFormula, projectPoint, sideAt } from './impact';
import { MediaItem, makeProject, makeSequence, tracksOfKind } from './model';
import * as ops from './ops';
import { buildRenderPlan, defaultExport } from './render-graph';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);
const FFPROBE = process.env.FFPROBE ?? (req('ffprobe-static') as { path: string }).path;
const dir = mkdtempSync(join(tmpdir(), 'kurgu-imp-'));
let red = '', blue = '';
const media = (id: string, path: string): MediaItem => ({
  id, path, name: id, kind: 'video', duration: 3, fps: 25, width: 320, height: 180, hasVideo: true, hasAudio: false,
  audioChannels: 0, sampleRate: 0, codec: 'h264', binId: null, label: 'iris', online: true, markIn: null, markOut: null,
});
beforeAll(() => {
  red = join(dir, 'red.mp4'); blue = join(dir, 'blue.mp4');
  for (const [file, c] of [[red, 'red'], [blue, 'blue']]) execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=25:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
}, 60000);

const frameAt = (file: string, sec: number) => execFileSync(FFMPEG, ['-v', 'error', '-ss', `${sec}`, '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);

describe('formula language', () => {
  it('evaluates the same in JS and ffmpeg', () => {
    const src = 'ease(seg(p,0.2,0.8))*2+eo(p)-ei(p)+noise(step(p,7)*3)+iff(gt(p,0.5),sin(PI*p),cos(p))';
    const js = formulaJs(src);
    for (const p of [0, 0.13, 0.5, 0.77, 1]) {
      const ff = formulaFf(src, String(p));
      // evaluate the ffmpeg expression through ffmpeg itself (geq on a 1×1 frame)
      const out = execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=2x2:d=0.04', '-vf', `format=gray,geq=lum='clip(128+40*(${ff}),0,255)'`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
      expect(Math.abs(out[0] - Math.min(255, Math.max(0, 128 + 40 * js(p))))).toBeLessThanOrEqual(1);
    }
  }, 30000);
  it('rejects unknown names', () => {
    expect(() => parseFormula('foo(p)')).toThrow();
    expect(() => parseFormula('p+q')).toThrow();
  });
  it('every impact transition parses and starts/ends unmoved', () => {
    for (const d of IMPACTS) {
      const a0 = sideAt(d.A, 0), b1 = sideAt(d.B, 1);
      const [x0, y0] = projectPoint(-0.5, -0.5, a0, 320, 180);
      const [x1, y1] = projectPoint(-0.5, -0.5, b1, 320, 180);
      expect([d.id, Math.round(x0) + 0, Math.round(y0) + 0]).toEqual([d.id, 0, 0]);
      expect([d.id, Math.round(x1) + 0, Math.round(y1) + 0]).toEqual([d.id, 0, 0]);
      expect(flashAt(d, 0)).toBe(0);
    }
  });
});

describe('impact transitions render with ffmpeg', () => {
  for (const d of IMPACTS) {
    it(`${d.name}`, () => {
      const p = makeProject();
      const s = makeSequence({ width: 320, height: 180, fps: 25 });
      p.media = { R: media('R', red), B: media('B', blue) };
      const V1 = tracksOfKind(s, 'video')[0].id, A1 = tracksOfKind(s, 'audio')[0].id;
      ops.overwriteEdit(s, { media: p.media.R, srcIn: 0.5, srcOut: 1.5 }, 0, V1, A1);
      const [b] = ops.overwriteEdit(s, { media: p.media.B, srcIn: 0.5, srcOut: 1.5 }, 25, V1, A1);
      s.clips[b].transIn = { type: d.id, duration: 20 };
      const out = join(dir, `${d.id}.mp4`);
      execFileSync(FFMPEG, buildRenderPlan(p, s, defaultExport(out)).args, { stdio: 'pipe' });
      const dur = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
      expect(dur).toBeCloseTo(2, 1);
      const before = frameAt(out, 0.2), after = frameAt(out, 1.85);
      expect(before[0]).toBeGreaterThan(180); expect(before[2]).toBeLessThan(80);
      expect(after[2]).toBeGreaterThan(180); expect(after[0]).toBeLessThan(80);
    }, 60000);
  }

  it('a zoom punch actually moves the picture (not just a dissolve)', () => {
    // a picture with a white square in the corner: zooming in pushes it out of frame
    const sq = join(dir, 'sq.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=3', '-vf', 'drawbox=x=0:y=0:w=60:h=40:c=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sq]);
    const p = makeProject();
    const s = makeSequence({ width: 320, height: 180, fps: 25 });
    p.media = { R: media('R', sq), B: media('B', blue) };
    const V1 = tracksOfKind(s, 'video')[0].id, A1 = tracksOfKind(s, 'audio')[0].id;
    ops.overwriteEdit(s, { media: p.media.R, srcIn: 0.5, srcOut: 1.5 }, 0, V1, A1);
    const [b] = ops.overwriteEdit(s, { media: p.media.B, srcIn: 0.5, srcOut: 1.5 }, 25, V1, A1);
    s.clips[b].transIn = { type: 'imp-zoom-in', duration: 24 };
    const out = join(dir, 'zoomcheck.mp4');
    execFileSync(FFMPEG, buildRenderPlan(p, s, defaultExport(out)).args, { stdio: 'pipe' });
    const px = (sec: number) => execFileSync(FFMPEG, ['-v', 'error', '-ss', `${sec}`, '-i', out, '-frames:v', '1', '-vf', 'crop=8:8:10:10,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect(px(0.2)[1]).toBeGreaterThan(200); // white corner box before
    expect(px(0.96)[1]).toBeLessThan(120); // zoomed: the corner now shows red
  }, 60000);
});
