import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MediaItem, makeProject, makeSequence, tracksOfKind } from './model';
import * as ops from './ops';
import { buildRenderPlan, defaultExport } from './render-graph';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';
const dir = mkdtempSync(join(tmpdir(), 'kurgu-render-'));

function probe(file: string) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file]).toString();
  return JSON.parse(out) as { format: { duration: string }; streams: { codec_type: string; width?: number; height?: number }[] };
}

function media(id: string, path: string, duration: number, kind: MediaItem['kind'] = 'video'): MediaItem {
  return {
    id, path, name: id, kind, duration, fps: 30, width: 640, height: 360, hasVideo: kind !== 'audio',
    hasAudio: kind === 'video' || kind === 'audio', audioChannels: 2, sampleRate: 48000, codec: 'h264',
    binId: null, label: 'iris', online: true, markIn: null, markOut: null,
  };
}

let clipA = '', clipB = '', still = '';

beforeAll(() => {
  clipA = join(dir, 'a.mp4');
  clipB = join(dir, 'b.mp4');
  still = join(dir, 'still.png');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clipA]);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'mandelbrot=s=640x480:r=30', '-f', 'lavfi', '-i', 'sine=f=880:d=3', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clipB]);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x320', '-frames:v', '1', still]);
}, 60000);

describe('render graph → real ffmpeg', () => {
  it('exports a multi-track edit with speed, reverse, still, opacity and keyframes', () => {
    const p = makeProject();
    const s = makeSequence({ width: 1280, height: 720, fps: 30 });
    p.sequences[s.id] = s;
    const A = media('A', clipA, 4), B = media('B', clipB, 3), S = media('S', still, Infinity, 'image');
    p.media = { A, B, S };
    const V1 = tracksOfKind(s, 'video')[0].id, V2 = tracksOfKind(s, 'video')[1].id;
    const A1 = tracksOfKind(s, 'audio')[0].id;
    ops.overwriteEdit(s, { media: A, srcIn: 0, srcOut: 2 }, 0, V1, A1); // 0-60
    const [b] = ops.overwriteEdit(s, { media: B, srcIn: 0, srcOut: 2 }, 60, V1, A1); // 60-120
    ops.setSpeed(s, b, 2, true); // 60-90
    const [r] = ops.overwriteEdit(s, { media: A, srcIn: 2, srcOut: 3 }, 90, V1, A1); // 90-120
    ops.setSpeed(s, r, -1, true);
    const [st] = ops.overwriteEdit(s, { media: S, srcIn: 0, srcOut: 1 }, 15, V2, null); // 15-45 over it
    s.clips[st].transform.opacity.value = 60;
    s.clips[st].transform.scale.value = 40;
    s.clips[st].transform.posX.keyframes = [{ frame: 0, value: -300, ease: 'linear' }, { frame: 29, value: 300, ease: 'ease' }];
    s.clips[st].transform.rotation.value = 15;

    const out = join(dir, 'out.mp4');
    const plan = buildRenderPlan(p, s, defaultExport(out));
    expect(plan.durationSec).toBeCloseTo(4);
    execFileSync(FFMPEG, plan.args, { stdio: 'pipe' });
    const info = probe(out);
    expect(Number(info.format.duration)).toBeGreaterThan(3.9);
    expect(Number(info.format.duration)).toBeLessThan(4.15);
    const v = info.streams.find((x) => x.codec_type === 'video')!;
    expect([v.width, v.height]).toEqual([1280, 720]);
    expect(info.streams.some((x) => x.codec_type === 'audio')).toBe(true);
    // frame inside the still overlay should be reddish; frame after should not be
    const px = (t: number) => execFileSync(FFMPEG, ['-v', 'error', '-ss', `${t}`, '-i', out, '-vf', 'crop=4:4:638:358,scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const mid = px(1.0);
    expect(mid[0]).toBeGreaterThan(120); // red channel high where the still sits
  }, 120000);

  it('exports in/out range, audio-only and vertical presets', () => {
    const p = makeProject();
    const s = makeSequence({ width: 1920, height: 1080, fps: 30 });
    const A = media('A', clipA, 4);
    p.media = { A };
    ops.overwriteEdit(s, { media: A, srcIn: 0, srcOut: 4 }, 0, tracksOfKind(s, 'video')[0].id, tracksOfKind(s, 'audio')[0].id);
    s.inPoint = 30; s.outPoint = 75;
    const out = join(dir, 'range.mp4');
    execFileSync(FFMPEG, buildRenderPlan(p, s, { ...defaultExport(out), range: 'inout', width: 1080, height: 1920 }).args, { stdio: 'pipe' });
    const info = probe(out);
    expect(Number(info.format.duration)).toBeCloseTo(1.5, 1);
    expect(info.streams.find((x) => x.codec_type === 'video')!.height).toBe(1920);

    const wav = join(dir, 'a.wav');
    execFileSync(FFMPEG, buildRenderPlan(p, s, { ...defaultExport(wav), container: 'wav', videoCodec: 'none', audioCodec: 'pcm' }).args, { stdio: 'pipe' });
    const w = probe(wav);
    expect(w.streams.every((x) => x.codec_type === 'audio')).toBe(true);
    expect(Number(w.format.duration)).toBeCloseTo(4, 1);
  }, 120000);

  it('refuses an empty range', () => {
    const p = makeProject();
    const s = makeSequence();
    expect(() => buildRenderPlan(p, s, defaultExport('/tmp/x.mp4'))).toThrow();
  });
});
