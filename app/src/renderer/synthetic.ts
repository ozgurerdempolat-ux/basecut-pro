// New items: adjustment layer, colour matte, black video, transparent video.
// They are small generated PNGs (so every code path treats them as stills);
// the adjustment layer is special-cased in the player and the render graph.
import { MediaItem, defaultTransform, newId, param } from '../core/model';
import * as ops from '../core/ops';
import { committedSeq, editProject, selectClips, useStore } from './store';

async function png(w: number, h: number, color: number | null, name: string): Promise<string> {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  if (color !== null) { g.fillStyle = `#${color.toString(16).padStart(6, '0')}`; g.fillRect(0, 0, w, h); }
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
  return window.kurgu.writeCache(name, new Uint8Array(await blob.arrayBuffer()));
}

export type SyntheticKind = 'adjustment' | 'matte' | 'black' | 'transparent';

export async function createSynthetic(kind: SyntheticKind, color = 0x2b6cff, addToTimeline = true): Promise<string> {
  const seq = committedSeq();
  const W = seq.width, H = seq.height;
  const fill = kind === 'adjustment' || kind === 'transparent' ? null : kind === 'black' ? 0x000000 : color;
  // tiny file for flat colours/transparent; scaled to frame size on use
  const pw = 64, ph = Math.max(2, Math.round((64 * H) / W)); // frame aspect, so "fit" fills the frame exactly
  const path = await png(pw, ph, fill, `synthetic-${kind}-${fill ?? 'none'}-${pw}x${ph}.png`);
  const id = newId('m');
  const names: Record<SyntheticKind, string> = { adjustment: 'Ayar katmanı', matte: `Renk katmanı #${color.toString(16).padStart(6, '0')}`, black: 'Siyah video', transparent: 'Şeffaf video' };
  const media: MediaItem = {
    id, path, name: names[kind], kind: 'image', duration: Infinity, fps: seq.fps, width: W, height: H, hasVideo: true, hasAudio: false,
    audioChannels: 0, sampleRate: 0, codec: 'png', binId: null, label: kind === 'adjustment' ? 'lavender' : 'tan', online: true, markIn: null, markOut: null,
    synthetic: { type: kind === 'adjustment' ? 'adjustment' : 'matte', color: fill ?? undefined },
  };
  let clipId = '';
  editProject(`${names[kind]} ekle`, (p) => {
    p.media[id] = media;
    if (!addToTimeline) return;
    const s = p.sequences[seq.id];
    const start = s.playhead, len = Math.round(s.fps * 5);
    const vids = s.tracks.filter((t) => t.kind === 'video' && !t.locked);
    // adjustment layers go above what they adjust: the lowest free track above V1
    let track = vids.slice(kind === 'adjustment' ? 1 : 0).find((t) => ops.isRangeEmpty(s, t.id, start, start + len));
    if (!track) { const tid = ops.addTrack(s, 'video'); track = s.tracks.find((t) => t.id === tid)!; }
    clipId = newId('clip');
    s.clips[clipId] = {
      id: clipId, trackId: track.id, mediaId: id, stream: 'video', start, duration: len, srcIn: 0, speed: 1, linkId: null,
      enabled: true, name: media.name, label: media.label, transform: defaultTransform(), volumeDb: param(0),
    };
  });
  if (clipId) { selectClips([clipId]); useStore.setState({ leftTab: 'fx' }); }
  return clipId;
}
