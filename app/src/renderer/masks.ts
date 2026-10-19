// Mask rasteriser shared by the preview and the export (see core/mask.ts).
import { Mask, activeMasks, maskKey, maskOutline } from '../core/mask';
import { patchProjectSilently, useStore } from './store';

function path(g: CanvasRenderingContext2D, m: Mask, w: number, h: number) {
  const o = maskOutline(m, w, h);
  g.beginPath();
  if (o.kind === 'ellipse') g.ellipse(o.cx!, o.cy!, Math.max(0.5, o.rx!), Math.max(0.5, o.ry!), 0, 0, Math.PI * 2);
  else { o.pts!.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); }
}

const mk = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

/** alpha-only canvas: opaque where the clip is kept */
export function rasterize(masks: Mask[], w: number, h: number, scale = 1): HTMLCanvasElement {
  const acc = mk(w, h);
  const ga = acc.getContext('2d')!;
  const list = masks.filter((m) => m.opacity > 0 || m.mode !== 'add');
  if (list.length && list[0].mode !== 'add') { ga.fillStyle = '#fff'; ga.fillRect(0, 0, w, h); }
  for (const m of list) {
    const shape = mk(w, h);
    const g = shape.getContext('2d')!;
    g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineJoin = 'round';
    path(g, m, w, h);
    g.fill();
    const e = m.expansion * scale;
    if (e > 0) { g.lineWidth = 2 * e; g.stroke(); }
    if (e < 0) { g.globalCompositeOperation = 'destination-out'; g.lineWidth = -2 * e; path(g, m, w, h); g.stroke(); g.globalCompositeOperation = 'source-over'; }
    // feather, opacity, invert
    const soft = mk(w, h);
    const gs = soft.getContext('2d')!;
    if (m.invert) { gs.fillStyle = '#fff'; gs.fillRect(0, 0, w, h); gs.globalCompositeOperation = 'destination-out'; }
    if (m.feather > 0) gs.filter = `blur(${(m.feather * scale) / 2}px)`;
    gs.drawImage(shape, 0, 0);
    gs.filter = 'none'; gs.globalCompositeOperation = 'source-over';
    ga.globalAlpha = m.opacity / 100;
    ga.globalCompositeOperation = m.mode === 'subtract' ? 'destination-out' : m.mode === 'intersect' ? 'destination-in' : 'source-over';
    ga.drawImage(soft, 0, 0);
    ga.globalAlpha = 1; ga.globalCompositeOperation = 'source-over';
  }
  return acc;
}

// ------------------------------------------------------------------ preview cache

const cache = new Map<string, HTMLCanvasElement>();
/** mask canvas for preview, rasterised at the source size (capped) */
export function previewMask(masks: Mask[], sw: number, sh: number): HTMLCanvasElement {
  const k = Math.min(1, 1280 / Math.max(sw, sh));
  const w = Math.max(2, Math.round(sw * k)), h = Math.max(2, Math.round(sh * k));
  const key = maskKey(masks, w, h);
  let c = cache.get(key);
  if (!c) {
    if (cache.size > 40) cache.clear();
    c = rasterize(masks, w, h, k);
    cache.set(key, c);
  }
  return c;
}

// ------------------------------------------------------------------ export images

let timer: number | undefined;
let running = false;
async function syncImages() {
  if (running) return;
  running = true;
  try {
    const st = useStore.getState();
    for (const seq of Object.values(st.project.sequences)) {
      for (const c of Object.values(seq.clips)) {
        if (!activeMasks(c).length) continue;
        const m = st.project.media[c.mediaId];
        if (!m) continue;
        const sw = m.width || seq.width, sh = m.height || seq.height;
        const key = maskKey(c.masks, sw, sh);
        if (c.maskImage?.key === key) continue;
        const canvas = rasterize(c.masks!, sw, sh);
        // greyscale image for ffmpeg: white = keep
        const out = mk(sw, sh);
        const g = out.getContext('2d')!;
        g.fillStyle = '#000'; g.fillRect(0, 0, sw, sh);
        g.drawImage(canvas, 0, 0);
        const blob: Blob = await new Promise((r) => out.toBlob((b) => r(b!), 'image/png'));
        const p = await window.kurgu.writeCache(`mask-${key}.png`, new Uint8Array(await blob.arrayBuffer()));
        patchProjectSilently((pr) => { const cc = pr.sequences[seq.id]?.clips[c.id]; if (cc && maskKey(cc.masks, sw, sh) === key) cc.maskImage = { key, path: p }; });
      }
    }
  } finally { running = false; }
}

export function trackMasks() {
  useStore.subscribe((s, prev) => { if (s.project !== prev.project) { window.clearTimeout(timer); timer = window.setTimeout(() => void syncImages(), 250); } });
}

/** make sure every mask image is current (called before export) */
export async function ensureMaskImages() { window.clearTimeout(timer); while (running) await new Promise((r) => setTimeout(r, 30)); await syncImages(); }
