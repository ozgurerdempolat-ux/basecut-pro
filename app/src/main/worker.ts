// Media worker. Runs in its own utility process so that a codec crash, a
// runaway ffmpeg or a huge file can never take the editor down with it.
// The main process restarts it if it dies.

import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { buildRenderPlan } from '../core/render-graph';
import { bakeLut, gradeKey, isNeutral, parseCube, toCube } from '../core/color';
import type { Clip } from '../core/model';
import type { ExportRequest, MediaAssets, ProbeResult, StabilizeRequest, WorkerRequest, WorkerResponse } from '../shared/ipc';
import { detectArgs, transformArgs } from '../core/stabilize';
import { ReframeSample, saliency } from '../core/reframe';
import { FFMPEG, FFPROBE } from './ffbin';

const port = (process as unknown as { parentPort: { on(e: 'message', cb: (m: { data: WorkerRequest }) => void): void; postMessage(m: WorkerResponse): void } }).parentPort;
const CACHE = process.env.KURGU_CACHE ?? join(process.cwd(), '.basecut-cache');
mkdirSync(CACHE, { recursive: true });

const running = new Map<string, ChildProcess>();

function send(m: WorkerResponse) { port.postMessage(m); }

function run(bin: string, args: string[], opts: { jobId?: string; onStdout?: (s: string) => void; binary?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    if (opts.jobId) running.set(opts.jobId, p);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => { out.push(d); opts.onStdout?.(d.toString()); });
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', reject);
    p.on('close', (code, signal) => {
      if (opts.jobId) running.delete(opts.jobId);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(signal ? 'İptal edildi' : lastLines(err)));
    });
  });
}

function lastLines(s: string): string {
  return s.trim().split('\n').slice(-4).join('\n') || 'ffmpeg failed';
}

function cacheKey(path: string): string {
  let sig = path;
  try { const st = statSync(path); sig += `|${st.size}|${st.mtimeMs}`; } catch { /* offline */ }
  return createHash('sha1').update(sig).digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------ probe

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif', '.psd', '.exr', '.dpx', '.tga']);
const BROWSER_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'hevc', 'theora']);
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8', 'alac']);
const BROWSER_IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);

interface FFStream { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; channels?: number; sample_rate?: string; pix_fmt?: string; disposition?: { attached_pic?: number }; duration?: string; }

async function probe(path: string): Promise<ProbeResult> {
  if (!existsSync(path)) throw new Error('Dosya bulunamadı');
  const raw = await run(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]);
  const j = JSON.parse(raw.toString()) as { streams: FFStream[]; format: { duration?: string; format_name?: string } };
  const ext = extname(path).toLowerCase();
  const v = j.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const isImage = IMAGE_EXT.has(ext) || (!!v && !a && (!j.format.duration || /image2|png_pipe|jpeg_pipe|webp_pipe/.test(j.format.format_name ?? '')));
  const fpsStr = v?.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v?.r_frame_rate ?? '30/1';
  const [n, d] = fpsStr.split('/').map(Number);
  const fps = d ? n / d : 30;
  const duration = isImage ? Infinity : Number(j.format.duration ?? v?.duration ?? 0);
  let needsProxy = false;
  if (isImage) needsProxy = !BROWSER_IMAGE.has(ext);
  else {
    if (v && (!BROWSER_VIDEO.has(v.codec_name) || /10le|12le|422|444/.test(v.pix_fmt ?? '') && v.codec_name === 'h264')) needsProxy = true;
    if (a && !BROWSER_AUDIO.has(a.codec_name)) needsProxy = true;
  }
  if (!v && !a) throw new Error('Desteklenmeyen dosya');
  return {
    path, name: basename(path), kind: isImage ? 'image' : v ? 'video' : 'audio', duration,
    fps: Number.isFinite(fps) && fps > 0 && fps < 1000 ? fps : 30,
    width: v?.width ?? 0, height: v?.height ?? 0, hasVideo: !!v, hasAudio: !!a,
    audioChannels: a?.channels ?? 0, sampleRate: Number(a?.sample_rate ?? 0), codec: v?.codec_name ?? a?.codec_name ?? '', needsProxy,
  };
}

// ------------------------------------------------------------------ assets

async function assets(path: string): Promise<MediaAssets> {
  const key = cacheKey(path);
  const metaFile = join(CACHE, `${key}.json`);
  if (existsSync(metaFile)) {
    try { return JSON.parse(readFileSync(metaFile, 'utf8')) as MediaAssets; } catch { /* rebuild */ }
  }
  const info = await probe(path);
  const out: MediaAssets = {};
  if (info.hasVideo && info.kind !== 'image') {
    const frames = Math.max(4, Math.min(60, Math.ceil(info.duration / 2)));
    const strip = join(CACHE, `${key}-strip.jpg`);
    const vf = `fps=${((frames + 1) / Math.max(info.duration, 0.1)).toFixed(6)},scale=-2:72,tile=${frames}x1`;
    // fast path decodes keyframes only; files with few keyframes can't fill the strip that way
    await run(FFMPEG, ['-v', 'error', '-y', '-skip_frame', 'nokey', '-i', path, '-vf', vf, '-frames:v', '1', '-q:v', '5', strip]).catch(() => undefined);
    if (!existsSync(strip)) {
      await run(FFMPEG, ['-v', 'error', '-y', '-i', path, '-vf', vf, '-frames:v', '1', '-q:v', '5', strip]).catch(() => undefined);
    }
    if (!existsSync(strip)) {
      // last resort: a single frame repeated
      await run(FFMPEG, ['-v', 'error', '-y', '-i', path, '-vf', `scale=-2:72,tile=${frames}x1`, '-frames:v', '1', '-q:v', '5', strip]).catch(() => undefined);
    }
    if (existsSync(strip)) { out.filmstrip = strip; out.filmstripFrames = frames; }
  }
  if (info.hasAudio) {
    const rate = 1000;
    const per = 20; // → 50 peaks per second
    const pcm = await run(FFMPEG, ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', `${rate}`, '-f', 's16le', '-']);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    const peaks: number[] = [];
    for (let i = 0; i < samples.length; i += per) {
      let m = 0;
      for (let k = i; k < Math.min(i + per, samples.length); k++) m = Math.max(m, Math.abs(samples[k]));
      peaks.push(Math.round((m / 32768) * 1000) / 1000);
    }
    out.peaks = peaks;
    out.peaksPerSecond = rate / per;
  }
  writeFileSync(metaFile, JSON.stringify(out));
  return out;
}

// ------------------------------------------------------------------ proxy

async function proxy(path: string, jobId: string): Promise<string> {
  const info = await probe(path);
  const key = cacheKey(path);
  if (info.kind === 'image') {
    const outImg = join(CACHE, `${key}-proxy.png`);
    if (!existsSync(outImg)) await run(FFMPEG, ['-v', 'error', '-y', '-i', path, '-frames:v', '1', '-vf', 'scale=min(1920\\,iw):-2', outImg]);
    return outImg;
  }
  const out = join(CACHE, `${key}-proxy.mp4`);
  if (existsSync(out)) return out;
  const tmp = out.replace('.mp4', '.part.mp4');
  const args = ['-v', 'error', '-y', '-nostdin', '-progress', 'pipe:1', '-i', path];
  if (info.hasVideo) args.push('-vf', 'scale=-2:min(540\\,ih),format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', '12', '-bf', '0');
  else args.push('-vn');
  if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  else args.push('-an');
  args.push('-movflags', '+faststart', tmp);
  await run(FFMPEG, args, {
    jobId,
    onStdout: (s) => {
      const m = /out_time_us=(\d+)/.exec(s);
      if (m && info.duration > 0) send({ id: jobId, progress: Math.min(0.99, Number(m[1]) / 1e6 / info.duration) });
    },
  });
  renameSync(tmp, out);
  return out;
}

// ------------------------------------------------------------------ audio envelope (multicam sync)

async function envelope(req: { path: string; rate: number; maxSec: number }, jobId: string): Promise<number[]> {
  const sr = 8000, hop = Math.round(sr / req.rate);
  const raw = await run(FFMPEG, ['-v', 'error', '-nostdin', '-t', String(req.maxSec), '-i', req.path, '-vn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-'], { jobId });
  const f = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const out: number[] = [];
  for (let i = 0; i + hop <= f.length; i += hop) { let s = 0; for (let j = i; j < i + hop; j++) s += f[j] * f[j]; out.push(Math.sqrt(s / hop)); }
  send({ id: jobId, progress: 1 });
  return out;
}

// ------------------------------------------------------------------ auto reframe

async function reframe(req: { path: string; range: [number, number]; perSecond: number; width: number; height: number }, jobId: string): Promise<ReframeSample[]> {
  const W = 96, H = Math.max(8, Math.round((96 * (req.height || 9)) / (req.width || 16) / 2) * 2);
  const len = Math.max(0.05, req.range[1] - req.range[0]);
  const raw = await run(FFMPEG, ['-v', 'error', '-nostdin', '-ss', String(req.range[0]), '-t', String(len), '-i', req.path, '-an', '-vf', `fps=${req.perSecond},scale=${W}:${H}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { jobId });
  const out: ReframeSample[] = [];
  let prev: Uint8Array | null = null;
  const fsz = W * H * 3;
  for (let o = 0, i = 0; o + fsz <= raw.length; o += fsz, i++) {
    const f = new Uint8Array(raw.buffer, raw.byteOffset + o, fsz);
    const s = saliency(f, W, H, prev);
    out.push({ t: req.range[0] + i / req.perSecond, x: s.x, y: s.y, w: s.weight });
    prev = f;
  }
  send({ id: jobId, progress: 1 });
  return out;
}

// ------------------------------------------------------------------ warp stabilizer

const stabRuns = new Map<string, Promise<string>>();

async function stabilize(req: StabilizeRequest, jobId: string): Promise<string> {
  const dir = join(CACHE, 'stab');
  mkdirSync(dir, { recursive: true });
  const h = createHash('sha1').update(`${req.key}|${cacheKey(req.path)}`).digest('hex').slice(0, 20);
  const out = join(dir, `${h}.mp4`);
  if (existsSync(out)) { send({ id: jobId, progress: 1 }); return out; }
  // the same request twice (e.g. undo/redo while it runs) shares one render
  const already = stabRuns.get(out);
  if (already) return already;
  const p = (async () => {
    // motion analysis depends only on the source range and analysis settings, so changing
    // smoothness / edges / zoom re-renders without analysing again
    const ah = createHash('sha1').update(`${cacheKey(req.path)}|${req.range[0].toFixed(3)}|${req.range[1].toFixed(3)}|${req.params.mode}|${req.params.detail}`).digest('hex').slice(0, 20);
    const trf = join(dir, `${ah}.trf`);
    const tmp = join(dir, `${h}.part.mp4`);
    const len = Math.max(0.001, req.range[1] - req.range[0]);
    const prog = (base: number, span: number) => (s: string) => {
      const m = /out_time_us=(\d+)/.exec(s);
      if (m) send({ id: jobId, progress: Math.min(0.99, base + span * Math.min(1, Number(m[1]) / 1e6 / len)) });
    };
    const analysed = existsSync(trf);
    if (!analysed) {
      await run(FFMPEG, detectArgs(req.path, req.range, trf + '.part', req.params), { jobId, onStdout: prog(0, 0.55) });
      renameSync(trf + '.part', trf);
    }
    await run(FFMPEG, transformArgs(req.path, req.range, trf, tmp, req.params, req.fps), { jobId, onStdout: analysed ? prog(0, 1) : prog(0.55, 0.45) });
    renameSync(tmp, out);
    return out;
  })();
  stabRuns.set(out, p);
  try { return await p; } finally { stabRuns.delete(out); }
}

// ------------------------------------------------------------------ export

/** bake each clip's grade to a .cube once (cached by content) */
function lutResolver(): (c: Clip) => string | null {
  return (c) => {
    if (!c.color || isNeutral(c.color)) return null;
    const userKey = c.color.lutPath ? `|${c.color.lutPath}` : '';
    const file = join(CACHE, `lut-${gradeKey(c.color)}${userKey ? createHash('sha1').update(userKey).digest('hex').slice(0, 6) : ''}.cube`);
    if (!existsSync(file)) {
      let user = null;
      if (c.color.lutPath && existsSync(c.color.lutPath)) user = parseCube(readFileSync(c.color.lutPath, 'utf8'));
      writeFileSync(file, toCube(bakeLut(c.color, 33, user)));
    }
    return file;
  };
}

async function exportSeq(req: ExportRequest, jobId: string): Promise<string> {
  const seq = req.project.sequences[req.sequenceId];
  if (!seq) throw new Error('Sekans bulunamadı');
  const plan = buildRenderPlan(req.project, seq, req.settings, (m) => m.path, lutResolver());
  // long graphs (speed ramps, masks, many transitions) go through a file: Windows limits command lines to 32 K
  const fi = plan.args.indexOf('-filter_complex');
  if (fi >= 0 && plan.args[fi + 1].length > 6000) {
    const script = join(CACHE, `graph-${jobId}.txt`);
    writeFileSync(script, plan.args[fi + 1], 'utf8');
    plan.args.splice(fi, 2, '-filter_complex_script', script);
  }
  await run(FFMPEG, plan.args, {
    jobId,
    onStdout: (s) => {
      const m = /out_time_us=(\d+)/.exec(s);
      if (m) send({ id: jobId, progress: Math.min(0.999, Number(m[1]) / 1e6 / plan.durationSec) });
    },
  });
  return req.settings.output;
}

// ------------------------------------------------------------------ single frame (export frame)

async function frame(payload: { path: string; time: number; out: string }): Promise<string> {
  await run(FFMPEG, ['-v', 'error', '-y', '-ss', `${payload.time}`, '-i', payload.path, '-frames:v', '1', payload.out]);
  return payload.out;
}

// ------------------------------------------------------------------ speech audio (for automatic captions)

async function speechAudio(req: { project: import('../core/model').Project; sequenceId: string; trackIds: string[] }, jobId: string): Promise<string> {
  const seq = req.project.sequences[req.sequenceId];
  if (!seq) throw new Error('Sekans bulunamadı');
  const out = join(CACHE, `speech-${createHash('sha1').update(jobId + Date.now()).digest('hex').slice(0, 10)}.wav`);
  const plan = buildRenderPlan(req.project, seq, {
    output: out, container: 'wav', videoCodec: 'none', audioCodec: 'pcm', rateControl: 'quality', quality: 20,
    videoBitrateKbps: 0, audioBitrateKbps: 0, range: 'all', hardware: 'none', preset: 'veryfast',
    audioSampleRate: 16000, audioChannels: 1, onlyAudioTracks: req.trackIds,
  });
  await run(FFMPEG, plan.args, {
    jobId,
    onStdout: (s) => {
      const m = /out_time_us=(\d+)/.exec(s);
      if (m) send({ id: jobId, progress: Math.min(0.999, Number(m[1]) / 1e6 / plan.durationSec) });
    },
  });
  return out;
}

// ------------------------------------------------------------------ dispatch

port.on('message', async ({ data }) => {
  const { id, type, payload } = data;
  try {
    let result: unknown;
    switch (type) {
      case 'probe': result = await probe(payload as string); break;
      case 'assets': result = await assets(payload as string); break;
      case 'proxy': result = await proxy(payload as string, id); break;
      case 'stabilize': result = await stabilize(payload as StabilizeRequest, id); break;
      case 'envelope': result = await envelope(payload as { path: string; rate: number; maxSec: number }, id); break;
      case 'reframe': result = await reframe(payload as { path: string; range: [number, number]; perSecond: number; width: number; height: number }, id); break;
      case 'export': result = await exportSeq(payload as ExportRequest, id); break;
      case 'frame': result = await frame(payload as { path: string; time: number; out: string }); break;
      case 'speechAudio': result = await speechAudio(payload as { project: import('../core/model').Project; sequenceId: string; trackIds: string[] }, id); break;
      case 'cancel': {
        const p = running.get(payload as string);
        if (p) p.kill('SIGKILL');
        result = true;
        break;
      }
    }
    send({ id, ok: true, result });
  } catch (e) {
    send({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
