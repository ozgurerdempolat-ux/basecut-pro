// Program monitor playback engine. Composites the sequence onto a canvas in
// real time using the browser's (hardware) video decoders, one element per
// visible clip. Audio clips play through their own media elements routed into
// a WebAudio graph for gain above 0 dB and metering.

import { Clip, MediaItem, Sequence, clipEnd, evalParam, sequenceDuration, sourceTimeAt } from '../core/model';
import { activeSeq, committedSeq, playbackPath, setPlayhead, useStore } from './store';
import { drawCaptions } from './Captions';
import { grader } from './grader';
import { isNeutral } from '../core/color';
import { EFFECT_BY_ID, motionAt, transitionWindows } from '../core/fx';
import { IMPACT_BY_ID } from '../core/impact';
import { applyEffects, drawBlurFill, drawTransition, release, tmpCanvas } from './fxPreview';
import { AUDIO_FX_BY_ID, AUDIO_TRANSITIONS, PreviewNode, fadeGain } from '../core/audiofx';

type Visual = { el: HTMLVideoElement | HTMLImageElement; path: string; ready: boolean };
type Sound = { el: HTMLMediaElement; path: string; gain: GainNode | null; src: MediaElementAudioSourceNode | null; fxKey: string; fxNodes: AudioNode[]; track: string };
type Strip = { gain: GainNode; pan: StereoPannerNode; meter: AnalyserNode };

class Player {
  canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private visuals = new Map<string, Visual>();
  private sounds = new Map<string, Sound>();
  private strips = new Map<string, Strip>();
  private raf = 0;
  private dirty = true;
  private t0 = 0;
  private f0 = 0;
  private audio: AudioContext | null = null;
  private master: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  /** frames actually drawn per second, shown as a dropped-frame indicator */
  fpsMeter = { drawn: 0, last: 0, value: 0 };
  onFrame: ((f: number) => void) | null = null;
  private lastFrame = -1;
  stopAt: number | null = null;

  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.dirty = true;
    if (!this.raf) this.loop();
  }

  invalidate() { this.dirty = true; }

  private ensureAudio() {
    if (this.audio) return;
    try {
      this.audio = new AudioContext({ latencyHint: 'playback' });
      this.master = this.audio.createGain();
      this.analyser = this.audio.createAnalyser();
      this.analyser.fftSize = 1024;
      this.master.connect(this.analyser);
      this.analyser.connect(this.audio.destination);
    } catch { this.audio = null; }
  }

  play(rate = 1) {
    const st = useStore.getState();
    const seq = committedSeq(st);
    this.ensureAudio();
    void this.audio?.resume();
    let f = seq.playhead;
    const end = sequenceDuration(seq);
    if (rate > 0 && f >= end - 1) f = 0;
    this.f0 = f;
    this.t0 = performance.now();
    useStore.setState({ playing: true, rate });
    this.dirty = true;
  }

  pause() {
    if (!useStore.getState().playing) return;
    useStore.setState({ playing: false, rate: 1 });
    for (const v of this.visuals.values()) if (v.el instanceof HTMLVideoElement) v.el.pause();
    for (const s of this.sounds.values()) s.el.pause();
    this.stopAt = null;
    this.dirty = true;
  }

  toggle() { useStore.getState().playing ? this.pause() : this.play(1); }

  /** J / K / L shuttle: repeated presses speed up */
  shuttle(dir: -1 | 0 | 1) {
    const st = useStore.getState();
    if (dir === 0) { this.pause(); return; }
    let rate = dir;
    if (st.playing && Math.sign(st.rate) === dir) rate = Math.min(8, Math.abs(st.rate) * 2) * dir;
    if (st.playing) { this.f0 = committedSeq(st).playhead; this.t0 = performance.now(); }
    this.play(rate);
  }

  private currentFrame(seq: Sequence): number {
    const st = useStore.getState();
    if (!st.playing) return seq.playhead;
    const f = this.f0 + ((performance.now() - this.t0) / 1000) * seq.fps * st.rate;
    return f;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const st = useStore.getState();
    const seq = activeSeq(st);
    if (!seq || !this.ctx || !this.canvas) return;
    let f = this.currentFrame(seq);
    if (st.playing) {
      const end = sequenceDuration(seq);
      const stop = this.stopAt ?? (st.rate > 0 ? end : 0);
      if ((st.rate > 0 && f >= stop) || (st.rate < 0 && f <= 0)) {
        f = st.rate > 0 ? Math.max(0, stop - 1) : 0;
        setPlayhead(f);
        this.pause();
      } else {
        const whole = Math.floor(f);
        if (whole !== committedSeq(st).playhead) setPlayhead(whole);
      }
    }
    const frame = Math.floor(f);
    if (!this.dirty && !st.playing && frame === this.lastFrame) return;
    this.dirty = false;
    this.lastFrame = frame;
    this.render(seq, frame, st.playing, st.rate);
    this.syncAudio(seq, f, st.playing, st.rate);
    this.onFrame?.(frame);
    const now = performance.now();
    this.fpsMeter.drawn++;
    if (now - this.fpsMeter.last > 1000) { this.fpsMeter.value = this.fpsMeter.drawn; this.fpsMeter.drawn = 0; this.fpsMeter.last = now; }
  };

  private visualFor(c: Clip, m: MediaItem): Visual | null {
    const path = playbackPath(m);
    if (!path || !m.online) return null;
    let v = this.visuals.get(c.id);
    if (v && v.path !== path) { this.dispose(c.id); v = undefined; }
    if (!v) {
      if (m.kind === 'image') {
        const img = new Image();
        img.crossOrigin = 'anonymous'; // media comes from kmedia://; keep the canvas exportable (Export Frame)
        img.decoding = 'async';
        img.src = window.kurgu.mediaUrl(path);
        v = { el: img, path, ready: false };
        img.onload = () => { v!.ready = true; this.dirty = true; };
      } else {
        const el = document.createElement('video');
        el.crossOrigin = 'anonymous';
        el.muted = true;
        el.preload = 'auto';
        el.playsInline = true;
        el.src = window.kurgu.mediaUrl(path);
        v = { el, path, ready: false };
        const vv = v;
        el.addEventListener('loadeddata', () => { vv.ready = true; this.dirty = true; });
        el.addEventListener('seeked', () => { this.dirty = true; });
      }
      this.visuals.set(c.id, v);
    }
    return v;
  }

  private dispose(id: string) {
    const v = this.visuals.get(id);
    if (v) {
      if (v.el instanceof HTMLVideoElement) { v.el.pause(); v.el.removeAttribute('src'); v.el.load(); }
      this.visuals.delete(id);
    }
    const s = this.sounds.get(id);
    if (s) {
      s.el.pause(); s.el.removeAttribute('src'); s.el.load();
      try { s.src?.disconnect(); s.gain?.disconnect(); for (const n of s.fxNodes) n.disconnect(); } catch { /* */ }
      this.sounds.delete(id);
    }
  }

  private render(seq: Sequence, frame: number, playing: boolean, rate: number) {
    const st = useStore.getState();
    const canvas = this.canvas!;
    const ctx = this.ctx!;
    const res = st.playbackRes;
    const W = Math.max(2, Math.round(seq.width * res));
    const H = Math.max(2, Math.round(seq.height * res));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const media = st.project.media;
    const live = new Set<string>();
    const lookahead = playing ? Math.round(seq.fps * 1.5 * Math.abs(rate)) : 0;
    for (const t of seq.tracks.filter((x) => x.kind === 'video')) {
      if (t.muted) continue;
      const clips = Object.values(seq.clips).filter((c) => c.trackId === t.id && c.stream === 'video' && c.enabled).sort((a, b) => a.start - b.start);
      const { windows, cutStart, cutEnd } = transitionWindows(clips);
      for (const c of clips) {
        const a = Math.max(c.start, cutStart.get(c.id) ?? -Infinity);
        const b = Math.min(clipEnd(c), cutEnd.get(c.id) ?? Infinity);
        const inside = frame >= a && frame < b;
        const soon = lookahead && c.start > frame && c.start - frame < lookahead;
        const inWin = windows.some((w) => (w.A?.id === c.id || w.B?.id === c.id) && frame >= w.a - lookahead && frame < w.b);
        if (!inside && !soon && !inWin) continue;
        const m = media[c.mediaId];
        if (!m) continue;
        live.add(c.id);
        if (inside) this.drawClipAt(ctx, c, m, frame, W, H, seq, res, playing, rate);
        else if (soon) this.preroll(c, m, seq);
      }
      const w = windows.find((x) => frame >= x.a && frame < x.b);
      if (w) {
        const tA = tmpCanvas(W, H), tB = tmpCanvas(W, H);
        const ca = tA.getContext('2d')!, cb = tB.getContext('2d')!;
        ca.clearRect(0, 0, W, H); cb.clearRect(0, 0, W, H);
        if (w.A && media[w.A.mediaId]) this.drawClipAt(ca, w.A, media[w.A.mediaId], frame, W, H, seq, res, playing, rate);
        if (w.B && media[w.B.mediaId]) this.drawClipAt(cb, w.B, media[w.B.mediaId], frame, W, H, seq, res, playing, rate);
        const n = w.b - w.a;
        // impact transitions are keyed to frames like ffmpeg (p = i/(n-1)); classic ones to the xfade progress
        drawTransition(ctx, tA, tB, w.type, IMPACT_BY_ID[w.type] ? (frame - w.a) / Math.max(1, n - 1) : (frame - w.a) / Math.max(1, n), n);
        release(tA); release(tB);
      }
    }
    for (const id of this.visuals.keys()) if (!live.has(id)) this.dispose(id);
    drawCaptions(ctx, seq, frame, W, H);
  }

  /** source time for a timeline frame, also outside the clip (transition handles), clamped to the media */
  private srcTime(c: Clip, m: MediaItem, f: number, fps: number): number {
    const sp = Math.abs(c.speed) || 1;
    let s = c.speed >= 0 ? c.srcIn + ((f - c.start) / fps) * sp : c.srcIn + ((clipEnd(c) - f) / fps) * sp;
    if (Number.isFinite(m.duration)) s = Math.min(m.duration - 0.02, s);
    return Math.max(0, s);
  }

  private preroll(c: Clip, m: MediaItem, seq: Sequence) {
    const v = this.visualFor(c, m);
    if (v && v.el instanceof HTMLVideoElement) {
      const t0 = this.srcTime(c, m, c.start, seq.fps);
      if (Math.abs(v.el.currentTime - t0) > 0.05 && v.el.paused) v.el.currentTime = t0;
    }
  }

  private drawClipAt(ctx: CanvasRenderingContext2D, c: Clip, m: MediaItem, frame: number, W: number, H: number, seq: Sequence, res: number, playing: boolean, rate: number) {
    const v = this.visualFor(c, m);
    if (!v) { this.drawOffline(ctx, W, H, m); return; }
    const srcT = this.srcTime(c, m, frame, seq.fps);
    if (v.el instanceof HTMLVideoElement) {
      const el = v.el;
      const forward = playing && c.speed > 0 && rate > 0;
      const pr = Math.abs(c.speed * rate);
      if (forward && pr <= 16) {
        if (Math.abs(el.playbackRate - pr) > 1e-3) el.playbackRate = pr;
        if (el.paused) { el.currentTime = srcT; void el.play().catch(() => {}); }
        else if (Math.abs(el.currentTime - srcT) > 0.25) el.currentTime = srcT;
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - srcT) > 0.5 / seq.fps) el.currentTime = srcT;
      }
    }
    if (!v.ready) return;
    this.drawClip(ctx, v.el, c, m, frame - c.start, W, H, seq, res);
  }

  private drawOffline(ctx: CanvasRenderingContext2D, W: number, H: number, m: MediaItem) {
    ctx.fillStyle = '#5b1a1a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(H / 24)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(m.online ? 'Proxy hazırlanıyor…' : `Medya çevrimdışı: ${m.name}`, W / 2, H / 2);
  }

  private drawClip(ctx: CanvasRenderingContext2D, el: HTMLVideoElement | HTMLImageElement, c: Clip, m: MediaItem, local: number, W: number, H: number, seq: Sequence, res: number) {
    const iw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const ih = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    if (!iw || !ih) return;
    const t = c.transform;
    const mo = motionAt(c.effects, H, seq.fps, local);
    const fit = Math.min(W / iw, H / ih);
    const scale = (evalParam(t.scale, local) / 100) * mo.scale;
    const w = iw * fit * scale;
    const h = ih * fit * scale;
    const x = W / 2 + evalParam(t.posX, local) * res + mo.dx;
    const y = H / 2 + evalParam(t.posY, local) * res + mo.dy;
    let frameSrc: CanvasImageSource = el;
    const graded = c.color && (!isNeutral(c.color) || c.color.vignette) ? grader.process(el, c.color, Math.ceil(w)) : null;
    if (graded) frameSrc = graded;
    const fill = c.effects?.find((e) => e.enabled && e.type === 'blurfill');
    if (fill) drawBlurFill(ctx, frameSrc, iw, ih, W, H, fill.params);
    let tmp: HTMLCanvasElement | null = null;
    if (c.effects?.some((e) => e.enabled && EFFECT_BY_ID[e.type] && !EFFECT_BY_ID[e.type].kind)) {
      // effects work on the frame at the size it will be drawn (capped for speed)
      const k = Math.min(1, 960 / Math.max(1, w));
      const ew = Math.max(2, Math.round(w * k)), eh = Math.max(2, Math.round(h * k));
      tmp = tmpCanvas(ew, eh);
      const tc = tmp.getContext('2d', { willReadFrequently: true })!;
      tc.clearRect(0, 0, ew, eh);
      tc.drawImage(frameSrc, 0, 0, ew, eh);
      applyEffects(tmp, c.effects, local, (eh / h) * H);
      frameSrc = tmp;
    }
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, evalParam(t.opacity, local) / 100));
    ctx.translate(x, y);
    const rot = evalParam(t.rotation, local);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(frameSrc, -w / 2, -h / 2, w, h);
    ctx.restore();
    if (tmp) release(tmp);
  }

  /** per-track mixer strip: gain → pan → meter → master */
  private strip(trackId: string): Strip | null {
    if (!this.audio || !this.master) return null;
    let s = this.strips.get(trackId);
    if (!s) {
      const gain = this.audio.createGain();
      const pan = this.audio.createStereoPanner();
      const meter = this.audio.createAnalyser();
      meter.fftSize = 512;
      gain.connect(pan); pan.connect(meter); meter.connect(this.master);
      s = { gain, pan, meter };
      this.strips.set(trackId, s);
    }
    return s;
  }

  /** peak level 0..1 of a track (for the mixer meters) */
  trackLevel(trackId: string): number {
    const s = this.strips.get(trackId);
    if (!s || !useStore.getState().playing) return 0;
    const buf = new Float32Array(s.meter.fftSize);
    s.meter.getFloatTimeDomainData(buf);
    let p = 0;
    for (const v of buf) p = Math.max(p, Math.abs(v));
    return p;
  }

  private buildFx(nodes: PreviewNode[]): AudioNode[] {
    const ac = this.audio!;
    const out: AudioNode[] = [];
    for (const n of nodes) {
      if (n.type === 'biquad') { const b = ac.createBiquadFilter(); b.type = n.filter; b.frequency.value = n.frequency; if (n.gain !== undefined) b.gain.value = n.gain; if (n.Q !== undefined) b.Q.value = n.Q; out.push(b); }
      if (n.type === 'compressor') { const c = ac.createDynamicsCompressor(); c.threshold.value = n.threshold; c.ratio.value = n.ratio; c.attack.value = n.attack; c.release.value = n.release; if (n.knee !== undefined) c.knee.value = n.knee; out.push(c); }
      if (n.type === 'gain') { const g = ac.createGain(); g.gain.value = Math.pow(10, n.db / 20); out.push(g); }
      if (n.type === 'reverb') {
        // small synthetic room: decaying noise impulse, mixed wet/dry
        const len = Math.round(ac.sampleRate * n.seconds);
        const ir = ac.createBuffer(2, len, ac.sampleRate);
        for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
        const split = ac.createGain(), conv = ac.createConvolver(), wet = ac.createGain(), dry = ac.createGain(), sum = ac.createGain();
        conv.buffer = ir; wet.gain.value = n.mix; dry.gain.value = 1 - n.mix * 0.5;
        split.connect(conv); conv.connect(wet); wet.connect(sum); split.connect(dry); dry.connect(sum);
        // expose as a two-port pseudo node: input = split, output = sum
        (split as unknown as { __out: AudioNode }).__out = sum;
        out.push(split);
      }
    }
    return out;
  }

  private wire(s: Sound, c: Clip, trackId: string) {
    if (!this.audio || !s.src || !s.gain) return;
    const key = JSON.stringify(c.audioFx ?? []) + trackId;
    if (s.fxKey === key) return;
    try { s.src.disconnect(); } catch { /* */ }
    for (const n of s.fxNodes) { try { n.disconnect(); ((n as unknown as { __out?: AudioNode }).__out)?.disconnect(); } catch { /* */ } }
    try { s.gain.disconnect(); } catch { /* */ }
    const nodes: PreviewNode[] = [];
    for (const e of c.audioFx ?? []) if (e.enabled && AUDIO_FX_BY_ID[e.type]) nodes.push(...AUDIO_FX_BY_ID[e.type].preview(e.params));
    s.fxNodes = this.buildFx(nodes);
    let cur: AudioNode = s.src;
    for (const n of s.fxNodes) { cur.connect(n); cur = (n as unknown as { __out?: AudioNode }).__out ?? n; }
    cur.connect(s.gain);
    const strip = this.strip(trackId);
    s.gain.connect(strip ? strip.gain : this.master!);
    s.fxKey = key;
    s.track = trackId;
  }

  private syncAudio(seq: Sequence, f: number, playing: boolean, rate: number) {
    const st = useStore.getState();
    const live = new Set<string>();
    if (playing && rate > 0 && rate <= 4) {
      const frame = Math.floor(f);
      const anySolo = seq.tracks.some((t) => t.kind === 'audio' && t.solo);
      for (const t of seq.tracks) {
        if (t.kind !== 'audio') continue;
        const strip = this.strip(t.id);
        const audible = !t.muted && (!anySolo || t.solo);
        if (strip) { strip.gain.gain.value = audible ? Math.pow(10, t.volumeDb / 20) : 0; strip.pan.pan.value = (t.pan ?? 0) / 100; }
        if (!audible) continue;
        const clips = Object.values(seq.clips).filter((c) => c.trackId === t.id && c.stream === 'audio' && c.enabled && c.speed > 0).sort((a, b) => a.start - b.start);
        for (const c of clips) {
          if (frame < c.start || frame >= clipEnd(c)) continue;
          const m = st.project.media[c.mediaId];
          if (!m || !m.online) continue;
          const path = playbackPath(m);
          if (!path) continue;
          let s = this.sounds.get(c.id);
          if (s && s.path !== path) { this.dispose(c.id); s = undefined; }
          if (!s) {
            const el = new Audio();
            el.crossOrigin = 'anonymous'; // required for WebAudio across origins
            el.preload = 'auto';
            el.src = window.kurgu.mediaUrl(path);
            s = { el, path, gain: null, src: null, fxKey: '', fxNodes: [], track: t.id };
            if (this.audio && this.master) {
              try { s.src = this.audio.createMediaElementSource(el); s.gain = this.audio.createGain(); } catch { s.src = null; s.gain = null; }
            }
            this.sounds.set(c.id, s);
          }
          this.wire(s, c, t.id);
          live.add(c.id);
          const srcT = sourceTimeAt(c, frame, seq.fps) ?? c.srcIn;
          // clip volume + fades (preview fades happen inside the clip)
          let g = Math.pow(10, evalParam(c.volumeDb, frame - c.start) / 20);
          const curveOf = (t: string) => AUDIO_TRANSITIONS.find((x) => x.id === t)?.curve ?? 'qsin';
          const prev = clips.find((x) => clipEnd(x) === c.start && x.id !== c.id);
          const next = clips.find((x) => x.start === clipEnd(c) && x.id !== c.id);
          const fin = c.transIn ?? prev?.transOut;
          if (fin) g *= fadeGain(curveOf(fin.type), (frame - c.start) / Math.max(1, fin.duration / (prev ? 2 : 1)));
          const fout = next ? (next.transIn ?? c.transOut) : c.transOut;
          if (fout) g *= fadeGain(curveOf(fout.type), (clipEnd(c) - frame) / Math.max(1, fout.duration / (next ? 2 : 1)));
          if (s.gain) s.gain.gain.value = g; else s.el.volume = Math.min(1, g * Math.pow(10, t.volumeDb / 20));
          const pr = Math.abs(c.speed * rate);
          s.el.preservesPitch = true;
          if (Math.abs(s.el.playbackRate - pr) > 1e-3) s.el.playbackRate = pr;
          if (s.el.paused) { s.el.currentTime = srcT; void s.el.play().catch(() => {}); }
          else if (Math.abs(s.el.currentTime - srcT) > 0.12) s.el.currentTime = srcT;
        }
      }
    }
    for (const [id, s] of this.sounds) if (!live.has(id)) { s.el.pause(); if (!playing) continue; this.dispose(id); }
  }

  /** the decoded source element currently showing a clip (for auto colour) */
  sourceOf(clipId: string): HTMLVideoElement | HTMLImageElement | null {
    const v = this.visuals.get(clipId);
    return v && v.ready ? v.el : null;
  }

  /** silence the speakers (e.g. while recording a voice-over through an open mic) without stopping playback */
  setMonitorMuted(muted: boolean) {
    this.ensureAudio();
    if (this.master) this.master.gain.value = muted ? 0 : 1;
  }

  /** level meter values, 0..1 per channel-ish */
  levels(): number {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    return peak;
  }
}

export const player = new Player();

// redraw whenever the sequence or media change
useStore.subscribe((s, p) => {
  if (s.project !== p.project || s.preview !== p.preview || s.playbackRes !== p.playbackRes || s.proxies !== p.proxies) player.invalidate();
});
