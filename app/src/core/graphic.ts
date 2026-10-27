// Graphics (Essential-Graphics style): a stack of layers — text, rectangles,
// ellipses, polygons, lines — each with fill (solid or gradient), any number of
// strokes and shadows. Rendered to a transparent frame-sized image, so a
// graphic clip gets every normal clip feature (motion, keyframes, transitions,
// effects) and preview = export.
//
// Units: positions are % of the frame (0..100, layer centre); every length is
// in "pixels at 1080p" and scales with the frame height.

import type { TitleData } from './title';

export interface Fill { color: string; opacity: number; gradient?: { to: string; angle: number } | null }
export interface Stroke { color: string; width: number; opacity: number }
export interface Shadow { color: string; opacity: number; blur: number; dx: number; dy: number }

interface LayerBase {
  id: string;
  name: string;
  x: number;
  y: number;
  rotation: number;
  opacity: number; // 0..100
  hidden?: boolean;
  fill: Fill | null;
  strokes: Stroke[];
  shadows: Shadow[];
}

export interface TextLayer extends LayerBase {
  kind: 'text';
  text: string;
  font: string;
  weight: number;
  italic: boolean;
  size: number; // px @1080
  tracking: number; // px @1080 between letters
  leading: number; // line height multiplier
  align: 'left' | 'center' | 'right';
  uppercase: boolean;
  underline: boolean;
  /** wrap width, % of frame width (0 = no wrapping) */
  wrap: number;
  box: { color: string; opacity: number; padding: number; radius: number } | null;
}

export interface ShapeLayer extends LayerBase {
  kind: 'rect' | 'ellipse' | 'polygon' | 'line';
  w: number; // px @1080
  h: number;
  radius: number; // rect corner radius px @1080
  sides: number; // polygon
}

export type GLayer = TextLayer | ShapeLayer;
export interface GraphicData { v: 2; layers: GLayer[] }

export const isGraphic = (t: unknown): t is GraphicData => !!t && (t as GraphicData).v === 2 && Array.isArray((t as GraphicData).layers);

let seq = 0;
export const layerId = () => `L${Date.now().toString(36)}${(seq++).toString(36)}`;

export function textLayer(p: Partial<TextLayer> = {}): TextLayer {
  return {
    id: layerId(), name: 'Metin', kind: 'text', x: 50, y: 50, rotation: 0, opacity: 100,
    fill: { color: '#ffffff', opacity: 1, gradient: null }, strokes: [], shadows: [{ color: '#000000', opacity: 0.55, blur: 12, dx: 0, dy: 5 }],
    text: 'Metin', font: 'Montserrat', weight: 800, italic: false, size: 96, tracking: 0, leading: 1.12, align: 'center',
    uppercase: false, underline: false, wrap: 0, box: null, ...p,
  };
}

export function shapeLayer(kind: ShapeLayer['kind'], p: Partial<ShapeLayer> = {}): ShapeLayer {
  const names = { rect: 'Dikdörtgen', ellipse: 'Elips', polygon: 'Çokgen', line: 'Çizgi' };
  return {
    id: layerId(), name: names[kind], kind, x: 50, y: 50, rotation: 0, opacity: 100,
    fill: kind === 'line' ? null : { color: '#ff6a3d', opacity: 1, gradient: null },
    strokes: kind === 'line' ? [{ color: '#ffffff', width: 8, opacity: 1 }] : [], shadows: [],
    w: kind === 'line' ? 600 : 520, h: kind === 'line' ? 0 : 300, radius: kind === 'rect' ? 24 : 0, sides: 6, ...p,
  };
}

/** the old single-text title as a one-layer graphic */
export function fromTitle(t: TitleData): GraphicData {
  const size = (t.size / 100) * 1080;
  return {
    v: 2,
    layers: [textLayer({
      text: t.text, font: t.font, weight: t.weight, size, align: t.align, x: t.x, y: t.y, leading: t.lineHeight,
      tracking: t.letterSpacing, uppercase: t.uppercase,
      fill: { color: t.color, opacity: 1, gradient: null },
      strokes: t.strokeWidth > 0 ? [{ color: t.stroke, width: (t.strokeWidth / 100) * size * 2, opacity: 1 }] : [],
      shadows: t.shadow ? [{ color: '#000000', opacity: 0.55, blur: size * 0.12, dx: 0, dy: size * 0.05 }] : [],
      box: t.box ? { color: t.boxColor, opacity: t.boxOpacity, padding: (t.boxPadding / 100) * size, radius: (t.boxRadius / 100) * size } : null,
    })],
  };
}

export const asGraphic = (t: TitleData | GraphicData): GraphicData => (isGraphic(t) ? t : fromTitle(t));

/** first text of a graphic, for clip names */
export function graphicLabel(g: GraphicData): string {
  const t = g.layers.find((l): l is TextLayer => l.kind === 'text' && !!l.text.trim());
  return (t?.text.split('\n')[0] ?? g.layers[0]?.name ?? 'Grafik').slice(0, 24);
}

// ------------------------------------------------------------------ templates

const T = (p: Partial<TextLayer>) => textLayer(p);
const S = (k: ShapeLayer['kind'], p: Partial<ShapeLayer>) => shapeLayer(k, p);

export const GRAPHIC_TEMPLATES: { id: string; name: string; group: string; make: () => GraphicData }[] = [
  { id: 'big', name: 'Büyük başlık', group: 'Başlık', make: () => ({ v: 2, layers: [T({ text: 'Başlık', size: 110 })] }) },
  { id: 'hook', name: 'Sosyal kanca', group: 'Sosyal', make: () => ({ v: 2, layers: [T({ text: 'BUNU KAÇIRMA!', uppercase: true, weight: 900, size: 92, y: 22, fill: { color: '#ffd400', opacity: 1 }, strokes: [{ color: '#000000', width: 14, opacity: 1 }], shadows: [{ color: '#000000', opacity: 0.6, blur: 0, dx: 0, dy: 8 }] })] }) },
  { id: 'lower', name: 'Alt bant (isim + unvan)', group: 'Alt bant', make: () => ({ v: 2, layers: [
    S('rect', { name: 'Bant', x: 24, y: 82, w: 760, h: 150, radius: 14, fill: { color: '#111111', opacity: 0.82 } }),
    S('rect', { name: 'Vurgu', x: 4.6, y: 82, w: 12, h: 150, radius: 6, fill: { color: '#ff6a3d', opacity: 1 } }),
    T({ name: 'İsim', text: 'Ad Soyad', align: 'left', x: 6.3, y: 79.4, size: 50, weight: 800, shadows: [] }),
    T({ name: 'Unvan', text: 'Unvan / Şirket', align: 'left', x: 6.3, y: 85.4, size: 32, weight: 500, fill: { color: '#cfcfcf', opacity: 1 }, shadows: [] }),
  ] }) },
  { id: 'lower-glass', name: 'Alt bant (cam)', group: 'Alt bant', make: () => ({ v: 2, layers: [
    S('rect', { name: 'Cam', x: 50, y: 85, w: 900, h: 120, radius: 60, fill: { color: '#ffffff', opacity: 0.16 }, strokes: [{ color: '#ffffff', width: 2, opacity: 0.4 }] }),
    T({ text: 'Ad Soyad · Unvan', y: 85, size: 46, weight: 700, shadows: [] }),
  ] }) },
  { id: 'price', name: 'Fiyat etiketi', group: 'Sosyal', make: () => ({ v: 2, layers: [
    S('ellipse', { name: 'Rozet', x: 80, y: 22, w: 300, h: 300, fill: { color: '#ff6a3d', opacity: 1, gradient: { to: '#ff2d55', angle: 135 } }, shadows: [{ color: '#000000', opacity: 0.35, blur: 24, dx: 0, dy: 10 }] }),
    T({ text: '₺149', x: 80, y: 21, size: 92, weight: 900, rotation: -8, shadows: [] }),
    T({ name: 'Üst yazı', text: 'SADECE', x: 80, y: 14.5, size: 26, weight: 800, tracking: 4, rotation: -8, shadows: [] }),
  ] }) },
  { id: 'location', name: 'Konum etiketi', group: 'Sosyal', make: () => ({ v: 2, layers: [T({ text: '📍 Ankara', y: 8, size: 40, weight: 600, shadows: [], box: { color: '#000000', opacity: 0.45, padding: 22, radius: 40 } })] }) },
  { id: 'subscribe', name: 'Takip et / Abone ol', group: 'Sosyal', make: () => ({ v: 2, layers: [
    S('rect', { name: 'Buton', x: 50, y: 86, w: 520, h: 120, radius: 60, fill: { color: '#ff2d2d', opacity: 1 }, shadows: [{ color: '#000000', opacity: 0.4, blur: 20, dx: 0, dy: 8 }] }),
    T({ text: 'TAKİP ET', y: 86, size: 54, weight: 900, tracking: 3, shadows: [] }),
  ] }) },
  { id: 'quote', name: 'Alıntı', group: 'Başlık', make: () => ({ v: 2, layers: [
    T({ name: 'Tırnak', text: '“', y: 34, size: 260, weight: 900, fill: { color: '#ff6a3d', opacity: 1 }, shadows: [] }),
    T({ text: 'Burada kısa ve etkili\nbir alıntı yer alır.', y: 52, size: 64, weight: 600, italic: true, shadows: [] }),
    T({ name: 'Kaynak', text: '— Ad Soyad', y: 66, size: 34, weight: 500, fill: { color: '#bbbbbb', opacity: 1 }, shadows: [] }),
  ] }) },
  { id: 'chapter', name: 'Bölüm başlığı', group: 'Başlık', make: () => ({ v: 2, layers: [
    T({ name: 'Numara', text: '01', y: 40, size: 160, weight: 900, fill: { color: '#ffffff', opacity: 1, gradient: { to: '#ff6a3d', angle: 90 } }, shadows: [] }),
    S('line', { y: 51, w: 220, strokes: [{ color: '#ff6a3d', width: 6, opacity: 1 }] }),
    T({ text: 'BÖLÜM ADI', y: 58, size: 48, weight: 800, tracking: 10, shadows: [] }),
  ] }) },
  { id: 'news', name: 'Haber bandı', group: 'Alt bant', make: () => ({ v: 2, layers: [
    S('rect', { name: 'Bant', x: 50, y: 90, w: 1920, h: 110, radius: 0, fill: { color: '#0a2a6b', opacity: 0.95 } }),
    S('rect', { name: 'Etiket', x: 8, y: 90, w: 300, h: 110, radius: 0, fill: { color: '#e01b24', opacity: 1 } }),
    T({ name: 'Etiket yazısı', text: 'SON DAKİKA', x: 8, y: 90, size: 40, weight: 900, shadows: [] }),
    T({ text: 'Haber metni buraya gelir', align: 'left', x: 17, y: 90, size: 44, weight: 600, shadows: [] }),
  ] }) },
  { id: 'neon', name: 'Neon yazı', group: 'Başlık', make: () => ({ v: 2, layers: [T({ text: 'GECE', size: 150, weight: 900, tracking: 8, fill: { color: '#fff0ff', opacity: 1 }, strokes: [{ color: '#ff3df2', width: 6, opacity: 1 }], shadows: [{ color: '#ff3df2', opacity: 0.9, blur: 30, dx: 0, dy: 0 }, { color: '#7a3dff', opacity: 0.8, blur: 70, dx: 0, dy: 0 }] })] }) },
  { id: 'outline', name: 'Çift konturlu', group: 'Başlık', make: () => ({ v: 2, layers: [T({ text: 'ŞOV', size: 170, weight: 900, fill: { color: '#ffd400', opacity: 1 }, strokes: [{ color: '#000000', width: 12, opacity: 1 }, { color: '#ffffff', width: 26, opacity: 1 }], shadows: [{ color: '#000000', opacity: 0.5, blur: 0, dx: 10, dy: 12 }] })] }) },
];

// ------------------------------------------------------------------ in / out animation presets (as clip keyframes)

export const TEXT_ANIMS: { id: string; name: string }[] = [
  { id: 'none', name: 'Yok' },
  { id: 'fade', name: 'Belirerek' },
  { id: 'up', name: 'Aşağıdan kayarak' },
  { id: 'down', name: 'Yukarıdan kayarak' },
  { id: 'left', name: 'Soldan kayarak' },
  { id: 'pop', name: 'Patlayarak (pop)' },
  { id: 'zoom', name: 'Uzaktan yaklaşarak' },
];
