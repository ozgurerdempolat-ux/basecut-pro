// Tail (closing) transitions: a dissolve / dip to black at the end of a clip.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { transitionWindows } from './fx';
import { MediaItem, makeProject, makeSequence, tracksOfKind } from './model';
import * as ops from './ops';
import { buildRenderPlan, defaultExport } from './render-graph';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);
const dir = mkdtempSync(join(tmpdir(), 'kurgu-tout-'));
let red = '', blue = '';
const media = (id: string, path: string): MediaItem => ({
  id, path, name: id, kind: 'video', duration: 3, fps: 25, width: 320, height: 180, hasVideo: true, hasAudio: true,
  audioChannels: 2, sampleRate: 48000, codec: 'h264', binId: null, label: 'iris', online: true, markIn: null, markOut: null,
});

beforeAll(() => {
  red = join(dir, 'red.mp4'); blue = join(dir, 'blue.mp4');
  for (const [file, c] of [[red, 'red'], [blue, 'blue']]) {
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=25:d=3`, '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3', '-ac', '2', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  }
}, 60000);

function setup(two = false) {
  const p = makeProject();
  const s = makeSequence({ width: 320, height: 180, fps: 25 });
  p.media = { R: media('R', red), B: media('B', blue) };
  const V1 = tracksOfKind(s, 'video')[0].id, A1 = tracksOfKind(s, 'audio')[0].id;
  const [r, ra] = ops.overwriteEdit(s, { media: p.media.R, srcIn: 0.5, srcOut: 1.5 }, 0, V1, A1);
  let b: string | undefined;
  if (two) b = ops.overwriteEdit(s, { media: p.media.B, srcIn: 0.5, srcOut: 1.5 }, 25, V1, A1)[0];
  return { p, s, r, ra, b };
}
const frameAt = (file: string, sec: number) => execFileSync(FFMPEG, ['-v', 'error', '-ss', `${sec}`, '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
function rmsAt(file: string, sec: number): number {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-ss', `${sec}`, '-t', '0.04', '-i', file, '-vn', '-ac', '1', '-f', 'f32le', '-']);
  const f = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  let t = 0; for (const v of f) t += v * v;
  return Math.sqrt(t / Math.max(1, f.length));
}

describe('closing (tail) transitions', () => {
  it('a tail with nothing after it is a one-sided window ending at the clip end', () => {
    const { s, r } = setup();
    s.clips[r].transOut = { type: 'cross', duration: 10 };
    const { windows, cutEnd } = transitionWindows(Object.values(s.clips).filter((c) => c.stream === 'video'));
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ a: 15, b: 25, B: null, side: 'out' });
    expect(cutEnd.get(r)).toBe(15);
  });

  it('a tail touching the next clip becomes that cut (unless the next clip has its own head transition)', () => {
    const { s, r, b } = setup(true);
    s.clips[r].transOut = { type: 'wipeleft', duration: 10 };
    let w = transitionWindows(Object.values(s.clips).filter((c) => c.stream === 'video')).windows;
    expect(w).toHaveLength(1);
    expect(w[0].A?.id).toBe(r); expect(w[0].B?.id).toBe(b); expect(w[0].type).toBe('wipeleft');
    s.clips[b!].transIn = { type: 'cross', duration: 10 };
    w = transitionWindows(Object.values(s.clips).filter((c) => c.stream === 'video')).windows;
    expect(w).toHaveLength(1);
    expect(w[0].type).toBe('cross');
  });

  it('split keeps the tail transition on the right part', () => {
    const { s, r } = setup();
    s.clips[r].transOut = { type: 'cross', duration: 10 };
    s.clips[r].transIn = { type: 'cross', duration: 10 };
    const [right] = ops.razor(s, 12, [s.clips[r].trackId]);
    expect(s.clips[r].transOut).toBeUndefined();
    expect(s.clips[r].transIn).toBeDefined();
    const rc = Object.values(s.clips).find((c) => c.stream === 'video' && c.start === 12)!;
    expect(rc.transOut).toBeDefined(); expect(rc.transIn).toBeUndefined();
    void right;
  });

  it('exports a closing dissolve to black: full picture, then darker, then black', () => {
    const { p, s, r } = setup();
    s.clips[r].transOut = { type: 'cross', duration: 20 };
    const out = join(dir, 'tail.mp4');
    execFileSync(FFMPEG, buildRenderPlan(p, s, defaultExport(out)).args, { stdio: 'pipe' });
    const early = frameAt(out, 0.1), mid = frameAt(out, 0.6), late = frameAt(out, 0.96);
    expect(early[0]).toBeGreaterThan(200);
    expect(mid[0]).toBeLessThan(200); expect(mid[0]).toBeGreaterThan(40);
    expect(late[0]).toBeLessThan(40);
  }, 60000);

  it('dip to black at the end, and audio fades out under it', () => {
    const { p, s, r, ra } = setup();
    s.clips[r].transOut = { type: 'fadeblack', duration: 20 };
    s.clips[ra].transOut = { type: 'constant-power', duration: 20 };
    const out = join(dir, 'tailblack.mp4');
    execFileSync(FFMPEG, buildRenderPlan(p, s, defaultExport(out)).args, { stdio: 'pipe' });
    expect(frameAt(out, 0.1)[0]).toBeGreaterThan(200);
    expect(frameAt(out, 0.95)[0]).toBeLessThan(60);
    const loud = rmsAt(out, 0.1), soft = rmsAt(out, 0.92);
    expect(loud).toBeGreaterThan(0.05);
    expect(soft).toBeLessThan(loud * 0.4);
  }, 60000);
});
