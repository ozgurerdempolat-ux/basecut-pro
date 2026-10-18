// Colour grading. Every grade is baked into a 3D LUT: the preview applies it on
// the GPU, the export applies the very same table with ffmpeg's lut3d, so what
// you see is exactly what you get. Values work on display-referred RGB 0..1.

export interface RGB { r: number; g: number; b: number }

export interface ColorGrade {
  // basic correction
  temperature: number; // -100..100 (blue ← → amber)
  tint: number; // -100..100 (green ← → magenta)
  exposure: number; // stops, -4..4
  contrast: number; // -100..100
  highlights: number; // -100..100
  shadows: number; // -100..100
  whites: number; // -100..100
  blacks: number; // -100..100
  saturation: number; // 0..200 (%)
  vibrance: number; // -100..100
  // colour wheels: offsets in -1..1 per channel
  lift: RGB;
  gamma: RGB;
  gain: RGB;
  // creative
  look: string | null; // id of a built-in look
  lookIntensity: number; // 0..100
  fade: number; // 0..100 (lifted blacks, film look)
  lutPath: string | null; // user .cube
  lutIntensity: number; // 0..100
  vignette: number; // -100..100 (negative darkens edges)
}

const zero: RGB = { r: 0, g: 0, b: 0 };

export function neutralGrade(): ColorGrade {
  return {
    temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    saturation: 100, vibrance: 0, lift: { ...zero }, gamma: { ...zero }, gain: { ...zero },
    look: null, lookIntensity: 100, fade: 0, lutPath: null, lutIntensity: 100, vignette: 0,
  };
}

export function isNeutral(g: ColorGrade | undefined | null): boolean {
  if (!g) return true;
  const n = neutralGrade();
  return JSON.stringify({ ...g, vignette: 0 }) === JSON.stringify({ ...n, vignette: 0 });
}

const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const toLin = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const toGam = (x: number) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(Math.max(0, x), 1 / 2.4) - 0.055);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ------------------------------------------------------------------ built-in looks (original, not copies)

export const LOOKS: Record<string, { name: string; apply: (r: number, g: number, b: number) => [number, number, number] }> = {
  sicak: { name: 'Sıcak gün', apply: (r, g, b) => [r * 1.06 + 0.02, g * 1.01 + 0.01, b * 0.9] },
  soguk: { name: 'Soğuk sabah', apply: (r, g, b) => [r * 0.92, g * 0.99, b * 1.07 + 0.02] },
  'teal-turuncu': {
    name: 'Sinematik (teal & turuncu)',
    apply: (r, g, b) => {
      const l = luma(r, g, b);
      const s = smooth(0.0, 0.55, l); // 0 in shadows → 1 in highlights
      const tr = -0.06 * (1 - s) + 0.07 * s, tg = 0.02 * (1 - s) + 0.015 * s, tb = 0.08 * (1 - s) - 0.08 * s;
      return [r + tr, g + tg, b + tb];
    },
  },
  'siyah-beyaz': { name: 'Siyah beyaz', apply: (r, g, b) => { const l = luma(r, g, b); const c = (l - 0.5) * 1.12 + 0.5; return [c, c, c]; } },
  vintage: {
    name: 'Vintage film',
    apply: (r, g, b) => {
      const l = luma(r, g, b);
      const m = (x: number, k: number) => x * 0.86 + l * 0.14 + k;
      return [m(r, 0.04) * 0.97, m(g, 0.025), m(b, -0.01) * 0.93 + 0.05];
    },
  },
  canli: { name: 'Canlı yemek', apply: (r, g, b) => { const l = luma(r, g, b); const k = 1.28; return [l + (r - l) * k + 0.01, l + (g - l) * k, l + (b - l) * k - 0.01]; } },
  gece: { name: 'Gece kulübü', apply: (r, g, b) => { const l = luma(r, g, b); return [r * 1.04 + 0.03 * (1 - l), g * 0.9, b * 1.1 + 0.06 * (1 - l)]; } },
};

// ------------------------------------------------------------------ the grade itself

/** apply a grade to one pixel (0..1). `user` samples a loaded .cube when present. */
export function gradePixel(
  rIn: number, gIn: number, bIn: number, g: ColorGrade,
  user?: ((r: number, g: number, b: number) => [number, number, number]) | null,
): [number, number, number] {
  let r = rIn, gg = gIn, b = bIn;

  // white balance + exposure in linear light
  let lr = toLin(r), lg = toLin(gg), lb = toLin(b);
  const t = g.temperature / 100, ti = g.tint / 100;
  lr *= 1 + 0.32 * t;
  lb *= 1 - 0.32 * t;
  lg *= 1 - 0.22 * ti;
  const ex = Math.pow(2, g.exposure);
  lr *= ex; lg *= ex; lb *= ex;
  r = toGam(lr); gg = toGam(lg); b = toGam(lb);

  // tone: contrast around mid grey, then highlights/shadows/whites/blacks by luminance zone
  const cK = 1 + g.contrast / 100;
  const tone = (x: number, l: number) => {
    let y = (x - 0.5) * cK + 0.5;
    y += (g.highlights / 100) * 0.3 * smooth(0.45, 1.0, l) * (g.highlights < 0 ? y : 1 - y);
    y += (g.shadows / 100) * 0.3 * (1 - smooth(0.0, 0.55, l)) * (g.shadows > 0 ? 1 - y : y);
    y += (g.whites / 100) * 0.18 * smooth(0.6, 1.0, l);
    y += (g.blacks / 100) * 0.12 * (1 - smooth(0.0, 0.35, l));
    return y;
  };
  const l0 = luma(r, gg, b);
  r = tone(r, l0); gg = tone(gg, l0); b = tone(b, l0);

  // lift / gamma / gain wheels
  const wheel = (x: number, lift: number, gamma: number, gain: number) => {
    let y = x * (1 + gain * 0.5) + lift * 0.25 * (1 - x);
    y = Math.sign(y) * Math.pow(Math.abs(y), 1 / Math.max(0.2, 1 + gamma * 0.6));
    return y;
  };
  r = wheel(r, g.lift.r, g.gamma.r, g.gain.r);
  gg = wheel(gg, g.lift.g, g.gamma.g, g.gain.g);
  b = wheel(b, g.lift.b, g.gamma.b, g.gain.b);

  // saturation + vibrance
  const l1 = luma(r, gg, b);
  const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
  const sat = mx - mn;
  const vib = (g.vibrance / 100) * (1 - Math.min(1, sat * 1.6));
  const sK = (g.saturation / 100) * (1 + vib);
  r = l1 + (r - l1) * sK; gg = l1 + (gg - l1) * sK; b = l1 + (b - l1) * sK;

  // creative look
  if (g.look && LOOKS[g.look] && g.lookIntensity > 0) {
    const [a, c, d] = LOOKS[g.look].apply(clamp(r), clamp(gg), clamp(b));
    const k = g.lookIntensity / 100;
    r += (a - r) * k; gg += (c - gg) * k; b += (d - b) * k;
  }
  // user LUT
  if (user && g.lutIntensity > 0) {
    const [a, c, d] = user(clamp(r), clamp(gg), clamp(b));
    const k = g.lutIntensity / 100;
    r += (a - r) * k; gg += (c - gg) * k; b += (d - b) * k;
  }
  // fade: lift the floor
  if (g.fade) {
    const f = (g.fade / 100) * 0.16;
    r = f + r * (1 - f); gg = f + gg * (1 - f); b = f + b * (1 - f);
  }
  return [clamp(r), clamp(gg), clamp(b)];
}

// ------------------------------------------------------------------ LUTs

export interface Lut3D { size: number; data: Float32Array /* r fastest, then g, then b; rgb triplets */ }

export function parseCube(text: string): Lut3D {
  let size = 0;
  const vals: number[] = [];
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('DOMAIN_MIN')) { dmin = line.split(/\s+/).slice(1).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { dmax = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Z_]/.test(up)) continue; // TITLE, LUT_1D_SIZE...
    const p = line.split(/\s+/).map(Number);
    if (p.length >= 3 && p.every((x) => Number.isFinite(x))) vals.push(p[0], p[1], p[2]);
  }
  if (!size || vals.length < size * size * size * 3) throw new Error('Geçersiz .cube dosyası (yalnızca 3D LUT desteklenir)');
  const data = new Float32Array(vals.slice(0, size * size * size * 3));
  // normalise custom domains to 0..1
  if (dmin.some((x) => x !== 0) || dmax.some((x) => x !== 1)) {
    for (let i = 0; i < data.length; i++) { const c = i % 3; data[i] = (data[i] - dmin[c]) / (dmax[c] - dmin[c]); }
  }
  return { size, data };
}

export function sampleLut(l: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const n = l.size - 1;
  const fr = clamp(r) * n, fg = clamp(g) * n, fb = clamp(b) * n;
  const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
  const r1 = Math.min(n, r0 + 1), g1 = Math.min(n, g0 + 1), b1 = Math.min(n, b0 + 1);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  const at = (ri: number, gi: number, bi: number, c: number) => l.data[((bi * l.size + gi) * l.size + ri) * 3 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - dr) + at(r1, g0, b0, c) * dr;
    const c10 = at(r0, g1, b0, c) * (1 - dr) + at(r1, g1, b0, c) * dr;
    const c01 = at(r0, g0, b1, c) * (1 - dr) + at(r1, g0, b1, c) * dr;
    const c11 = at(r0, g1, b1, c) * (1 - dr) + at(r1, g1, b1, c) * dr;
    out[c] = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
  }
  return out;
}

/** bake a grade (and an optional user LUT) into one table */
export function bakeLut(g: ColorGrade, size = 33, user?: Lut3D | null): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  const sampler = user ? (r: number, gg: number, b: number) => sampleLut(user, r, gg, b) : null;
  let i = 0;
  for (let bi = 0; bi < size; bi++) for (let gi = 0; gi < size; gi++) for (let ri = 0; ri < size; ri++) {
    const [r, gg, b] = gradePixel(ri / (size - 1), gi / (size - 1), bi / (size - 1), g, sampler);
    data[i++] = r; data[i++] = gg; data[i++] = b;
  }
  return { size, data };
}

export function toCube(l: Lut3D, title = 'BaseCut Pro grade'): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${l.size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let i = 0; i < l.data.length; i += 3) lines.push(`${l.data[i].toFixed(6)} ${l.data[i + 1].toFixed(6)} ${l.data[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/** cheap stable key for caching baked LUTs */
export function gradeKey(g: ColorGrade): string {
  const s = JSON.stringify(g);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// ------------------------------------------------------------------ automatic correction

/** auto exposure + white balance from a frame's pixels (RGBA bytes) */
export function autoGrade(rgba: Uint8ClampedArray | Uint8Array, base: ColorGrade = neutralGrade()): ColorGrade {
  let n = 0, sr = 0, sg = 0, sb = 0;
  const lums: number[] = [];
  for (let i = 0; i < rgba.length; i += 16) { // every 4th pixel
    const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
    sr += r; sg += g; sb += b; n++;
    lums.push(luma(r, g, b));
  }
  if (!n) return base;
  lums.sort((a, b) => a - b);
  const p = (q: number) => lums[Math.min(lums.length - 1, Math.floor(q * lums.length))];
  const lo = p(0.01), hi = p(0.99), mid = p(0.5);
  const ar = sr / n, ag = sg / n, ab = sb / n;
  const grey = (ar + ag + ab) / 3 || 0.5;
  const out = { ...base };
  // exposure: bring the median towards 0.45
  out.exposure = Math.max(-2, Math.min(2, Math.log2(toLin(0.45) / Math.max(1e-3, toLin(mid))) * 0.7));
  // white balance from the average cast (grey world)
  out.temperature = Math.max(-60, Math.min(60, ((ab - ar) / grey) * 120));
  out.tint = Math.max(-60, Math.min(60, ((ag - (ar + ab) / 2) / grey) * 150));
  // stretch to use the full range
  out.contrast = Math.max(-20, Math.min(30, (0.85 - (hi - lo)) * 60));
  return out;
}
