// Live preview of effects and transitions on canvases. Mirrors the ffmpeg
// filters in core/fx.ts closely enough to judge the look while editing; the
// export uses the real ffmpeg filters.
import { ClipEffect, EFFECT_BY_ID, TRANSITION_BY_ID } from '../core/fx';

const pool: HTMLCanvasElement[] = [];
export function tmpCanvas(w: number, h: number): HTMLCanvasElement {
  const c = pool.pop() ?? document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}
export function release(c: HTMLCanvasElement) { if (pool.length < 12) pool.push(c); }

const ctx2 = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;

/** apply pixel effects in place on `c` (already holding the clip frame at drawn size) */
export function applyEffects(c: HTMLCanvasElement, effects: ClipEffect[], L: number, H: number) {
  const ctx = ctx2(c);
  const w = c.width, h = c.height;
  const scaleH = h / Math.max(1, H); // effects sized in % of frame height
  for (const e of effects) {
    if (!e.enabled) continue;
    const def = EFFECT_BY_ID[e.type];
    if (!def || def.kind === 'motion' || def.kind === 'blurfill') continue;
    const p = e.params;
    const viaFilter = (filter: string) => {
      const t = tmpCanvas(w, h);
      const tc = ctx2(t);
      tc.clearRect(0, 0, w, h);
      tc.drawImage(c, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.filter = filter;
      ctx.drawImage(t, 0, 0);
      ctx.filter = 'none';
      release(t);
    };
    switch (e.type) {
      case 'blur': viaFilter(`blur(${(p.amount / 100) * h * 0.5}px)`); break;
      case 'bw': viaFilter(`grayscale(${p.amount / 100})`); break;
      case 'sepia': viaFilter(`sepia(${p.amount / 100})`); break;
      case 'invert': viaFilter('invert(1)'); break;
      case 'hue': viaFilter(`hue-rotate(${p.deg}deg)`); break;
      case 'brightcontrast': viaFilter(`brightness(${1 + p.brightness / 200}) contrast(${1 + p.contrast / 100})`); break;
      case 'sharpen': viaFilter(`contrast(${1 + p.amount * 0.08})`); break;
      case 'pixelate': {
        const b = Math.max(1, (p.size / 100) * h);
        const sw = Math.max(2, Math.round(w / b)), sh = Math.max(2, Math.round(h / b));
        const t = tmpCanvas(sw, sh);
        ctx2(t).drawImage(c, 0, 0, sw, sh);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(t, 0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        release(t);
        break;
      }
      case 'mirror': {
        const t = tmpCanvas(w, h);
        ctx2(t).drawImage(c, 0, 0);
        ctx.save();
        ctx.clearRect(0, 0, w, h);
        ctx.translate(p.mode !== 1 ? w : 0, p.mode >= 1 ? h : 0);
        ctx.scale(p.mode !== 1 ? -1 : 1, p.mode >= 1 ? -1 : 1);
        ctx.drawImage(t, 0, 0);
        ctx.restore();
        release(t);
        break;
      }
      case 'rgbsplit': rgbShift(c, Math.round((p.amount / 100) * H * scaleH)); break;
      case 'glitch': rgbShift(c, Math.max(1, Math.round((p.amount / 100) * 0.012 * H * scaleH))); grain(c, p.amount * 0.22, L); break;
      case 'vhs': {
        const a = p.amount / 100;
        viaFilter(`saturate(${1 - 0.35 * a}) contrast(${1 + 0.15 * a}) brightness(${1 + 0.06 * a}) blur(${(0.6 * a + 0.1) * h / 1080}px)`);
        rgbShift(c, Math.max(1, Math.round(a * 0.006 * H * scaleH)));
        grain(c, a * 16, L);
        ctx.fillStyle = `rgba(0,0,0,${0.22 * a})`;
        const step = Math.max(2, Math.round(h / 270));
        for (let y = 0; y < h; y += step) ctx.fillRect(0, y, w, 1);
        break;
      }
      case 'grain': grain(c, p.amount * 0.4, L); break;
      case 'posterize': {
        const lv = Math.max(2, Math.round(p.levels)) - 1;
        pixels(c, (d) => { for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = Math.round(Math.round((d[i + k] / 255) * lv) * 255 / lv); });
        break;
      }
      case 'tint': {
        const col = Math.round(p.color), r = ((col >> 16) & 255) / 255, g = ((col >> 8) & 255) / 255, b = (col & 255) / 255, a = p.amount / 100;
        pixels(c, (d) => {
          for (let i = 0; i < d.length; i += 4) {
            const R = d[i], G = d[i + 1], B = d[i + 2];
            const l = 0.299 * R + 0.587 * G + 0.114 * B;
            d[i] = R * (1 - a) + a * r * l; d[i + 1] = G * (1 - a) + a * g * l; d[i + 2] = B * (1 - a) + a * b * l;
          }
        });
        break;
      }
      case 'edges': {
        pixels(c, (d, W2, H2) => {
          const src = new Uint8ClampedArray(d);
          const lum = (x: number, y: number) => { const i = (Math.min(H2 - 1, Math.max(0, y)) * W2 + Math.min(W2 - 1, Math.max(0, x))) * 4; return (src[i] + src[i + 1] + src[i + 2]) / 3; };
          const th = (p.low / 100) * 255;
          for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
            const gx = lum(x + 1, y) - lum(x - 1, y), gy = lum(x, y + 1) - lum(x, y - 1);
            const m = Math.min(255, Math.hypot(gx, gy) * 2);
            const i = (y * W2 + x) * 4;
            const k = m > th ? m / 255 : 0;
            d[i] = src[i] * k; d[i + 1] = src[i + 1] * k; d[i + 2] = src[i + 2] * k;
          }
        }, 480);
        break;
      }
      case 'letterbox': {
        const bh = (p.size / 100) * h;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, bh); ctx.fillRect(0, h - bh, w, bh);
        break;
      }
      case 'strobe':
        if (Math.round(L) % Math.max(1, Math.round(p.every)) < 1) viaFilter(`brightness(${1 + (p.amount / 100) * 1.2})`);
        break;
      case 'chromakey':
      case 'lumakey': {
        const col = e.type === 'chromakey' ? Math.round(p.color) : 0;
        const kr = (col >> 16) & 255, kg = (col >> 8) & 255, kb = col & 255;
        const sim = (e.type === 'chromakey' ? p.similarity : p.threshold) / 100, bl = Math.max(0.001, p.blend / 100);
        // distance in UV (chroma) space for chroma key, in luma for luma key — like ffmpeg chromakey/colorkey
        const uv = (r: number, g: number, b: number) => [-0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];
        const [ku, kv] = uv(kr, kg, kb);
        pixels(c, (d) => {
          for (let i = 0; i < d.length; i += 4) {
            let dist: number;
            if (e.type === 'chromakey') { const [u, v] = uv(d[i], d[i + 1], d[i + 2]); dist = Math.hypot(u - ku, v - kv) / 255; }
            else dist = Math.hypot(d[i], d[i + 1], d[i + 2]) / 255 / Math.sqrt(3);
            const a = Math.min(1, Math.max(0, (dist - sim) / bl));
            d[i + 3] = d[i + 3] * a;
          }
        }, 640);
        break;
      }
    }
  }
}

function pixels(c: HTMLCanvasElement, fn: (d: Uint8ClampedArray, w: number, h: number) => void, maxW = 960) {
  const ctx = ctx2(c);
  if (c.width <= maxW) {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    fn(img.data, c.width, c.height);
    ctx.putImageData(img, 0, 0);
    return;
  }
  // work at reduced size for speed, then scale back up
  const k = maxW / c.width;
  const w = Math.round(c.width * k), h = Math.round(c.height * k);
  const t = tmpCanvas(w, h);
  const tc = ctx2(t);
  tc.clearRect(0, 0, w, h);
  tc.drawImage(c, 0, 0, w, h);
  const img = tc.getImageData(0, 0, w, h);
  fn(img.data, w, h);
  tc.putImageData(img, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(t, 0, 0, c.width, c.height);
  release(t);
}

function rgbShift(c: HTMLCanvasElement, px: number) {
  if (!px) return;
  pixels(c, (d, w, h) => {
    const src = new Uint8ClampedArray(d);
    const s = Math.round(px * (w / c.width));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const xr = Math.min(w - 1, Math.max(0, x + s)), xb = Math.min(w - 1, Math.max(0, x - s));
      d[i] = src[(y * w + xr) * 4];
      d[i + 2] = src[(y * w + xb) * 4 + 2];
    }
  });
}

const noiseTiles: HTMLCanvasElement[] = [];
function grain(c: HTMLCanvasElement, strength: number, L: number) {
  if (strength <= 0) return;
  if (!noiseTiles.length) {
    for (let k = 0; k < 6; k++) {
      const t = document.createElement('canvas');
      t.width = 256; t.height = 256;
      const tc = t.getContext('2d')!;
      const img = tc.createImageData(256, 256);
      for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
      tc.putImageData(img, 0, 0);
      noiseTiles.push(t);
    }
  }
  const ctx = ctx2(c);
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = Math.min(1, strength / 40);
  const tile = noiseTiles[Math.abs(Math.round(L)) % noiseTiles.length];
  const pat = ctx.createPattern(tile, 'repeat')!;
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.restore();
}

/** a blurred, darkened "cover" copy of the frame behind the clip (vertical video fill) */
export function drawBlurFill(ctx: CanvasRenderingContext2D, src: CanvasImageSource, iw: number, ih: number, W: number, H: number, params: Record<string, number>) {
  const k = Math.max(W / iw, H / ih);
  const w = iw * k, h = ih * k;
  ctx.save();
  ctx.filter = `blur(${(params.blur / 100) * H}px) brightness(${1 - (params.dim / 100) * 0.5})`;
  ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
  ctx.restore();
}

// ------------------------------------------------------------------ transitions

const ease = (x: number) => x;

/** draw the transition from A to B at progress p (0 = all A, 1 = all B) */
export function drawTransition(ctx: CanvasRenderingContext2D, A: HTMLCanvasElement, B: HTMLCanvasElement, type: string, pIn: number) {
  const W = A.width, H = A.height;
  const p = Math.max(0, Math.min(1, ease(pIn)));
  const x = TRANSITION_BY_ID[type]?.xfade ?? 'fade';
  const both = (a: number, b: number) => { ctx.globalAlpha = a; ctx.drawImage(A, 0, 0); ctx.globalAlpha = b; ctx.drawImage(B, 0, 0); ctx.globalAlpha = 1; };
  const clipB = (path: () => void) => { ctx.drawImage(A, 0, 0); ctx.save(); ctx.beginPath(); path(); ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore(); };
  switch (x) {
    case 'fade': case 'fadefast': case 'fadeslow': case 'distance': both(1, p); break;
    case 'fadeblack': case 'fadewhite': {
      ctx.drawImage(p < 0.5 ? A : B, 0, 0);
      ctx.fillStyle = x === 'fadeblack' ? '#000' : '#fff';
      ctx.globalAlpha = p < 0.5 ? p * 2 : (1 - p) * 2;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      break;
    }
    case 'fadegrays': {
      ctx.filter = `grayscale(${1 - Math.abs(p - 0.5) * 2})`;
      both(1, p);
      ctx.filter = 'none';
      break;
    }
    case 'hblur': {
      ctx.filter = `blur(${Math.sin(p * Math.PI) * H * 0.02}px)`;
      both(1, p);
      ctx.filter = 'none';
      break;
    }
    case 'pixelize': {
      const blk = 1 + Math.sin(p * Math.PI) * 48;
      const sw = Math.max(2, Math.round(W / blk)), sh = Math.max(2, Math.round(H / blk));
      const t = tmpCanvas(sw, sh);
      const tc = ctx2(t);
      tc.globalAlpha = 1; tc.drawImage(A, 0, 0, sw, sh);
      tc.globalAlpha = p; tc.drawImage(B, 0, 0, sw, sh); tc.globalAlpha = 1;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(t, 0, 0, W, H);
      ctx.imageSmoothingEnabled = true;
      release(t);
      break;
    }
    case 'dissolve': case 'hlwind': case 'hrwind': {
      const gw = 96, gh = Math.max(2, Math.round((96 * H) / W));
      const mask = tmpCanvas(gw, gh);
      const mc = ctx2(mask);
      const img = mc.createImageData(gw, gh);
      for (let yy = 0; yy < gh; yy++) for (let xx = 0; xx < gw; xx++) {
        const i = (yy * gw + xx) * 4;
        const hsh = (Math.sin(xx * 12.9898 + yy * 78.233) * 43758.5453) % 1;
        const r = Math.abs(hsh);
        const v = x === 'dissolve' ? r : (xx / gw) * 0.7 + r * 0.3;
        img.data[i + 3] = v < p ? 255 : 0;
      }
      mc.putImageData(img, 0, 0);
      const t = tmpCanvas(W, H);
      const tc = ctx2(t);
      tc.clearRect(0, 0, W, H);
      tc.imageSmoothingEnabled = false;
      tc.drawImage(mask, 0, 0, W, H);
      tc.globalCompositeOperation = 'source-in';
      tc.drawImage(B, 0, 0);
      tc.globalCompositeOperation = 'source-over';
      ctx.drawImage(A, 0, 0);
      ctx.drawImage(t, 0, 0);
      release(t); release(mask);
      break;
    }
    case 'wipeleft': clipB(() => ctx.rect(W * (1 - p), 0, W * p, H)); break;
    case 'wiperight': clipB(() => ctx.rect(0, 0, W * p, H)); break;
    case 'wipeup': clipB(() => ctx.rect(0, H * (1 - p), W, H * p)); break;
    case 'wipedown': clipB(() => ctx.rect(0, 0, W, H * p)); break;
    case 'smoothleft': case 'smoothright': {
      const t = tmpCanvas(W, H);
      const tc = ctx2(t);
      tc.clearRect(0, 0, W, H);
      const g = x === 'smoothleft' ? tc.createLinearGradient(W, 0, 0, 0) : tc.createLinearGradient(0, 0, W, 0);
      const e = p * 1.4 - 0.2;
      g.addColorStop(Math.max(0, Math.min(1, e - 0.2)), 'rgba(0,0,0,1)');
      g.addColorStop(Math.max(0, Math.min(1, e + 0.2)), 'rgba(0,0,0,0)');
      tc.fillStyle = g; tc.fillRect(0, 0, W, H);
      tc.globalCompositeOperation = 'source-in';
      tc.drawImage(B, 0, 0);
      tc.globalCompositeOperation = 'source-over';
      ctx.drawImage(A, 0, 0); ctx.drawImage(t, 0, 0);
      release(t);
      break;
    }
    case 'diagtl': clipB(() => { const d = (W + H) * p; ctx.moveTo(0, 0); ctx.lineTo(Math.min(W, d), 0); ctx.lineTo(Math.max(0, d - H), d > H ? H : d); ctx.lineTo(0, Math.min(H, d)); ctx.closePath(); }); break;
    case 'diagbr': clipB(() => { const d = (W + H) * p; ctx.moveTo(W, H); ctx.lineTo(W - Math.min(W, d), H); ctx.lineTo(W, H - Math.min(H, d)); ctx.closePath(); if (d > Math.min(W, H)) { ctx.rect(Math.max(0, W - d), Math.max(0, H - d), W, H); } }); break;
    case 'radial': clipB(() => { ctx.moveTo(W / 2, H / 2); ctx.arc(W / 2, H / 2, Math.hypot(W, H), -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.closePath(); }); break;
    case 'circleopen': clipB(() => ctx.arc(W / 2, H / 2, (Math.hypot(W, H) / 2) * p, 0, Math.PI * 2)); break;
    case 'circleclose': { ctx.drawImage(B, 0, 0); ctx.save(); ctx.beginPath(); ctx.arc(W / 2, H / 2, (Math.hypot(W, H) / 2) * (1 - p), 0, Math.PI * 2); ctx.clip(); ctx.drawImage(A, 0, 0); ctx.restore(); break; }
    case 'horzopen': clipB(() => ctx.rect(0, (H / 2) * (1 - p), W, H * p)); break;
    case 'vertopen': clipB(() => ctx.rect((W / 2) * (1 - p), 0, W * p, H)); break;
    case 'rectcrop': clipB(() => ctx.rect((W / 2) * (1 - p), (H / 2) * (1 - p), W * p, H * p)); break;
    case 'hlslice': clipB(() => { const n = 8; for (let k = 0; k < n; k++) { const pp = Math.max(0, Math.min(1, p * 1.5 - (k / n) * 0.5)); ctx.rect((W / n) * k, 0, (W / n) * pp, H); } }); break;
    case 'slideleft': ctx.drawImage(A, -W * p, 0); ctx.drawImage(B, W * (1 - p), 0); break;
    case 'slideright': ctx.drawImage(A, W * p, 0); ctx.drawImage(B, -W * (1 - p), 0); break;
    case 'slideup': ctx.drawImage(A, 0, -H * p); ctx.drawImage(B, 0, H * (1 - p)); break;
    case 'slidedown': ctx.drawImage(A, 0, H * p); ctx.drawImage(B, 0, -H * (1 - p)); break;
    case 'coverleft': ctx.drawImage(A, 0, 0); ctx.drawImage(B, W * (1 - p), 0); break;
    case 'revealright': ctx.drawImage(B, 0, 0); ctx.drawImage(A, W * p, 0); break;
    case 'squeezeh': {
      if (p < 0.5) { const k = 1 - p * 2; ctx.drawImage(A, (W * (1 - k)) / 2, 0, W * k, H); }
      else { const k = (p - 0.5) * 2; ctx.drawImage(B, (W * (1 - k)) / 2, 0, W * k, H); }
      break;
    }
    case 'zoomin': {
      const z = 1 + p * 0.8;
      ctx.drawImage(A, (W - W * z) / 2, (H - H * z) / 2, W * z, H * z);
      ctx.globalAlpha = p; ctx.drawImage(B, 0, 0); ctx.globalAlpha = 1;
      break;
    }
    default: both(1, p);
  }
}
