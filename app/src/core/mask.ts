// Opacity masks (ellipse / rectangle / free polygon) with feather, expansion,
// opacity, invert and add/subtract/intersect. A clip's masks are rasterised
// once into a greyscale alpha image (renderer, canvas) at the source size; the
// preview multiplies the frame with it and the export alphamerges the very same
// image, so both agree pixel for pixel.

export type MaskShape = 'ellipse' | 'rect' | 'poly';
export type MaskMode = 'add' | 'subtract' | 'intersect';

export interface Mask {
  id: string;
  shape: MaskShape;
  /** normalised source coordinates (0..1). ellipse/rect: [centre, corner offset (half size)]; poly: vertices */
  pts: [number, number][];
  /** px at source resolution */
  feather: number;
  /** px; negative shrinks */
  expansion: number;
  /** 0..100 */
  opacity: number;
  invert: boolean;
  mode: MaskMode;
  name?: string;
}

export const MASK_MODES: { id: MaskMode; name: string }[] = [
  { id: 'add', name: 'Ekle' }, { id: 'subtract', name: 'Çıkar' }, { id: 'intersect', name: 'Kesiştir' },
];

export function newMask(shape: MaskShape, id: string, n: number): Mask {
  const base = { id, shape, feather: 10, expansion: 0, opacity: 100, invert: false, mode: 'add' as MaskMode, name: `Maske ${n}` };
  if (shape === 'poly') return { ...base, pts: [[0.5, 0.25], [0.75, 0.5], [0.5, 0.75], [0.25, 0.5]] };
  return { ...base, pts: [[0.5, 0.5], [0.22, 0.28]] };
}

/** polygon in source pixels for drawing (ellipse/rect described by centre + half size) */
export function maskOutline(m: Mask, w: number, h: number): { kind: 'ellipse' | 'poly'; cx?: number; cy?: number; rx?: number; ry?: number; pts?: [number, number][] } {
  if (m.shape === 'ellipse') {
    const [[cx, cy], [hx, hy]] = m.pts;
    return { kind: 'ellipse', cx: cx * w, cy: cy * h, rx: Math.abs(hx) * w, ry: Math.abs(hy) * h };
  }
  if (m.shape === 'rect') {
    const [[cx, cy], [hx, hy]] = m.pts;
    const ax = Math.abs(hx), ay = Math.abs(hy);
    return { kind: 'poly', pts: [[cx - ax, cy - ay], [cx + ax, cy - ay], [cx + ax, cy + ay], [cx - ax, cy + ay]].map(([x, y]) => [x * w, y * h]) as [number, number][] };
  }
  return { kind: 'poly', pts: m.pts.map(([x, y]) => [x * w, y * h]) as [number, number][] };
}

/** identifies a rasterised mask image */
export function maskKey(masks: Mask[] | undefined, w: number, h: number): string {
  const s = JSON.stringify([w, h, (masks ?? []).map((m) => [m.shape, m.pts.map((p) => p.map((v) => Math.round(v * 1e5))), m.feather, m.expansion, m.opacity, m.invert, m.mode])]);
  let a = 5381, b = 52711;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = (a * 33) ^ c; b = (b * 31) ^ c; }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}-${w}x${h}`;
}

export function activeMasks(c: { masks?: Mask[] }): Mask[] {
  return (c.masks ?? []).filter((m) => m.opacity > 0 || m.mode !== 'add');
}

/** the clip's rasterised mask, if it is current */
export function maskImageFor(c: { masks?: Mask[]; maskImage?: { key: string; path: string } }, sw: number, sh: number): string | null {
  if (!activeMasks(c).length || !c.maskImage) return null;
  return c.maskImage.key === maskKey(c.masks, sw, sh) ? c.maskImage.path : null;
}
