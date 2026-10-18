import { MediaItem, newId, param, defaultTransform } from '../core/model';
import * as ops from '../core/ops';
import { TITLE_PRESETS, TitleData, titleKey, titleLines } from '../core/title';
import { committedSeq, edit, editProject, selectClips, toast, useStore } from './store';

/** draw a title onto a transparent canvas the size of the frame */
export function drawTitle(ctx: CanvasRenderingContext2D, d: TitleData, W: number, H: number) {
  const size = (d.size / 100) * H;
  const lines = titleLines(d);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.font = `${d.weight} ${size}px "${d.font}", system-ui, sans-serif`;
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${(d.letterSpacing / 1080) * H}px`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const lh = size * d.lineHeight;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(...widths, 1);
  const blockH = lh * lines.length;
  const ax = (d.x / 100) * W;
  const ay = (d.y / 100) * H;
  const left = d.align === 'left' ? ax : d.align === 'right' ? ax - blockW : ax - blockW / 2;
  const top = ay - blockH / 2;
  if (d.box) {
    const pad = (d.boxPadding / 100) * size;
    const r = (d.boxRadius / 100) * size;
    ctx.fillStyle = rgba(d.boxColor, d.boxOpacity);
    roundRect(ctx, left - pad, top - pad * 0.55, blockW + pad * 2, blockH + pad * 1.1, r);
  }
  lines.forEach((line, i) => {
    const w = widths[i];
    const x = d.align === 'left' ? left : d.align === 'right' ? left + blockW - w : left + (blockW - w) / 2;
    const y = top + lh * i + lh / 2;
    if (d.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = size * 0.12; ctx.shadowOffsetY = size * 0.05; }
    if (d.strokeWidth > 0) {
      ctx.strokeStyle = d.stroke;
      ctx.lineWidth = (d.strokeWidth / 100) * size * 2;
      ctx.strokeText(line, x, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = d.color;
    ctx.fillText(line, x, y);
    ctx.shadowColor = 'transparent';
  });
  ctx.restore();
}

function rgba(hex: string, a: number) {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

/** render a title to a PNG file in the cache; same design → same file */
export async function renderTitleFile(d: TitleData, W: number, H: number): Promise<string> {
  await document.fonts.load(`${d.weight} 40px "${d.font}"`).catch(() => undefined);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  drawTitle(canvas.getContext('2d')!, d, W, H);
  const blob: Blob = await new Promise((r, j) => canvas.toBlob((b) => (b ? r(b) : j(new Error('render failed'))), 'image/png'));
  return window.kurgu.writeCache(`title-${titleKey(d, W, H)}.png`, new Uint8Array(await blob.arrayBuffer()));
}

/** Type tool / "new title": put a title on the first free video track at the playhead */
export async function createTitle(presetId = 'baslik', at?: number) {
  const st = useStore.getState();
  const seq = committedSeq(st);
  const data: TitleData = structuredClone(TITLE_PRESETS.find((p) => p.id === presetId)?.data ?? TITLE_PRESETS[0].data);
  const path = await renderTitleFile(data, seq.width, seq.height);
  const id = newId('m');
  const media: MediaItem = {
    id, path, name: `Başlık: ${data.text.split('\n')[0].slice(0, 24)}`, kind: 'image', duration: Infinity, fps: seq.fps,
    width: seq.width, height: seq.height, hasVideo: true, hasAudio: false, audioChannels: 0, sampleRate: 0, codec: 'png',
    binId: null, label: 'rose', online: true, markIn: null, markOut: null, title: data,
  };
  const start = at ?? seq.playhead;
  const len = Math.round(seq.fps * 3);
  editProject('Başlık ekle', (p) => {
    p.media[id] = media;
    const s = p.sequences[seq.id];
    // first video track (bottom → top, skipping V1) that is free for the whole duration; add one if none
    const vids = s.tracks.filter((t) => t.kind === 'video' && !t.locked);
    let track = vids.slice(1).find((t) => ops.isRangeEmpty(s, t.id, start, start + len));
    if (!track) { const tid = ops.addTrack(s, 'video'); track = s.tracks.find((t) => t.id === tid)!; }
    const clipId = newId('clip');
    s.clips[clipId] = {
      id: clipId, trackId: track.id, mediaId: id, stream: 'video', start, duration: len, srcIn: 0, speed: 1, linkId: null,
      enabled: true, name: media.name, label: 'rose', transform: defaultTransform(), volumeDb: param(0),
    };
    (globalThis as unknown as { __lastTitleClip: string }).__lastTitleClip = clipId;
  });
  const clipId = (globalThis as unknown as { __lastTitleClip: string }).__lastTitleClip;
  selectClips([clipId]);
  useStore.setState({ leftTab: 'fx', tool: 'select' });
  return clipId;
}

let pending: Promise<unknown> = Promise.resolve();

/** change a title's design; regenerates its image */
export function updateTitle(mediaId: string, patch: Partial<TitleData>) {
  pending = pending.then(async () => {
    const st = useStore.getState();
    const m = st.project.media[mediaId];
    if (!m?.title) return;
    const seq = committedSeq(st);
    const data = { ...m.title, ...patch };
    const path = await renderTitleFile(data, seq.width, seq.height);
    editProject('Başlığı düzenle', (p) => {
      const mm = p.media[mediaId];
      mm.title = data;
      mm.path = path;
      mm.name = `Başlık: ${data.text.split('\n')[0].slice(0, 24)}`;
      for (const s of Object.values(p.sequences)) for (const c of Object.values(s.clips)) if (c.mediaId === mediaId) c.name = mm.name;
    });
  }).catch((e) => toast(`Başlık güncellenemedi: ${(e as Error).message}`, 'error'));
  return pending;
}

void edit;
