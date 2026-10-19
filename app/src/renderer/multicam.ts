// Multicam: create a synced source sequence from selected camera files, cut
// between angles with 1–9 (live while playing), flatten to plain clips.
import { MediaItem, clipEnd, defaultTransform, newId, param, sequenceDuration } from '../core/model';
import { makeMulticamSource, syncOffset } from '../core/multicam';
import * as ops from '../core/ops';
import { committedSeq, edit, editProject, toast, useStore } from './store';

export async function createMulticam(mediaIds: string[], sync: 'audio' | 'in' | 'start'): Promise<void> {
  const st = useStore.getState();
  const media = mediaIds.map((id) => st.project.media[id]).filter((m): m is MediaItem => !!m && (m.hasVideo || m.hasAudio) && m.kind !== 'image');
  if (media.length < 2) { toast('Çoklu kamera için en az iki video seçin', 'error'); return; }
  let offsets = media.map(() => 0);
  if (sync === 'in') offsets = media.map((m) => -(m.markIn ?? 0));
  if (sync === 'audio') {
    const rate = 100;
    const env: Float32Array[] = [];
    for (const [i, m] of media.entries()) {
      if (!m.hasAudio) { env.push(new Float32Array(0)); continue; }
      env.push(new Float32Array(await window.kurgu.audioEnvelope({ path: m.path, rate, maxSec: 600, label: `Ses senkronu: ${m.name} (${i + 1}/${media.length})` })));
    }
    const ref = media.findIndex((m) => m.hasAudio);
    const weak: string[] = [];
    offsets = media.map((m, i) => {
      if (i === ref || !env[i].length) return 0;
      const r = syncOffset(env[ref], env[i], rate, 300);
      if (r.confidence < 0.15) weak.push(m.name);
      return r.offset;
    });
    if (weak.length) toast(`Ses eşleşmesi zayıf: ${weak.join(', ')} — gerekirse kaynak sekansta elle kaydırın`, 'error');
  }
  const fps = Math.round((media.find((m) => m.kind === 'video')?.fps ?? committedSeq().fps) * 1000) / 1000;
  const src = makeMulticamSource(`Çoklu kamera: ${media[0].name}`, media, offsets, fps);
  const dur = sequenceDuration(src) / fps;
  const mcMedia: MediaItem = {
    ...(media.find((m) => m.kind === 'video') ?? media[0]),
    id: newId('m'), name: `Çoklu kamera (${media.length} açı)`, path: '', duration: dur, kind: 'video', hasVideo: true, hasAudio: true,
    synthetic: { type: 'multicam', seqId: src.id }, label: 'mango', markIn: null, markOut: null,
  };
  editProject('Çoklu kamera kaynak sekansı', (p) => {
    p.sequences[src.id] = src;
    p.media[mcMedia.id] = mcMedia;
    // put it in the active sequence at the playhead, as one linked multicam clip
    const s = p.activeSequenceId ? p.sequences[p.activeSequenceId] : null;
    if (!s || s.id === src.id) return;
    const t = ops.targetTracks(s);
    const v = t.video ?? s.tracks.find((x) => x.kind === 'video')!.id;
    const a = t.audio ?? s.tracks.find((x) => x.kind === 'audio')!.id;
    const len = Math.round(dur * s.fps);
    const at = s.playhead;
    ops.clearRange(s, v, at, at + len); ops.clearRange(s, a, at, at + len);
    const link = newId('link');
    const base = { mediaId: mcMedia.id, start: at, duration: len, srcIn: 0, speed: 1, linkId: link, enabled: true, label: 'mango' as const, transform: defaultTransform(), volumeDb: param(0) };
    const vid = newId('clip'), aid = newId('clip');
    s.clips[vid] = { ...base, id: vid, trackId: v, stream: 'video', name: 'Kamera 1', mc: { seqId: src.id, angle: 0 } };
    s.clips[aid] = { ...base, id: aid, trackId: a, stream: 'audio', name: 'Ses: Kamera 1', mc: { seqId: src.id, angle: 0 } };
  });
  useStore.setState({ multicamView: true });
  toast(`${media.length} açılı çoklu kamera hazır — oynatırken 1–${Math.min(9, media.length)} tuşlarıyla kamera değiştirin`, 'success');
}

/** the multicam video clip under the playhead in the active sequence */
export function multicamAtPlayhead() {
  const seq = committedSeq();
  return Object.values(seq.clips).find((c) => c.mc && c.stream === 'video' && seq.playhead >= c.start && seq.playhead < clipEnd(c)) ?? null;
}

/** switch to angle (0-based): while playing it cuts at the playhead, when stopped it changes the current segment */
export function switchAngle(angle: number) {
  const st = useStore.getState();
  const c = multicamAtPlayhead();
  if (!c?.mc) return false;
  const src = st.project.sequences[c.mc.seqId];
  const n = src?.multicam?.angles.length ?? 0;
  if (angle >= n) return true;
  const at = committedSeq().playhead;
  edit(`Kamera ${angle + 1}`, (s) => {
    const cur = s.clips[c.id];
    if (!cur) return;
    if (st.playing && at > cur.start) {
      const made = ops.splitAt(s, at, [cur.trackId]);
      const right = made.map((id) => s.clips[id]).find((x) => x && x.start === at && x.stream === 'video');
      if (right?.mc) { right.mc = { ...right.mc, angle }; right.name = src.multicam!.angles[angle].name; right.linkId = null; }
    } else {
      cur.mc = { ...cur.mc!, angle };
      cur.name = src.multicam!.angles[angle].name;
    }
  });
  return true;
}

/** replace multicam clips by the plain clips of their angles (no more switching) */
export function flattenMulticam() {
  const st = useStore.getState();
  edit('Çoklu kamerayı düzleştir', (s) => {
    for (const c of Object.values(s.clips)) {
      if (!c.mc) continue;
      const src = st.project.sequences[c.mc.seqId];
      if (!src) continue;
      const tracks = src.tracks.filter((t) => t.kind === c.stream);
      const track = tracks[Math.min(c.mc.angle, tracks.length - 1)];
      const scale = src.fps / s.fps;
      const from = c.srcIn * src.fps, to = from + c.duration * scale;
      for (const x of Object.values(src.clips)) {
        if (x.trackId !== track.id || clipEnd(x) <= from || x.start >= to) continue;
        const a = Math.max(x.start, from), b = Math.min(clipEnd(x), to);
        const id = newId('clip');
        s.clips[id] = { ...JSON.parse(JSON.stringify(x)), id, trackId: c.trackId, start: c.start + Math.round((a - from) / scale), duration: Math.round((b - a) / scale), srcIn: x.srcIn + ((a - x.start) / src.fps) * Math.abs(x.speed), linkId: null, transform: JSON.parse(JSON.stringify(c.transform)) };
      }
      delete s.clips[c.id];
    }
  });
}
