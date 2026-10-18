// Turns a sequence into an ffmpeg command line. Pure: no fs, no spawn, so it
// is unit-tested and the same graph is used for export, preview renders and
// (later) proxies of nested sequences.

import { AnimatableParam, Clip, MediaItem, Project, Sequence, clipEnd, clipSrcSpan, sequenceDuration } from './model';

export type VideoCodec = 'h264' | 'hevc' | 'prores' | 'vp9' | 'gif' | 'none';
export type AudioCodec = 'aac' | 'mp3' | 'pcm' | 'opus' | 'none';

export interface ExportSettings {
  output: string;
  container: 'mp4' | 'mov' | 'webm' | 'gif' | 'wav' | 'mp3';
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  width?: number;
  height?: number;
  fps?: number;
  /** quality mode: CRF-style constant quality, or target bitrate */
  rateControl: 'quality' | 'bitrate';
  quality: number; // 0 best .. 51 worst for x264; mapped per codec
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  range: 'all' | 'inout';
  /** use the platform hardware encoder when available */
  hardware: 'none' | 'nvenc' | 'qsv' | 'amf' | 'videotoolbox';
  preset: 'ultrafast' | 'veryfast' | 'medium' | 'slow';
  /** burn subtitles from this .ass file (rendered by the caption engine) */
  burnSubtitles?: string;
  /** folder with the caption fonts, so the burn looks exactly like the preview */
  subtitlesFontsDir?: string;
  /** loudness normalize to this LUFS target, e.g. -14 for social */
  loudnessTarget?: number;
  /** override output audio format (e.g. 16 kHz mono for speech recognition) */
  audioSampleRate?: number;
  audioChannels?: number;
  /** only mix these audio tracks (others are treated as muted) */
  onlyAudioTracks?: string[];
}

export const defaultExport = (output: string): ExportSettings => ({
  output, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', rateControl: 'quality', quality: 20,
  videoBitrateKbps: 10000, audioBitrateKbps: 192, range: 'all', hardware: 'none', preset: 'veryfast',
});

export interface RenderPlan {
  args: string[];
  durationSec: number;
  inputs: number;
}

const r6 = (n: number) => Number(n.toFixed(6)).toString();

function paramExpr(p: AnimatableParam, clipStartSec: number, fps: number): string {
  // ffmpeg expression for a keyframed value over output time t
  if (!p.keyframes.length) return r6(p.value);
  const k = p.keyframes;
  const T = (f: number) => r6(clipStartSec + f / fps);
  let e = r6(k[k.length - 1].value);
  for (let i = k.length - 2; i >= 0; i--) {
    const a = k[i], b = k[i + 1];
    let lerp: string;
    if (a.ease === 'hold') lerp = r6(a.value);
    else {
      let tt = `((t-${T(a.frame)})/${r6((b.frame - a.frame) / fps)})`;
      if (a.ease === 'ease') tt = `(${tt}*${tt}*(3-2*${tt}))`;
      lerp = `(${r6(a.value)}+(${r6(b.value - a.value)})*${tt})`;
    }
    e = `if(lt(t,${T(b.frame)}),${lerp},${e})`;
  }
  return `if(lt(t,${T(k[0].frame)}),${r6(k[0].value)},${e})`;
}

function atempoChain(speed: number): string {
  // atempo accepts 0.5..100 per instance; chain for slower speeds
  const out: string[] = [];
  let s = Math.abs(speed);
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  while (s > 100) { out.push('atempo=100'); s /= 100; }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${r6(s)}`);
  return out.join(',');
}

function trackAudible(seq: Sequence, trackId: string): boolean {
  const t = seq.tracks.find((x) => x.id === trackId)!;
  const anySolo = seq.tracks.some((x) => x.kind === 'audio' && x.solo);
  if (anySolo) return t.solo && !t.muted;
  return !t.muted;
}

function trackVisible(seq: Sequence, trackId: string): boolean {
  return !seq.tracks.find((x) => x.id === trackId)!.muted;
}

/**
 * Build the ffmpeg arguments. `resolvePath` lets the caller swap originals for
 * proxies (preview renders) or relinked paths.
 */
export function buildRenderPlan(
  project: Project, seq: Sequence, settings: ExportSettings,
  resolvePath: (m: MediaItem) => string = (m) => m.path,
): RenderPlan {
  const fps = settings.fps ?? seq.fps;
  const W = even(settings.width ?? (settings.height ? settings.height * seq.width / seq.height : seq.width));
  const H = even(settings.height ?? (settings.width ? settings.width * seq.height / seq.width : seq.height));
  let from = 0;
  let to = sequenceDuration(seq);
  if (settings.range === 'inout') {
    from = seq.inPoint ?? 0;
    to = seq.outPoint ?? to;
  }
  if (to <= from) throw new Error('Nothing to export: the range is empty');
  const total = (to - from) / seq.fps;

  const args: string[] = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats'];
  const filters: string[] = [];
  let inputIndex = 0;

  const wantVideo = settings.videoCodec !== 'none' && !['wav', 'mp3'].includes(settings.container);
  const wantAudio = settings.audioCodec !== 'none' && settings.container !== 'gif';

  // which part of a clip falls inside [from,to)
  const visiblePart = (c: Clip) => {
    const a = Math.max(c.start, from);
    const b = Math.min(clipEnd(c), to);
    return b > a ? { a, b } : null;
  };

  const trackOrder = (kind: 'video' | 'audio') => seq.tracks.filter((t) => t.kind === kind).map((t) => t.id);

  // ---- video: canvas + one overlay per clip, bottom track first
  if (wantVideo) {
    filters.push(`color=c=black:s=${W}x${H}:r=${r6(fps)}:d=${r6(total)},format=yuva420p[base0]`);
    let last = 'base0';
    let n = 0;
    for (const trackId of trackOrder('video')) {
      if (!trackVisible(seq, trackId)) continue;
      const clips = Object.values(seq.clips)
        .filter((c) => c.trackId === trackId && c.stream === 'video' && c.enabled)
        .sort((x, y) => x.start - y.start);
      for (const c of clips) {
        const part = visiblePart(c);
        if (!part) continue;
        const m = project.media[c.mediaId];
        if (!m) continue;
        const headFrames = part.a - c.start;
        const lenSec = (part.b - part.a) / seq.fps;
        const outStart = (part.a - from) / seq.fps;
        const speed = Math.abs(c.speed);
        let srcStart: number;
        if (c.speed >= 0) srcStart = c.srcIn + (headFrames / seq.fps) * speed;
        else srcStart = c.srcIn + ((clipEnd(c) - part.b) / seq.fps) * speed;
        const srcLen = lenSec * speed;
        if (m.kind === 'image') {
          args.push('-loop', '1', '-framerate', r6(fps), '-t', r6(lenSec), '-i', resolvePath(m));
        } else {
          args.push('-ss', r6(Math.max(0, srcStart)), '-t', r6(srcLen + 1 / fps), '-i', resolvePath(m));
        }
        const i = inputIndex++;
        const chain: string[] = [];
        if (m.kind !== 'image') chain.push(`trim=duration=${r6(srcLen)}`);
        if (c.speed < 0 && m.kind !== 'image') chain.push('reverse');
        chain.push(`setpts=(PTS-STARTPTS)/${r6(m.kind === 'image' ? 1 : speed)}`);
        chain.push(`fps=${r6(fps)}`);
        // fit inside the frame (letterbox), like "scale to frame size"
        const tf = c.transform;
        const animated = [tf.scale, tf.posX, tf.posY, tf.opacity, tf.rotation].some((p) => p.keyframes.length);
        const clipStartOut = (c.start - from) / seq.fps;
        const sc = paramExpr(tf.scale, clipStartOut, seq.fps);
        const fitW = `trunc(min(${W}/iw\\,${H}/ih)*iw*(${sc})/100/2)*2`;
        const fitH = `trunc(min(${W}/iw\\,${H}/ih)*ih*(${sc})/100/2)*2`;
        chain.push(`scale=w='${fitW}':h='${fitH}'${animated ? ':eval=frame' : ''}`);
        chain.push('format=yuva420p');
        if (tf.rotation.value || tf.rotation.keyframes.length) {
          chain.push(`rotate=a='(${paramExpr(tf.rotation, clipStartOut, seq.fps)})*PI/180':c=none:ow=rotw(iw):oh=roth(ih)`);
        }
        if (tf.opacity.value !== 100 || tf.opacity.keyframes.length) {
          chain.push(`colorchannelmixer=aa=${tf.opacity.keyframes.length ? r6(tf.opacity.value / 100) : r6(tf.opacity.value / 100)}`);
        }
        chain.push(`setpts=PTS+${r6(outStart)}/TB`);
        filters.push(`[${i}:v]${chain.join(',')}[v${n}]`);
        const x = `(W-w)/2+(${paramExpr(tf.posX, clipStartOut, seq.fps)})`;
        const y = `(H-h)/2+(${paramExpr(tf.posY, clipStartOut, seq.fps)})`;
        const next = `ov${n}`;
        filters.push(`[${last}][v${n}]overlay=x='${x}':y='${y}':eof_action=pass:enable='between(t,${r6(outStart)},${r6(outStart + lenSec - 0.5 / fps)})'${animated ? ':eval=frame' : ''}[${next}]`);
        last = next;
        n++;
      }
    }
    let vout = last;
    if (settings.burnSubtitles) {
      const fonts = settings.subtitlesFontsDir ? `:fontsdir='${escapeFilterPath(settings.subtitlesFontsDir)}'` : '';
      filters.push(`[${vout}]format=yuv420p,subtitles='${escapeFilterPath(settings.burnSubtitles)}'${fonts}[subs]`);
      vout = 'subs';
    }
    const pixFmt = settings.videoCodec === 'prores' ? 'yuv422p10le' : settings.container === 'gif' ? 'rgb24' : 'yuv420p';
    filters.push(`[${vout}]format=${pixFmt}[vout]`);
  }

  // ---- audio: every audible clip delayed into place, then mixed
  if (wantAudio) {
    const labels: string[] = [];
    for (const trackId of trackOrder('audio')) {
      if (settings.onlyAudioTracks ? !settings.onlyAudioTracks.includes(trackId) : !trackAudible(seq, trackId)) continue;
      const track = seq.tracks.find((t) => t.id === trackId)!;
      const clips = Object.values(seq.clips).filter((c) => c.trackId === trackId && c.stream === 'audio' && c.enabled);
      for (const c of clips) {
        const part = visiblePart(c);
        const m = project.media[c.mediaId];
        if (!part || !m || !m.hasAudio) continue;
        const headFrames = part.a - c.start;
        const lenSec = (part.b - part.a) / seq.fps;
        const speed = Math.abs(c.speed);
        const srcStart = c.speed >= 0
          ? c.srcIn + (headFrames / seq.fps) * speed
          : c.srcIn + ((clipEnd(c) - part.b) / seq.fps) * speed;
        args.push('-ss', r6(Math.max(0, srcStart)), '-t', r6(lenSec * speed + 0.05), '-i', resolvePath(m));
        const i = inputIndex++;
        const delayMs = Math.round(((part.a - from) / seq.fps) * 1000);
        const chain = [`atrim=duration=${r6(lenSec * speed)}`, 'asetpts=PTS-STARTPTS'];
        if (c.speed < 0) chain.push('areverse');
        const tempo = atempoChain(speed);
        if (tempo) chain.push(tempo);
        chain.push(`aresample=${seq.sampleRate}`, 'aformat=channel_layouts=stereo');
        const gain = c.volumeDb.value + track.volumeDb;
        if (c.volumeDb.keyframes.length) {
          chain.push(`volume='pow(10,(${paramExpr(c.volumeDb, -headFrames / seq.fps, seq.fps)}+${r6(track.volumeDb)})/20)':eval=frame`);
        } else if (Math.abs(gain) > 1e-6) chain.push(`volume=${r6(gain)}dB`);
        chain.push(`adelay=${delayMs}|${delayMs}`);
        filters.push(`[${i}:a]${chain.join(',')}[a${labels.length}]`);
        labels.push(`a${labels.length}`);
      }
    }
    const silence = `anullsrc=r=${seq.sampleRate}:cl=stereo,atrim=duration=${r6(total)}[asil]`;
    filters.push(silence);
    labels.push('asil');
    const mix = labels.map((l) => `[${l}]`).join('');
    let post = `amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${r6(total)}`;
    if (settings.loudnessTarget !== undefined) post += `,loudnorm=I=${settings.loudnessTarget}:TP=-1.5:LRA=11`;
    filters.push(`${mix}${post}[aout]`);
  }

  args.push('-filter_complex', filters.join(';'));
  if (wantVideo) args.push('-map', '[vout]');
  if (wantAudio) args.push('-map', '[aout]');
  args.push(...videoCodecArgs(settings), ...audioCodecArgs(settings));
  if (wantAudio && settings.audioSampleRate) args.push('-ar', `${settings.audioSampleRate}`);
  if (wantAudio && settings.audioChannels) args.push('-ac', `${settings.audioChannels}`);
  if (wantVideo) args.push('-r', r6(fps));
  args.push('-t', r6(total));
  if (settings.container === 'mp4' || settings.container === 'mov') args.push('-movflags', '+faststart');
  args.push(settings.output);
  return { args, durationSec: total, inputs: inputIndex };
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function videoCodecArgs(s: ExportSettings): string[] {
  if (s.videoCodec === 'none' || ['wav', 'mp3'].includes(s.container)) return [];
  const q = Math.round(s.quality);
  const br = `${s.videoBitrateKbps}k`;
  switch (s.videoCodec) {
    case 'h264':
    case 'hevc': {
      const hevc = s.videoCodec === 'hevc';
      if (s.hardware === 'nvenc') return ['-c:v', hevc ? 'hevc_nvenc' : 'h264_nvenc', ...(s.rateControl === 'quality' ? ['-cq', `${q}`] : ['-b:v', br]), '-preset', 'p5'];
      if (s.hardware === 'qsv') return ['-c:v', hevc ? 'hevc_qsv' : 'h264_qsv', ...(s.rateControl === 'quality' ? ['-global_quality', `${q}`] : ['-b:v', br])];
      if (s.hardware === 'amf') return ['-c:v', hevc ? 'hevc_amf' : 'h264_amf', ...(s.rateControl === 'quality' ? ['-qp_i', `${q}`, '-qp_p', `${q}`] : ['-b:v', br])];
      if (s.hardware === 'videotoolbox') return ['-c:v', hevc ? 'hevc_videotoolbox' : 'h264_videotoolbox', '-b:v', br, ...(hevc ? ['-tag:v', 'hvc1'] : [])];
      return ['-c:v', hevc ? 'libx265' : 'libx264', '-preset', s.preset,
        ...(s.rateControl === 'quality' ? ['-crf', `${q}`] : ['-b:v', br, '-maxrate', br, '-bufsize', `${s.videoBitrateKbps * 2}k`]),
        ...(hevc ? ['-tag:v', 'hvc1'] : [])];
    }
    case 'prores': return ['-c:v', 'prores_ks', '-profile:v', '3'];
    case 'vp9': return ['-c:v', 'libvpx-vp9', '-row-mt', '1', ...(s.rateControl === 'quality' ? ['-crf', `${q + 10}`, '-b:v', '0'] : ['-b:v', br])];
    case 'gif': return ['-c:v', 'gif'];
  }
  return [];
}

function audioCodecArgs(s: ExportSettings): string[] {
  if (s.audioCodec === 'none' || s.container === 'gif') return [];
  const br = `${s.audioBitrateKbps}k`;
  switch (s.audioCodec) {
    case 'aac': return ['-c:a', 'aac', '-b:a', br];
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', br];
    case 'opus': return ['-c:a', 'libopus', '-b:a', br];
    case 'pcm': return ['-c:a', s.container === 'wav' ? 'pcm_s16le' : 'pcm_s24le'];
  }
  return [];
}

/** export presets shown in the Export screen */
export const EXPORT_PRESETS: { id: string; name: string; apply: Partial<ExportSettings> & { aspect?: [number, number] } }[] = [
  { id: 'match', name: 'Kaynakla eşleşir – Yüksek kalite (H.264)', apply: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', rateControl: 'quality', quality: 18 } },
  { id: 'match-small', name: 'Kaynakla eşleşir – Küçük dosya (H.264)', apply: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', rateControl: 'quality', quality: 26 } },
  { id: 'hevc', name: 'HEVC (H.265) – Yüksek kalite', apply: { container: 'mp4', videoCodec: 'hevc', audioCodec: 'aac', rateControl: 'quality', quality: 22 } },
  { id: 'instagram-reels', name: 'Instagram Reels / TikTok 1080×1920', apply: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: 1080, height: 1920, rateControl: 'bitrate', videoBitrateKbps: 12000, loudnessTarget: -14 } },
  { id: 'youtube-1080', name: 'YouTube 1080p', apply: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, rateControl: 'bitrate', videoBitrateKbps: 12000, loudnessTarget: -14 } },
  { id: 'youtube-4k', name: 'YouTube 4K', apply: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: 3840, height: 2160, rateControl: 'bitrate', videoBitrateKbps: 45000, loudnessTarget: -14 } },
  { id: 'prores', name: 'Master – ProRes 422 HQ (.mov)', apply: { container: 'mov', videoCodec: 'prores', audioCodec: 'pcm' } },
  { id: 'webm', name: 'Web – VP9 WebM', apply: { container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' } },
  { id: 'gif', name: 'Animasyonlu GIF', apply: { container: 'gif', videoCodec: 'gif', audioCodec: 'none', width: 480, fps: 15 } },
  { id: 'wav', name: 'Sadece ses – WAV', apply: { container: 'wav', videoCodec: 'none', audioCodec: 'pcm' } },
  { id: 'mp3', name: 'Sadece ses – MP3 320', apply: { container: 'mp3', videoCodec: 'none', audioCodec: 'mp3', audioBitrateKbps: 320 } },
];

export function srcSpanSec(c: Clip, fps: number): number {
  return clipSrcSpan(c, fps);
}
