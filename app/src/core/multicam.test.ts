import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { expandMulticam, makeMulticamSource, syncOffset } from './multicam';
import { MediaItem, defaultTransform, makeProject, makeSequence, param, tracksOfKind } from './model';
import { buildRenderPlan, defaultExport } from './render-graph';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);
const dir = mkdtempSync(join(tmpdir(), 'kurgu-mc-'));
let camA = '', camB = '';

function env(file: string, rate: number): Float32Array {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const hop = 8000 / rate, out = new Float32Array(Math.floor(f.length / hop));
  for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < hop; j++) s += f[i * hop + j] ** 2; out[i] = Math.sqrt(s / hop); }
  return out;
}

beforeAll(() => {
  // the same "room sound": random claps/speech bursts; camera B started 2.37 s later and has its own noise floor and gain
  const master = join(dir, 'room.wav');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*220*t)*gt(sin(1.7*t)+sin(3.1*t+1)+sin(0.6*t+2),1.2)+0.6*sin(2*PI*440*t)*gt(sin(2.3*t+0.5),0.92)':s=8000:d=20", master]);
  camA = join(dir, 'a.mp4'); camB = join(dir, 'b.mp4');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=64x36:r=25:d=16', '-ss', '1', '-t', '16', '-i', master, '-af', 'volume=0.7', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', camA]);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:s=64x36:r=25:d=14', '-ss', '3.37', '-t', '14', '-i', master, '-f', 'lavfi', '-t', '14', '-i', 'anoisesrc=a=0.03:r=8000', '-filter_complex', '[1:a]volume=1.6[x];[x][2:a]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', camB]);
}, 60000);

const media = (id: string, path: string, d: number): MediaItem => ({ id, path, name: id, kind: 'video', duration: d, fps: 25, width: 64, height: 36, hasVideo: true, hasAudio: true, audioChannels: 1, sampleRate: 8000, codec: 'h264', binId: null, label: 'iris', online: true, markIn: null, markOut: null });

describe('multicam', () => {
  it('audio sync finds the offset between cameras (±1 frame)', () => {
    const r = syncOffset(env(camA, 100), env(camB, 100), 100, 10);
    // B's first sample is A's 2.37 s → B must be placed 2.37 s later
    expect(Math.abs(r.offset - 2.37)).toBeLessThan(0.04);
    expect(r.confidence).toBeGreaterThan(0.3);
  }, 60000);

  it('expanding a multicam clip shows the chosen angle in sync, and export renders it', () => {
    const p = makeProject();
    const A = media('A', camA, 16), B = media('B', camB, 14);
    p.media = { A, B };
    const src = makeMulticamSource('MC', [A, B], [0, 2.37], 25);
    p.sequences[src.id] = src;
    const s = makeSequence({ width: 64, height: 36, fps: 25 });
    const V1 = tracksOfKind(s, 'video')[0].id;
    // two multicam segments: angle 0 for 1 s, then angle 1 for 2 s, starting 3 s into the source sequence
    const mk = (id: string, start: number, dur: number, srcIn: number, angle: number) => ({ id, trackId: V1, mediaId: 'MCM', stream: 'video' as const, start, duration: dur, srcIn, speed: 1, linkId: null, enabled: true, name: 'mc', label: 'iris' as const, transform: defaultTransform(), volumeDb: param(0), mc: { seqId: src.id, angle } });
    s.clips.x = mk('x', 0, 25, 3, 0);
    s.clips.y = mk('y', 25, 50, 4, 1);
    p.media.MCM = { ...A, id: 'MCM', synthetic: { type: 'multicam', seqId: src.id } };
    const flat = expandMulticam(s, p.sequences);
    const ys = Object.values(flat.clips).filter((c) => c.id.startsWith('y>'));
    expect(ys).toHaveLength(1);
    // angle 1 (camera B) starts 2.37 s into the source sequence: at source time 4 s it shows B's 1.63 s
    expect(ys[0].srcIn).toBeCloseTo(4 - 2.36, 1);
    const out = join(dir, 'mc.mp4');
    execFileSync(FFMPEG, buildRenderPlan(p, s, defaultExport(out)).args, { stdio: 'pipe' });
    const px = (t: number) => [...execFileSync(FFMPEG, ['-v', 'error', '-ss', `${t}`, '-i', out, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];
    expect(px(0.5)[0]).toBeGreaterThan(150); // red camera
    expect(px(2)[2]).toBeGreaterThan(150); // blue camera
  }, 60000);
});
