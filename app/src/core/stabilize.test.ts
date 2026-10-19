// Warp Stabilizer quality: synthetic handheld footage with a tracked marker.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MediaItem, makeProject, makeSequence, tracksOfKind } from './model';
import * as ops from './ops';
import { buildRenderPlan, defaultExport } from './render-graph';
import { DEFAULT_STAB, StabParams, detectArgs, needsStabilize, stabKey, stabRange, stabilizedSource, transformArgs } from './stabilize';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);
const dir = mkdtempSync(join(tmpdir(), 'kurgu-stab-'));
const W = 640, H = 360;
let shakyPan = '', shakyStatic = '';

beforeAll(() => {
  const plate = join(dir, 'plate.png');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=gray:s=1200x700:d=0.04,noise=alls=100:allf=u,gblur=sigma=3,eq=contrast=6,geq=lum='lum(X,Y)':cb='128+50*sin(X/95)':cr='128+50*cos(Y/75)',drawbox=x=595:y=345:w=10:h=10:c=white:t=fill`, '-frames:v', '1', plate]);
  const shake = (pan: boolean) => `rotate=a='0.012*sin(n*0.9)+0.008*sin(n*2.3)':c=black,crop=${W}:${H}:x='280${pan ? '+n*0.6' : ''}+14*sin(n*0.7)+7*sin(n*1.9+1)+3.5*sin(n*4.1)':y='170+11*sin(n*0.83+2)+5.5*sin(n*2.6)+3*sin(n*5.3+0.4)'`;
  shakyPan = join(dir, 'pan.mp4'); shakyStatic = join(dir, 'static.mp4');
  for (const [out, pan] of [[shakyPan, true], [shakyStatic, false]] as const) {
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-loop', '1', '-framerate', '30', '-i', plate, '-t', '4', '-vf', shake(pan), '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', out]);
  }
}, 120000);

/** marker centre per frame */
function track(file: string): [number, number][] {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 });
  const pts: [number, number][] = [];
  for (let o = 0; o + W * H <= raw.length; o += W * H) {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (raw[o + y * W + x] > 235) { sx += x; sy += y; n++; }
    pts.push(n ? [sx / n, sy / n] : [NaN, NaN]);
  }
  return pts;
}
const jitter = (p: [number, number][]) => { let s = 0, n = 0; for (let i = 2; i < p.length; i++) { const ax = p[i][0] - 2 * p[i - 1][0] + p[i - 2][0], ay = p[i][1] - 2 * p[i - 1][1] + p[i - 2][1]; if (Number.isFinite(ax + ay)) { s += Math.hypot(ax, ay); n++; } } return s / n; };
const spread = (p: [number, number][]) => { const ok = p.filter((x) => Number.isFinite(x[0])); const m = [0, 1].map((k) => ok.reduce((a, x) => a + x[k], 0) / ok.length); return Math.sqrt(ok.reduce((a, x) => a + (x[0] - m[0]) ** 2 + (x[1] - m[1]) ** 2, 0) / ok.length); };

function stabilize(src: string, p: StabParams, name: string): string {
  const trf = join(dir, `${name}.trf`), out = join(dir, `${name}.mp4`);
  execFileSync(FFMPEG, detectArgs(src, [0, 4], trf, p).filter((a) => a !== '-progress' && a !== 'pipe:1'));
  execFileSync(FFMPEG, transformArgs(src, [0, 4], trf, out, p, 30).filter((a) => a !== '-progress' && a !== 'pipe:1'));
  return out;
}

describe('Warp Stabilizer', () => {
  it('smooth motion: removes >95 % of the shake and keeps the intentional pan', () => {
    const before = track(shakyPan);
    const after = track(stabilize(shakyPan, DEFAULT_STAB, 'smooth'));
    const jb = jitter(before), ja = jitter(after);
    expect(ja).toBeLessThan(jb * 0.05);
    // pan kept: the marker still travels (the plate moves ~70 px over the clip)
    const travel = Math.abs(after[after.length - 5][0] - after[5][0]);
    expect(travel).toBeGreaterThan(30);
  }, 120000);

  it('no motion (tripod): a handheld shot stays within ~1.5 px', () => {
    const before = track(shakyStatic);
    const after = track(stabilize(shakyStatic, { ...DEFAULT_STAB, mode: 1 }, 'tripod'));
    expect(spread(before)).toBeGreaterThan(8);
    expect(spread(after)).toBeLessThan(1.5);
  }, 120000);

  it('edge modes: auto zoom and synthesised edges leave no black border', () => {
    const blackShare = (file: string) => {
      const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', 'scale=160:90:flags=neighbor', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 28 });
      let k = 0; for (const v of raw) if (v < 12) k++;
      return k / raw.length;
    };
    expect(blackShare(stabilize(shakyPan, DEFAULT_STAB, 'zoom'))).toBeLessThan(0.01);
    expect(blackShare(stabilize(shakyPan, { ...DEFAULT_STAB, edges: 2 }, 'keep'))).toBeLessThan(0.01);
  }, 120000);

  it('the timeline uses the render only when it matches the clip and settings', () => {
    const p = makeProject();
    const s = makeSequence({ width: W, height: H, fps: 30 });
    const m: MediaItem = { id: 'M', path: shakyPan, name: 'pan', kind: 'video', duration: 4, fps: 30, width: W, height: H, hasVideo: true, hasAudio: false, audioChannels: 0, sampleRate: 0, codec: 'h264', binId: null, label: 'iris', online: true, markIn: null, markOut: null };
    p.media = { M: m };
    const [v] = ops.overwriteEdit(s, { media: m, srcIn: 1, srcOut: 3 }, 0, tracksOfKind(s, 'video')[0].id, null);
    const c = s.clips[v];
    c.effects = [{ id: 'e', type: 'warpstab', enabled: true, params: { ...DEFAULT_STAB } }];
    expect(needsStabilize(c, m, 30)).toBe(true);
    const { analyse } = stabRange(c, m, 30);
    expect(analyse).toEqual([0, 4]);
    const out = stabilize(shakyPan, DEFAULT_STAB, 'tl');
    c.stab = { key: stabKey(m, DEFAULT_STAB, analyse), path: out, lo: analyse[0], hi: analyse[1] };
    expect(stabilizedSource(c, m, 30)?.path).toBe(out);
    // settings change → stale
    c.effects[0].params.smooth = 80;
    expect(stabilizedSource(c, m, 30)).toBeNull();
    c.effects[0].params.smooth = 50;
    // export reads the stabilised file at the right time: compare to the render's frame
    const exp = join(dir, 'tl-export.mp4');
    execFileSync(FFMPEG, buildRenderPlan(p, s, defaultExport(exp)).args, { stdio: 'pipe' });
    const a = track(exp), b = track(out);
    // export frame i = render frame i + 30 (clip starts 1 s into the analysed range)
    let maxd = 0;
    for (let i = 5; i < 50; i += 7) maxd = Math.max(maxd, Math.hypot(a[i][0] - b[i + 30][0], a[i][1] - b[i + 30][1]));
    expect(maxd).toBeLessThan(1.5);
  }, 180000);
});
