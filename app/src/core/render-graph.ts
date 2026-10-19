// Turns a sequence into an ffmpeg command line. Pure: no fs, no spawn, so it
// is unit-tested and the same graph is used for export, preview renders and
// (later) proxies of nested sequences.

import { AnimatableParam, Clip, MediaItem, Project, Sequence, clipEnd, clipSrcSpan, sequenceDuration } from './model';
import { EFFECT_BY_ID, TRANSITION_BY_ID, motionOf, transitionWindows } from './fx';
import { IMPACT_BY_ID, impactFilters } from './impact';
import { stabilizedSource } from './stabilize';
import { hasRemap, remapAdvance } from './model';
import { maskImageFor } from './mask';
import { AUDIO_TRANSITIONS, audioFxChain } from './audiofx';

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
      else if (a.ease === 'out') tt = `(${tt}*${tt})`;
      else if (a.ease === 'in') tt = `(1-(1-${tt})*(1-${tt}))`;
      else if (a.ease === 'fast') tt = `(1-pow(1-${tt},4))`;
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
  /** baked .cube file for a graded clip (the worker writes them) */
  lutFor: (c: Clip) => string | null = () => null,
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

  // ---- video: canvas + one overlay per clip, bottom track first; transitions as xfade segments
  if (wantVideo) {
    filters.push(`color=c=black:s=${W}x${H}:r=${r6(fps)}:d=${r6(total)},format=yuva420p[base0]`);
    let last = 'base0';
    let n = 0;
    const F = seq.fps;
    const lbl = (p: string) => `${p}${n++}`;
    const srcAt = (c: Clip, f: number) => (c.speed >= 0
      ? c.srcIn + (hasRemap(c) ? remapAdvance(c, f - c.start, F) : ((f - c.start) / F) * Math.abs(c.speed))
      : c.srcIn + ((clipEnd(c) - f) / F) * Math.abs(c.speed));

    /**
     * Frames of clip `c` for timeline range [a,b), processed and scaled, with
     * timestamps starting at `tBase` seconds. Returns overlay labels/positions.
     * Frames outside the clip (transition handles) come from the media around
     * it, or repeat the first/last frame when the media runs out.
     */
    const layer = (c: Clip, a: number, b: number, tBase: number): { layers: { label: string; x: string; y: string; anim: boolean }[] } | null => {
      const m = project.media[c.mediaId];
      if (!m) return null;
      const lenOut = (b - a) / F;
      const speed = Math.abs(c.speed) || 1;
      const isImg = m.kind === 'image';
      // Warp Stabilizer: read the stabilised render instead of the original (same frames, shifted time base)
      const stab = stabilizedSource(c, m, F);
      const srcPath = stab ? stab.path : resolvePath(m);
      const off = stab ? stab.offset : 0;
      const D = stab ? stab.duration : Number.isFinite(m.duration) ? m.duration : Infinity;
      const i = inputIndex++;
      const chain: string[] = [];
      if (c.freeze !== undefined && !isImg) {
        // frame hold: one decoded frame, repeated
        const t = Math.max(0, Math.min(c.freeze - off, (Number.isFinite(D) ? D : c.freeze + 1) - 1 / F));
        args.push('-ss', r6(t), '-t', r6(2 / F + 0.1), '-i', srcPath);
        chain.push('trim=end_frame=1', 'setpts=PTS-STARTPTS', `fps=${r6(fps)}`, `tpad=stop_mode=clone:stop_duration=${r6(lenOut + 1 / fps)}`, `trim=duration=${r6(lenOut)}`);
      } else if (isImg) {
        args.push('-loop', '1', '-framerate', r6(fps), '-t', r6(lenOut + 1 / fps), '-i', srcPath);
        chain.push(`trim=duration=${r6(lenOut)}`, 'setpts=PTS-STARTPTS', `fps=${r6(fps)}`);
      } else {
        const sa = srcAt(c, a) - off, sb = srcAt(c, b) - off;
        const s0 = Math.min(sa, sb), s1 = Math.max(sa, sb);
        const lo = Math.max(0, s0), hi = Math.min(D - 0.001, s1);
        const missingHead = Math.max(0, lo - s0), missingTail = Math.max(0, s1 - hi);
        const srcLen = Math.max(1 / F, hi - lo);
        args.push('-ss', r6(lo), '-t', r6(srcLen + 1 / fps), '-i', srcPath);
        chain.push(`trim=duration=${r6(srcLen)}`);
        if (c.speed < 0) chain.push('reverse');
        let padStart = (c.speed < 0 ? missingTail : missingHead) / speed;
        let padEnd = (c.speed < 0 ? missingHead : missingTail) / speed;
        if (hasRemap(c)) {
          // speed ramp: map each source time to its output time (piecewise linear every 2 frames)
          const xs: number[] = [], ys: number[] = [];
          const f0 = a - c.start, f1 = b - c.start;
          for (let f = f0; ; f = Math.min(f1, f + 2)) {
            xs.push(srcAt(c, c.start + f) - off - lo); ys.push((f - f0) / F);
            if (f >= f1) break;
          }
          chain.push('setpts=PTS-STARTPTS', `setpts='(${pwl(xs, ys, 'T')})/TB'`, `fps=${r6(fps)}`);
          // the source ran out before the clip ends (ramp sped past the media): hold the last frame
          const covered = xs.findIndex((x) => x > hi - lo - 1e-6);
          padStart = 0;
          padEnd = covered > 0 ? Math.max(0, ys[ys.length - 1] - ys[covered]) : 0;
        } else chain.push(`setpts=(PTS-STARTPTS)/${r6(speed)}`, `fps=${r6(fps)}`);
        // output-order padding (reverse swaps head and tail)
        if (padStart > 0.5 / F || padEnd > 0.5 / F) chain.push(`tpad=start_duration=${r6(padStart)}:start_mode=clone:stop_duration=${r6(padEnd)}:stop_mode=clone`);
      }
      const lut = lutFor(c);
      if (lut) chain.push(`format=rgb24,lut3d=file='${escapeFilterPath(lut)}':interp=tetrahedral`);
      if (c.color && c.color.vignette < 0) chain.push(`vignette=angle=${r6((Math.PI / 5) * Math.min(1, -c.color.vignette / 60))}:mode=forward`);
      const sw = m.width || W, sh = m.height || H;
      let blurfill: Record<string, number> | null = null;
      let maskedFrom: string | null = null;
      for (const e of c.effects ?? []) {
        if (!e.enabled) continue;
        const def = EFFECT_BY_ID[e.type];
        if (!def) continue;
        if (def.kind === 'blurfill') { blurfill = e.params; continue; }
        if (def.kind === 'motion' || def.kind === 'stabilize') continue;
        const fstr = def.ffmpeg(e.params, { fps, W, H, sw, sh });
        if (fstr && fstr !== 'null') chain.push(fstr);
      }
      chain.push(`setpts=PTS+${r6(tBase)}/TB`);
      // opacity masks: multiply the clip's alpha with the rasterised mask image
      const maskPath = maskImageFor(c, sw, sh);
      if (maskPath) {
        args.push('-loop', '1', '-framerate', r6(fps), '-t', r6(lenOut + 2 / fps), '-i', maskPath);
        const j = inputIndex++;
        const [mk, mc, c1, c2, ca, am, mo] = ['mk', 'mc', 'mc', 'mc', 'ma', 'mm', 'mo'].map(lbl);
        filters.push(`[${j}:v]format=gray,scale=${sw}:${sh},setpts=PTS-STARTPTS+${r6(tBase)}/TB[${mk}]`);
        filters.push(`[${i}:v]${chain.join(',')},format=yuva420p[${mc}]`);
        filters.push(`[${mc}]split[${c1}][${c2}]`);
        filters.push(`[${c2}]alphaextract[${ca}]`);
        filters.push(`[${ca}][${mk}]blend=all_mode=multiply:shortest=1[${am}]`);
        filters.push(`[${c1}][${am}]alphamerge[${mo}]`);
        chain.length = 0;
        chain.push('null');
        maskedFrom = mo;
      }
      const src = lbl('src');
      const layers: { label: string; x: string; y: string; anim: boolean }[] = [];
      let fgIn = src;
      if (blurfill) {
        const bg = lbl('bg'), fg = lbl('fg');
        filters.push(`[${maskedFrom ?? `${i}:v`}]${chain.join(',')},split[${fg}][${bg}in]`);
        filters.push(`[${bg}in]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=${r6((blurfill.blur / 100) * H)},eq=brightness=${r6(-(blurfill.dim / 100) * 0.5)},format=yuva420p[${bg}]`);
        layers.push({ label: bg, x: '0', y: '0', anim: false });
        fgIn = fg;
      } else {
        filters.push(`[${maskedFrom ?? `${i}:v`}]${chain.join(',')}[${src}]`);
      }
      // scale / rotate / opacity, expressions in output time t; L = frame index inside the clip
      const tf = c.transform;
      const cs = tBase - (a - c.start) / F;
      const mo = motionOf(c.effects, H, F);
      const Lexpr = `((t-${r6(cs)})*${r6(F)})`;
      const withL = (e: string) => e.replace(/\bL\b/g, Lexpr);
      const anim = !!mo || [tf.scale, tf.posX, tf.posY, tf.opacity, tf.rotation].some((p) => p.keyframes.length);
      const sc = `(${paramExpr(tf.scale, cs, F)})${mo ? `*(${withL(mo.scale)})` : ''}`;
      const fitW = `trunc(min(${W}/iw\\,${H}/ih)*iw*(${sc})/100/2)*2`;
      const fitH = `trunc(min(${W}/iw\\,${H}/ih)*ih*(${sc})/100/2)*2`;
      const post: string[] = [`scale=w='${fitW}':h='${fitH}'${anim ? ':eval=frame' : ''}`, 'format=yuva420p'];
      if (tf.rotation.value || tf.rotation.keyframes.length) post.push(`rotate=a='(${paramExpr(tf.rotation, cs, F)})*PI/180':c=none:ow=rotw(iw):oh=roth(ih)`);
      const op = tf.opacity.keyframes.length ? null : tf.opacity.value;
      if (op !== null && op !== 100) post.push(`colorchannelmixer=aa=${r6(op / 100)}`);
      if (tf.opacity.keyframes.length) post.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip((${paramExpr(tf.opacity, cs, F).replace(/\bt\b/g, 'T')})/100,0,1)'`);
      const out = lbl('v');
      filters.push(`[${fgIn}]${post.join(',')}[${out}]`);
      const x = `(W-w)/2+(${paramExpr(tf.posX, cs, F)})${mo ? `+(${withL(mo.dx)})` : ''}`;
      const y = `(H-h)/2+(${paramExpr(tf.posY, cs, F)})${mo ? `+(${withL(mo.dy)})` : ''}`;
      layers.push({ label: out, x, y, anim });
      return { layers };
    };

    const overlayAll = (base: string, layers: { label: string; x: string; y: string; anim: boolean }[], enable: string | null): string => {
      let cur = base;
      for (const l of layers) {
        const o = lbl('ov');
        filters.push(`[${cur}][${l.label}]overlay=x='${l.x}':y='${l.y}':eof_action=pass${enable ? `:enable='${enable}'` : ''}${l.anim ? ':eval=frame' : ''}[${o}]`);
        cur = o;
      }
      return cur;
    };

    for (const trackId of trackOrder('video')) {
      if (!trackVisible(seq, trackId)) continue;
      const clips = Object.values(seq.clips)
        .filter((c) => c.trackId === trackId && c.stream === 'video' && c.enabled)
        .sort((x, y) => x.start - y.start);
      const { windows: wins, cutStart, cutEnd } = transitionWindows(clips);
      const windows = wins.map((w) => ({ ...w, impact: IMPACT_BY_ID[w.type], type: TRANSITION_BY_ID[w.type]?.xfade ?? 'fade' }));
      for (const c of clips) {
        const a = Math.max(c.start, from, cutStart.get(c.id) ?? -Infinity);
        const b = Math.min(clipEnd(c), to, cutEnd.get(c.id) ?? Infinity);
        if (b <= a) continue;
        const cm = project.media[c.mediaId];
        if (cm?.synthetic?.type === 'adjustment') {
          // adjustment layer: grade / effects / motion applied to the composite below, inside its window
          const ta = (a - from) / F, len = (b - a) / F;
          const chain: string[] = [`trim=start=${r6(ta)}:end=${r6(ta + len)}`, 'setpts=PTS-STARTPTS'];
          const lut = lutFor(c);
          if (lut) chain.push(`format=rgb24,lut3d=file='${escapeFilterPath(lut)}':interp=tetrahedral`);
          if (c.color && c.color.vignette < 0) chain.push(`vignette=angle=${r6((Math.PI / 5) * Math.min(1, -c.color.vignette / 60))}:mode=forward`);
          for (const e of c.effects ?? []) {
            const def = e.enabled ? EFFECT_BY_ID[e.type] : undefined;
            if (!def || def.kind) continue;
            const fstr = def.ffmpeg(e.params, { fps, W, H, sw: W, sh: H });
            if (fstr && fstr !== 'null') chain.push(fstr);
          }
          chain.push('format=yuva420p');
          const mo = motionOf(c.effects, H, F);
          const cs = -(a - c.start) / F;
          const Lexpr = `((t-${r6(cs)})*${r6(F)})`;
          const withL = (e: string) => e.replace(/\bL\b/g, Lexpr);
          if (mo) chain.push(`scale=w='trunc(${W}*(${withL(mo.scale)})/2)*2':h='trunc(${H}*(${withL(mo.scale)})/2)*2':eval=frame`);
          const op = c.transform.opacity.value;
          if (op < 100) chain.push(`colorchannelmixer=aa=${r6(op / 100)}`);
          chain.push(`setpts=PTS+${r6(ta)}/TB`);
          const [x1, x2, adj] = ['ab', 'ab', 'aj'].map(lbl);
          filters.push(`[${last}]split[${x1}][${x2}]`);
          filters.push(`[${x2}]${chain.join(',')}[${adj}]`);
          const lx = mo ? `(W-w)/2+(${withL(mo.dx).replace(/\bt\b/g, `(t-${r6(ta)})`)})` : '0';
          const ly = mo ? `(H-h)/2+(${withL(mo.dy).replace(/\bt\b/g, `(t-${r6(ta)})`)})` : '0';
          last = overlayAll(x1, [{ label: adj, x: lx, y: ly, anim: !!mo }], `between(t,${r6(ta)},${r6(ta + len - 0.5 / fps)})`);
          continue;
        }
        if (c.blend && c.blend !== 'normal') {
          // blend modes: mix the clip with what is below it, only inside its window
          const L = layer(c, a, b, 0);
          if (!L) continue;
          const ta = (a - from) / F, len = (b - a) / F;
          const cv = lbl('bcv');
          filters.push(`color=c=black@0:s=${W}x${H}:r=${r6(fps)}:d=${r6(len)},format=yuva420p[${cv}]`);
          const full = overlayAll(cv, L.layers, null);
          const [b1, b2, f1, f2, bw, fg, bl, fa, bm] = ['bb', 'bb', 'bf', 'bf', 'bw', 'bg', 'bl', 'ba', 'bm'].map(lbl);
          filters.push(`[${last}]split[${b1}][${b2}]`);
          filters.push(`[${b2}]trim=start=${r6(ta)}:end=${r6(ta + len)},setpts=PTS-STARTPTS,format=gbrp[${bw}]`);
          filters.push(`[${full}]split[${f1}][${f2}]`);
          filters.push(`[${f1}]format=gbrp[${fg}]`);
          filters.push(`[${fg}][${bw}]${blendFilter(c.blend)}[${bl}]`);
          filters.push(`[${f2}]alphaextract[${fa}]`);
          filters.push(`[${bl}][${fa}]alphamerge,format=yuva420p,setpts=PTS+${r6(ta)}/TB[${bm}]`);
          last = overlayAll(b1, [{ label: bm, x: '0', y: '0', anim: false }], `between(t,${r6(ta)},${r6(ta + len - 0.5 / fps)})`);
          continue;
        }
        const L = layer(c, a, b, (a - from) / F);
        if (!L) continue;
        last = overlayAll(last, L.layers, `between(t,${r6((a - from) / F)},${r6((b - from) / F - 0.5 / fps)})`);
      }
      for (const w of windows) {
        const a = Math.max(w.a, from), b = Math.min(w.b, to);
        if (b <= a) continue;
        const len = (w.b - w.a) / F;
        const canvas = (name: string) => { filters.push(`color=c=black@0:s=${W}x${H}:r=${r6(fps)}:d=${r6(len)},format=yuva420p[${name}]`); return name; };
        const seg = (c: Clip | null) => {
          const cv = canvas(lbl('cv'));
          if (!c) return cv;
          const L = layer(c, w.a, w.b, 0);
          return L ? overlayAll(cv, L.layers, null) : cv;
        };
        const sa = seg(w.A), sb = seg(w.B);
        const x = lbl('x');
        let tail = '';
        if (a > w.a) tail += `,trim=start=${r6((a - w.a) / F)}`;
        tail += `,setpts=PTS-STARTPTS+${r6((a - from) / F)}/TB`;
        if (w.impact) {
          const im = impactFilters(w.impact, sa, sb, W, H, fps, Math.max(2, Math.round(len * fps)), lbl);
          filters.push(...im.filters);
          filters.push(`[${im.out}]null${tail}[${x}]`);
        } else {
          filters.push(`[${sa}][${sb}]xfade=transition=${w.type}:duration=${r6(len)}:offset=0${tail}[${x}]`);
        }
        last = overlayAll(last, [{ label: x, x: '0', y: '0', anim: false }], `between(t,${r6((a - from) / F)},${r6((b - from) / F - 0.5 / fps)})`);
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

  // ---- audio: every audible clip delayed into place (with crossfades and effects), then mixed
  if (wantAudio) {
    const labels: string[] = [];
    const F = seq.fps;
    for (const trackId of trackOrder('audio')) {
      if (settings.onlyAudioTracks ? !settings.onlyAudioTracks.includes(trackId) : !trackAudible(seq, trackId)) continue;
      const track = seq.tracks.find((t) => t.id === trackId)!;
      const clips = Object.values(seq.clips).filter((c) => c.trackId === trackId && c.stream === 'audio' && c.enabled).sort((x, y) => x.start - y.start);
      // crossfades: A keeps playing past the cut and fades out while B fades in
      const segs = new Map<string, { a: number; b: number; fin?: { at: number; d: number; curve: string }; fout?: { at: number; d: number; curve: string } }>();
      for (const c of clips) segs.set(c.id, { a: c.start, b: clipEnd(c) });
      const curveOf = (t: string) => AUDIO_TRANSITIONS.find((x) => x.id === t)?.curve ?? 'qsin';
      // tails with nothing after them: fade out to silence
      for (const A of clips) {
        const tr = A.transOut;
        if (!tr || tr.duration < 2 || clips.some((x) => x.start === clipEnd(A) && x.id !== A.id)) continue;
        const d = Math.min(tr.duration, A.duration);
        segs.get(A.id)!.fout = { at: clipEnd(A) - d, d, curve: curveOf(tr.type) };
      }
      for (const B of clips) {
        const A = clips.find((x) => clipEnd(x) === B.start && x.id !== B.id);
        const tr = B.transIn ?? A?.transOut;
        if (!tr || tr.duration < 2) continue;
        const curve = curveOf(tr.type);
        const sb = segs.get(B.id)!;
        if (A) {
          const d = Math.min(tr.duration, A.duration + B.duration - 2);
          const half = Math.floor(d / 2);
          const wa = B.start - half, wb = wa + d;
          sb.a = wa; sb.fin = { at: wa, d, curve };
          const sa = segs.get(A.id)!;
          sa.b = wb; sa.fout = { at: wa, d, curve };
        } else {
          const d = Math.min(tr.duration, B.duration);
          sb.fin = { at: B.start, d, curve };
        }
      }
      for (const c of clips) {
        const m = project.media[c.mediaId];
        const sg = segs.get(c.id)!;
        const a = Math.max(sg.a, from), b = Math.min(sg.b, to);
        if (b <= a || !m || !m.hasAudio || c.freeze !== undefined) continue;
        const speed = Math.abs(c.speed) || 1;
        const lenSec = (b - a) / F;
        // source window (may reach outside the clip for crossfades); clamp to the media
        const srcAtF = (f: number) => (c.speed >= 0 ? c.srcIn + ((f - c.start) / F) * speed : c.srcIn + ((clipEnd(c) - f) / F) * speed);
        const s0 = Math.min(srcAtF(a), srcAtF(b));
        const lo = Math.max(0, s0);
        const lead = (lo - s0) / speed; // seconds of silence before the media starts
        const srcLen = Math.max(0.01, lenSec * speed - (lo - s0));
        args.push('-ss', r6(lo), '-t', r6(srcLen + 0.05), '-i', resolvePath(m));
        const i = inputIndex++;
        const delayMs = Math.max(0, Math.round(((a - from) / F + lead) * 1000));
        const chain = [`atrim=duration=${r6(srcLen)}`, 'asetpts=PTS-STARTPTS'];
        if (c.speed < 0) chain.push('areverse');
        const tempo = atempoChain(speed);
        if (tempo) chain.push(tempo);
        chain.push(`aresample=${seq.sampleRate}`, 'aformat=channel_layouts=stereo');
        chain.push(...audioFxChain(c.audioFx, seq.sampleRate));
        const headFrames = a - c.start;
        const gain = c.volumeDb.value + track.volumeDb;
        if (c.volumeDb.keyframes.length) {
          chain.push(`volume='pow(10,(${paramExpr(c.volumeDb, -(headFrames / F) + lead, F)}+${r6(track.volumeDb)})/20)':eval=frame`);
        } else if (Math.abs(gain) > 1e-6) chain.push(`volume=${r6(gain)}dB`);
        // fades in segment-local time (t=0 at frame a, after the lead)
        const local = (f: number) => (f - a) / F - lead;
        if (sg.fin) chain.push(`afade=t=in:st=${r6(Math.max(0, local(sg.fin.at)))}:d=${r6(sg.fin.d / F)}:curve=${sg.fin.curve}`);
        if (sg.fout) chain.push(`afade=t=out:st=${r6(Math.max(0, local(sg.fout.at)))}:d=${r6(sg.fout.d / F)}:curve=${sg.fout.curve}`);
        const pan = track.pan ?? 0;
        if (pan) {
          const th = ((pan / 100 + 1) * Math.PI) / 4;
          chain.push(`pan=stereo|c0=${r6(Math.cos(th) * Math.SQRT2)}*c0|c1=${r6(Math.sin(th) * Math.SQRT2)}*c1`);
        }
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

/**
 * ffmpeg blend for a canvas/W3C blend mode, inputs [top][bottom] in gbrp.
 * ffmpeg's 'overlay'/'hardlight' are each other's W3C counterpart; soft light
 * uses the W3C formula directly so preview and export match.
 */
export function blendFilter(mode: import('./model').BlendMode): string {
  const m: Record<string, string> = {
    multiply: 'multiply', screen: 'screen', overlay: 'hardlight', 'hard-light': 'overlay', darken: 'darken', lighten: 'lighten',
    'color-dodge': 'dodge', 'color-burn': 'burn', difference: 'difference', exclusion: 'exclusion', add: 'addition',
  };
  if (mode === 'soft-light') {
    const b = '(B/255)', s = '(A/255)';
    const d = `if(lte(${b},0.25),((16*${b}-12)*${b}+4)*${b},sqrt(${b}))`;
    return `blend=all_expr='255*clip(if(lte(${s},0.5),${b}-(1-2*${s})*${b}*(1-${b}),${b}+(2*${s}-1)*(${d}-${b})),0,1)'`;
  }
  return `blend=all_mode=${m[mode] ?? 'normal'}`;
}

/** piecewise-linear interpolation through (xs, ys) as an ffmpeg expression of v (balanced, shallow) */
function pwl(xs: number[], ys: number[], v: string): string {
  if (xs.length === 1) return r6(ys[0]);
  const lin = (i: number) => {
    const dx = xs[i + 1] - xs[i];
    const k = dx > 1e-9 ? (ys[i + 1] - ys[i]) / dx : 0;
    return `(${r6(ys[i])}+(${v}-${r6(xs[i])})*${r6(k)})`;
  };
  const seg = (i: number, j: number): string => {
    if (j - i <= 1) return lin(i);
    const mid = (i + j) >> 1;
    return `if(lt(${v},${r6(xs[mid])}),${seg(i, mid)},${seg(mid, j)})`;
  };
  return seg(0, xs.length - 1);
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
