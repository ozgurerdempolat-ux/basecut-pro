import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AUDIO_EFFECTS, defaultAudioParams, fadeGain } from './audiofx';
import { MediaItem, makeProject, makeSequence, tracksOfKind } from './model';
import * as ops from './ops';
import { buildRenderPlan, defaultExport } from './render-graph';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);
const dir = mkdtempSync(join(tmpdir(), 'kurgu-afx-'));
let tone = '';
const media = (id: string, path: string): MediaItem => ({ id, path, name: id, kind: 'audio', duration: 4, fps: 30, width: 0, height: 0, hasVideo: false, hasAudio: true, audioChannels: 2, sampleRate: 48000, codec: 'pcm', binId: null, label: 'caribbean', online: true, markIn: null, markOut: null });

beforeAll(() => {
  tone = join(dir, 'tone.wav');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=4:sample_rate=48000', '-ac', '2', tone]);
}, 30000);

/** RMS of the exported audio in 50 ms windows, per channel */
function envelope(file: string): { l: number[]; r: number[] } {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '2', '-ar', '8000', '-']);
  const s = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const l: number[] = [], r: number[] = [];
  const win = 400 * 2;
  for (let i = 0; i + win <= s.length; i += win) {
    let a = 0, b = 0;
    for (let k = i; k < i + win; k += 2) { a += s[k] * s[k]; b += s[k + 1] * s[k + 1]; }
    l.push(Math.sqrt(a / 400) / 32768); r.push(Math.sqrt(b / 400) / 32768);
  }
  return { l, r };
}

function seqWith(...ranges: [number, number, number][]) {
  const p = makeProject();
  const s = makeSequence({ fps: 30 });
  const M = media('T', tone);
  p.media = { T: M };
  const A1 = tracksOfKind(s, 'audio')[0].id;
  const ids = ranges.map(([at, a, b]) => ops.overwriteEdit(s, { media: M, srcIn: a, srcOut: b }, at, null, A1)[0]);
  return { p, s, ids, A1 };
}

describe('audio', () => {
  it('fade-in when nothing is before the clip', () => {
    const { p, s, ids } = seqWith([0, 0, 2]);
    s.clips[ids[0]].transIn = { type: 'constant-power', duration: 30 };
    const out = join(dir, 'fin.wav');
    execFileSync(FFMPEG, buildRenderPlan(p, s, { ...defaultExport(out), container: 'wav', videoCodec: 'none', audioCodec: 'pcm' }).args, { stdio: 'pipe' });
    const e = envelope(out).l;
    expect(e[0]).toBeLessThan(e[25] * 0.5);
    expect(e[25]).toBeGreaterThan(0.05);
  }, 30000);

  it('crossfade keeps level steady through the cut (constant power, overlapping handles)', () => {
    const { p, s, ids } = seqWith([0, 0, 2], [60, 1, 3]);
    s.clips[ids[1]].transIn = { type: 'constant-power', duration: 30 };
    const out = join(dir, 'xf.wav');
    execFileSync(FFMPEG, buildRenderPlan(p, s, { ...defaultExport(out), container: 'wav', videoCodec: 'none', audioCodec: 'pcm' }).args, { stdio: 'pipe' });
    const e = envelope(out).l;
    const around = e.slice(32, 48); // 1.6 s .. 2.4 s
    const peak = Math.max(...e);
    // a hard cut into silence or a bad crossfade dips; constant power stays near full level
    for (const v of around) expect(v).toBeGreaterThan(peak * 0.7);
  }, 30000);

  it('pan moves the sound to one side', () => {
    const { p, s } = seqWith([0, 0, 1]);
    s.tracks.find((t) => t.kind === 'audio')!.pan = -100;
    const out = join(dir, 'pan.wav');
    execFileSync(FFMPEG, buildRenderPlan(p, s, { ...defaultExport(out), container: 'wav', videoCodec: 'none', audioCodec: 'pcm' }).args, { stdio: 'pipe' });
    const e = envelope(out);
    expect(e.l[5]).toBeGreaterThan(0.05);
    expect(e.r[5]).toBeLessThan(0.005);
  }, 30000);

  for (const fx of AUDIO_EFFECTS) {
    it(`audio effect "${fx.name}" renders`, () => {
      const { p, s, ids } = seqWith([0, 0, 1]);
      s.clips[ids[0]].audioFx = [{ id: 'x', type: fx.id, enabled: true, params: defaultAudioParams(fx.id) }];
      const out = join(dir, `afx-${fx.id}.wav`);
      execFileSync(FFMPEG, buildRenderPlan(p, s, { ...defaultExport(out), container: 'wav', videoCodec: 'none', audioCodec: 'pcm' }).args, { stdio: 'pipe' });
      const e = envelope(out).l;
      expect(Math.max(...e)).toBeGreaterThan(0.01);
    }, 30000);
  }

  it('fade curves match ffmpeg names', () => {
    expect(fadeGain('qsin', 0.5)).toBeCloseTo(Math.SQRT1_2, 5);
    expect(fadeGain('tri', 0.25)).toBe(0.25);
  });
});
