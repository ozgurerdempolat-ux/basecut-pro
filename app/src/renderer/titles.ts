import { MediaItem, newId, param, defaultTransform } from '../core/model';
import * as ops from '../core/ops';
import { TITLE_PRESETS, TitleData, titleKey } from '../core/title';
import { GLayer, GRAPHIC_TEMPLATES, GraphicData, ShapeLayer, TextLayer, asGraphic, graphicLabel, isGraphic } from '../core/graphic';
import { committedSeq, edit, editProject, selectClips, toast, useStore } from './store';

// ------------------------------------------------------------------ drawing

export interface LayerBox { id: string; cx: number; cy: number; w: number; h: number; rotation: number }

const rgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return `rgba(${parseInt(v.slice(0, 2), 16)},${parseInt(v.slice(2, 4), 16)},${parseInt(v.slice(4, 6), 16)},${a})`;
};

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, h / 2, w / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fillStyle(ctx: CanvasRenderingContext2D, f: NonNullable<GLayer['fill']>, w: number, h: number): string | CanvasGradient {
  if (!f.gradient) return rgba(f.color, f.opacity);
  const a = (f.gradient.angle * Math.PI) / 180;
  const dx = (Math.cos(a) * w) / 2, dy = (Math.sin(a) * h) / 2;
  const g = ctx.createLinearGradient(-dx, -dy, dx, dy);
  g.addColorStop(0, rgba(f.color, f.opacity));
  g.addColorStop(1, rgba(f.gradient.to, f.opacity));
  return g;
}

/** wrap and case the text of a text layer into lines (needs ctx.font set) */
function textLines(ctx: CanvasRenderingContext2D, l: TextLayer, W: number): string[] {
  const raw = (l.uppercase ? l.text.toLocaleUpperCase('tr-TR') : l.text).split('\n');
  if (!l.wrap) return raw;
  const max = (l.wrap / 100) * W;
  const out: string[] = [];
  for (const para of raw) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const t = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(t).width > max) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

/**
 * Draw one layer centred at the origin (caller translates/rotates). `paint`
 * draws the layer's shape with the given fill / stroke callbacks so shadows,
 * strokes and fill all use the same geometry. Returns the layer's size.
 */
function layerGeometry(ctx: CanvasRenderingContext2D, l: GLayer, k: number, W: number) {
  if (l.kind === 'text') {
    const size = l.size * k;
    ctx.font = `${l.italic ? 'italic ' : ''}${l.weight} ${size}px "${l.font}", "Montserrat", system-ui, sans-serif`;
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${l.tracking * k}px`;
    ctx.textBaseline = 'middle';
    const lines = textLines(ctx, l, W);
    const lh = size * l.leading;
    const widths = lines.map((s) => ctx.measureText(s).width);
    const bw = Math.max(1, ...widths), bh = lh * lines.length;
    const xs = widths.map((w) => (l.align === 'left' ? -bw / 2 : l.align === 'right' ? bw / 2 - w : -w / 2));
    // anchor: centre for centred text; the left/right edge sits at x for aligned text
    const shiftX = l.align === 'left' ? bw / 2 : l.align === 'right' ? -bw / 2 : 0;
    const box = l.box ? { pad: l.box.padding * k, r: l.box.radius * k } : null;
    const paint = (fill: ((t: string, x: number, y: number) => void) | null, stroke: ((t: string, x: number, y: number) => void) | null) => {
      lines.forEach((s, i) => {
        const y = -bh / 2 + lh * i + lh / 2;
        if (stroke) stroke(s, xs[i] + shiftX, y);
        if (fill) fill(s, xs[i] + shiftX, y);
      });
    };
    const underline = (ctx2: CanvasRenderingContext2D, style: string | CanvasGradient) => {
      if (!l.underline) return;
      ctx2.fillStyle = style;
      lines.forEach((_s, i) => { const y = -bh / 2 + lh * i + lh / 2 + size * 0.42; ctx2.fillRect(xs[i] + shiftX, y, widths[i], Math.max(1, size * 0.06)); });
    };
    return { kind: 'text' as const, w: bw + (box ? box.pad * 2 : 0), h: bh + (box ? box.pad * 1.1 : 0), tw: bw, th: bh, shiftX, box, paint, underline, size };
  }
  const s = l as ShapeLayer;
  const w = Math.max(1, s.w * k), h = s.kind === 'line' ? 0 : Math.max(1, s.h * k);
  const path = () => {
    ctx.beginPath();
    if (s.kind === 'rect') roundRectPath(ctx, -w / 2, -h / 2, w, h, s.radius * k);
    else if (s.kind === 'ellipse') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (s.kind === 'polygon') {
      const n = Math.max(3, Math.round(s.sides));
      for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; const px = (Math.cos(a) * w) / 2, py = (Math.sin(a) * h) / 2; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
      ctx.closePath();
    } else { ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0); }
  };
  return { kind: 'shape' as const, w, h: Math.max(h, (s.strokes[0]?.width ?? 2) * k), path };
}

/** draw a graphic onto a transparent W×H canvas; returns each layer's box (frame pixels) */
export function drawGraphic(ctx: CanvasRenderingContext2D, gIn: GraphicData | TitleData, W: number, H: number, opts: { clear?: boolean } = {}): LayerBox[] {
  const g = asGraphic(gIn);
  const k = H / 1080;
  if (opts.clear !== false) ctx.clearRect(0, 0, W, H);
  const boxes: LayerBox[] = [];
  for (const l of g.layers) {
    ctx.save();
    const geo = layerGeometry(ctx, l, k, W);
    const cx = (l.x / 100) * W, cy = (l.y / 100) * H;
    boxes.push({ id: l.id, cx: cx + (geo.kind === 'text' ? -geo.shiftX : 0), cy, w: geo.w, h: geo.h, rotation: l.rotation });
    if (l.hidden || l.opacity <= 0) { ctx.restore(); continue; }
    ctx.translate(cx, cy);
    if (l.rotation) ctx.rotate((l.rotation * Math.PI) / 180);
    ctx.globalAlpha = Math.max(0, Math.min(1, l.opacity / 100));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const strokes = [...l.strokes].sort((a, b) => b.width - a.width); // widest first, so every stroke shows
    if (geo.kind === 'text') {
      const fillS = l.fill ? fillStyle(ctx, l.fill, geo.tw, geo.th) : null;
      // background box (with the layer's shadows)
      if (geo.box && (l as TextLayer).box) {
        const b = (l as TextLayer).box!;
        for (const sh of l.shadows) { ctx.save(); ctx.shadowColor = rgba(sh.color, sh.opacity); ctx.shadowBlur = sh.blur * k; ctx.shadowOffsetX = sh.dx * k; ctx.shadowOffsetY = sh.dy * k; ctx.fillStyle = rgba(b.color, b.opacity); roundRectPath(ctx, -geo.tw / 2 - geo.box.pad + geo.shiftX, -geo.th / 2 - geo.box.pad * 0.55, geo.tw + geo.box.pad * 2, geo.th + geo.box.pad * 1.1, geo.box.r); ctx.fill(); ctx.restore(); }
        ctx.fillStyle = rgba(b.color, b.opacity);
        roundRectPath(ctx, -geo.tw / 2 - geo.box.pad + geo.shiftX, -geo.th / 2 - geo.box.pad * 0.55, geo.tw + geo.box.pad * 2, geo.th + geo.box.pad * 1.1, geo.box.r);
        ctx.fill();
      } else {
        // shadows: draw the glyphs far away and throw only their shadow into place
        for (const sh of l.shadows) {
          ctx.save();
          ctx.shadowColor = rgba(sh.color, sh.opacity); ctx.shadowBlur = sh.blur * k;
          ctx.shadowOffsetX = sh.dx * k + 100000; ctx.shadowOffsetY = sh.dy * k;
          ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
          const wMax = strokes[0] ? strokes[0].width * k : 0;
          ctx.lineWidth = wMax;
          geo.paint((t, x, y) => ctx.fillText(t, x - 100000, y), wMax ? (t, x, y) => ctx.strokeText(t, x - 100000, y) : null);
          ctx.restore();
        }
      }
      for (const st of strokes) { ctx.strokeStyle = rgba(st.color, st.opacity); ctx.lineWidth = st.width * k; geo.paint(null, (t, x, y) => ctx.strokeText(t, x, y)); }
      if (fillS) { ctx.fillStyle = fillS; geo.paint((t, x, y) => ctx.fillText(t, x, y), null); geo.underline(ctx, fillS); }
    } else {
      for (const sh of l.shadows) {
        ctx.save();
        ctx.shadowColor = rgba(sh.color, sh.opacity); ctx.shadowBlur = sh.blur * k;
        ctx.shadowOffsetX = sh.dx * k + 100000; ctx.shadowOffsetY = sh.dy * k;
        ctx.translate(-100000, 0);
        geo.path();
        if (l.fill) { ctx.fillStyle = '#000'; ctx.fill(); }
        if (strokes[0]) { ctx.strokeStyle = '#000'; ctx.lineWidth = strokes[0].width * k; ctx.stroke(); }
        ctx.restore();
      }
      geo.path();
      if (l.fill && l.kind !== 'line') { ctx.fillStyle = fillStyle(ctx, l.fill, geo.w, geo.h); ctx.fill(); }
      for (const st of strokes) { ctx.strokeStyle = rgba(st.color, st.opacity); ctx.lineWidth = st.width * k; ctx.stroke(); }
    }
    ctx.restore();
  }
  return boxes;
}

/** kept for older callers */
export const drawTitle = (ctx: CanvasRenderingContext2D, d: TitleData | GraphicData, W: number, H: number) => { drawGraphic(ctx, d, W, H); };

/** wait for every font a graphic uses (system or bundled) */
async function loadFonts(g: GraphicData) {
  const want = new Set<string>();
  for (const l of g.layers) if (l.kind === 'text') want.add(`${l.italic ? 'italic ' : ''}${l.weight} 40px "${l.font}"`);
  await Promise.all([...want].map((f) => document.fonts.load(f).catch(() => undefined)));
}

/** render a graphic to a PNG file in the cache; same design → same file */
export async function renderTitleFile(d: TitleData | GraphicData, W: number, H: number): Promise<string> {
  const g = asGraphic(d);
  await loadFonts(g);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  drawGraphic(canvas.getContext('2d')!, g, W, H);
  const blob: Blob = await new Promise((r, j) => canvas.toBlob((b) => (b ? r(b) : j(new Error('render failed'))), 'image/png'));
  return window.kurgu.writeCache(`title-${titleKey(g as unknown as TitleData, W, H)}.png`, new Uint8Array(await blob.arrayBuffer()));
}

// ------------------------------------------------------------------ creating / editing

const LEGACY: Record<string, string> = { baslik: 'big', kanca: 'hook', 'alt-bant': 'lower', etiket: 'price', 'altyazi-ust': 'location', sade: 'plain' };

function templateData(id: string): GraphicData {
  const t = GRAPHIC_TEMPLATES.find((x) => x.id === (LEGACY[id] ?? id));
  if (t) return t.make();
  const legacy = TITLE_PRESETS.find((p) => p.id === id) ?? TITLE_PRESETS[0];
  return asGraphic(structuredClone(legacy.data));
}

/** Type tool / "new graphic": put a graphic on the first free video track at the playhead */
export async function createTitle(templateId = 'big', at?: number, data?: GraphicData) {
  const st = useStore.getState();
  const seq = committedSeq(st);
  const g = data ?? templateData(templateId);
  const path = await renderTitleFile(g, seq.width, seq.height);
  const id = newId('m');
  const name = `Grafik: ${graphicLabel(g)}`;
  const media: MediaItem = {
    id, path, name, kind: 'image', duration: Infinity, fps: seq.fps,
    width: seq.width, height: seq.height, hasVideo: true, hasAudio: false, audioChannels: 0, sampleRate: 0, codec: 'png',
    binId: null, label: 'rose', online: true, markIn: null, markOut: null, title: g,
  };
  const start = at ?? seq.playhead;
  const len = Math.round(seq.fps * 3);
  let clipId = '';
  editProject('Grafik ekle', (p) => {
    p.media[id] = media;
    const s = p.sequences[seq.id];
    const vids = s.tracks.filter((t) => t.kind === 'video' && !t.locked);
    let track = vids.slice(1).find((t) => ops.isRangeEmpty(s, t.id, start, start + len));
    if (!track) { const tid = ops.addTrack(s, 'video'); track = s.tracks.find((t) => t.id === tid)!; }
    clipId = newId('clip');
    s.clips[clipId] = {
      id: clipId, trackId: track.id, mediaId: id, stream: 'video', start, duration: len, srcIn: 0, speed: 1, linkId: null,
      enabled: true, name, label: 'rose', transform: defaultTransform(), volumeDb: param(0),
    };
  });
  selectClips([clipId]);
  useStore.setState({ leftTab: 'fx', tool: 'select', selLayer: asGraphic(g).layers.find((l) => l.kind === 'text')?.id ?? null });
  return clipId;
}

let pending: Promise<unknown> = Promise.resolve();

/** change a graphic; regenerates its image (calls are queued so they apply in order) */
export function updateGraphic(mediaId: string, fn: (g: GraphicData) => void, label = 'Grafiği düzenle') {
  pending = pending.then(async () => {
    const st = useStore.getState();
    const m = st.project.media[mediaId];
    if (!m?.title) return;
    const seq = committedSeq(st);
    const g = structuredClone(asGraphic(m.title as TitleData | GraphicData));
    fn(g);
    const path = await renderTitleFile(g, seq.width, seq.height);
    const name = `Grafik: ${graphicLabel(g)}`;
    editProject(label, (p) => {
      const mm = p.media[mediaId];
      mm.title = g;
      mm.path = path;
      mm.name = name;
      for (const s of Object.values(p.sequences)) for (const c of Object.values(s.clips)) if (c.mediaId === mediaId) c.name = name;
    });
  }).catch((e) => toast(`Grafik güncellenemedi: ${(e as Error).message}`, 'error'));
  return pending;
}

/** older single-text API (tests, Type tool): edits the first text layer */
export function updateTitle(mediaId: string, patch: Partial<TitleData>) {
  return updateGraphic(mediaId, (g) => {
    const t = g.layers.find((l): l is TextLayer => l.kind === 'text');
    if (!t) return;
    if (patch.text !== undefined) t.text = patch.text;
    if (patch.color && t.fill) t.fill.color = patch.color;
    if (patch.x !== undefined) t.x = patch.x;
    if (patch.y !== undefined) t.y = patch.y;
    if (patch.font) t.font = patch.font;
    if (patch.weight) t.weight = patch.weight;
    if (patch.size) t.size = (patch.size / 100) * 1080;
    if (patch.align) t.align = patch.align;
  }, 'Başlığı düzenle');
}

export const isGraphicMedia = (m: MediaItem | undefined) => !!m?.title && (isGraphic(m.title) || 'text' in (m.title as object));

void edit;
