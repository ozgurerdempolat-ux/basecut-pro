import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BLEND_MODES, BlendMode, MediaItem, makeProject, makeSequence, tracksOfKind } from './model';
import * as ops from './ops';
import { buildRenderPlan, defaultExport } from './render-graph';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);
const dir = mkdtempSync(join(tmpdir(), 'kurgu-blend-'));
const BASE = [200, 90, 40], TOP = [60, 160, 230];
let base = '', top = '';
const media = (id: string, path: string): MediaItem => ({ id, path, name: id, kind: 'video', duration: 2, fps: 25, width: 160, height: 90, hasVideo: true, hasAudio: false, audioChannels: 0, sampleRate: 0, codec: 'h264', binId: null, label: 'iris', online: true, markIn: null, markOut: null });
const hex = (c: number[]) => `0x${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
beforeAll(() => {
  base = join(dir, 'base.mp4'); top = join(dir, 'top.mp4');
  for (const [f, c] of [[base, BASE], [top, TOP]] as const) execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${hex(c as number[])}:s=160x90:r=25:d=2`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', f]);
}, 60000);

// W3C compositing formulas, which is what the canvas preview uses
function w3c(mode: BlendMode, b: number, s: number): number {
  switch (mode) {
    case 'multiply': return b * s;
    case 'screen': return b + s - b * s;
    case 'overlay': return w3c('hard-light', s, b);
    case 'darken': return Math.min(b, s);
    case 'lighten': return Math.max(b, s);
    case 'color-dodge': return b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 'color-burn': return b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    case 'hard-light': return s <= 0.5 ? b * 2 * s : w3c('screen', b, 2 * s - 1);
    case 'soft-light': { if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b); const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b); return b + (2 * s - 1) * (d - b); }
    case 'difference': return Math.abs(b - s);
    case 'exclusion': return b + s - 2 * b * s;
    case 'add': return Math.min(1, b + s);
    default: return s;
  }
}

function render(setup: (s: ReturnType<typeof makeSequence>, top: string) => void, name: string) {
  const p = makeProject();
  const s = makeSequence({ width: 160, height: 90, fps: 25 });
  p.media = { B: media('B', base), T: media('T', top) };
  const [V1, V2] = tracksOfKind(s, 'video').map((t) => t.id);
  ops.overwriteEdit(s, { media: p.media.B, srcIn: 0, srcOut: 1.5 }, 0, V1, null);
  const [t] = ops.overwriteEdit(s, { media: p.media.T, srcIn: 0, srcOut: 1 }, 5, V2, null);
  setup(s, t);
  const out = join(dir, `${name}.mp4`);
  const settings = { ...defaultExport(out), videoCodec: 'h264' as const };
  const args = buildRenderPlan(p, s, settings).args;
  // lossless-ish to measure colours
  const i = args.indexOf('-crf'); if (i > 0) args[i + 1] = '0';
  execFileSync(FFMPEG, args, { stdio: 'pipe' });
  return out;
}
const px = (file: string, sec: number, x = 80, y = 45) => [...execFileSync(FFMPEG, ['-v', 'error', '-ss', `${sec}`, '-i', file, '-frames:v', '1', '-vf', `crop=4:4:${x - 2}:${y - 2},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];

describe('blend modes', () => {
  for (const m of BLEND_MODES.filter((b) => b.id !== 'normal')) {
    it(`${m.name} matches the preview formula`, () => {
      const out = render((s, t) => { s.clips[t].blend = m.id; }, m.id);
      const got = px(out, 0.6);
      const want = BASE.map((b, k) => Math.round(255 * w3c(m.id, b / 255, TOP[k] / 255)));
      for (let k = 0; k < 3; k++) expect([m.id, k, Math.abs(got[k] - want[k]) <= 8]).toEqual([m.id, k, true]);
      // outside the clip's time the base is untouched
      const before = px(out, 0.08);
      expect(Math.abs(before[0] - BASE[0])).toBeLessThanOrEqual(6);
    }, 60000);
  }
  it('opacity mixes the blended result', () => {
    const out = render((s, t) => { s.clips[t].blend = 'multiply'; s.clips[t].transform.opacity.value = 50; }, 'mul50');
    const got = px(out, 0.6);
    const want = BASE.map((b, k) => Math.round(0.5 * b + 0.5 * 255 * w3c('multiply', b / 255, TOP[k] / 255)));
    for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k])).toBeLessThanOrEqual(8);
  }, 60000);
});

describe('crop and flip', () => {
  it('crop makes the cropped side transparent', () => {
    const out = render((s, t) => { s.clips[t].effects = [{ id: 'c', type: 'crop', enabled: true, params: { left: 50, top: 0, right: 0, bottom: 0 } }]; }, 'crop');
    const left = px(out, 0.6, 20, 45), right = px(out, 0.6, 140, 45);
    expect(Math.abs(left[0] - BASE[0])).toBeLessThanOrEqual(8);
    expect(Math.abs(right[2] - TOP[2])).toBeLessThanOrEqual(8);
  }, 60000);
});

describe('adjustment layer', () => {
  it('applies its effects to everything below, only during the clip', () => {
    const p = makeProject();
    const s = makeSequence({ width: 160, height: 90, fps: 25 });
    const adjPng = join(dir, 'adj.png');
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black@0:s=64x36,format=rgba', '-frames:v', '1', adjPng]);
    p.media = { B: media('B', base), A: { ...media('A', adjPng), kind: 'image', duration: Infinity, synthetic: { type: 'adjustment' } } };
    const [V1, V2] = tracksOfKind(s, 'video').map((t) => t.id);
    ops.overwriteEdit(s, { media: p.media.B, srcIn: 0, srcOut: 1.5 }, 0, V1, null);
    const [a] = ops.overwriteEdit(s, { media: p.media.A, srcIn: 0, srcOut: 0.8 }, 10, V2, null);
    s.clips[a].effects = [{ id: 'bw', type: 'bw', enabled: true, params: { amount: 100 } }, { id: 'sh', type: 'shake', enabled: true, params: { amount: 0.5, speed: 1 } }];
    const out = join(dir, 'adj.mp4');
    const args = buildRenderPlan(p, s, defaultExport(out)).args;
    execFileSync(FFMPEG, args, { stdio: 'pipe' });
    const inWin = px(out, 0.6), outWin = px(out, 0.1);
    expect(Math.max(...inWin) - Math.min(...inWin)).toBeLessThan(12); // grey
    expect(outWin[0] - outWin[2]).toBeGreaterThan(100); // still orange-red
  }, 60000);
});

describe('masks', () => {
  it('export keeps the clip only inside the mask image', async () => {
    const { maskKey, newMask } = await import('./mask');
    const maskPng = join(dir, 'mask.png');
    // white disc in the middle = keep
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=black:s=160x90,format=gray,geq=lum='if(lt(hypot(X-80,Y-45),30),255,0)'", '-frames:v', '1', maskPng]);
    const out = render((s, t) => {
      const m = newMask('ellipse', 'm1', 1);
      s.clips[t].masks = [m];
      s.clips[t].maskImage = { key: maskKey([m], 160, 90), path: maskPng };
    }, 'mask');
    const centre = px(out, 0.6, 80, 45), corner = px(out, 0.6, 10, 10);
    expect(Math.abs(centre[2] - TOP[2])).toBeLessThanOrEqual(8);
    expect(Math.abs(corner[0] - BASE[0])).toBeLessThanOrEqual(8);
  }, 60000);
  it('a stale mask image is not used', async () => {
    const { maskImageFor, newMask } = await import('./mask');
    const m = newMask('rect', 'r', 1);
    const c = { masks: [m], maskImage: { key: 'old', path: '/x.png' } };
    expect(maskImageFor(c, 100, 100)).toBeNull();
  });
});
