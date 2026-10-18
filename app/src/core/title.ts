// Titles (Type tool). A title is a generated transparent image the size of the
// frame; the clip that shows it gets every normal clip feature (keyframes,
// opacity, speed, transitions...). The design data lives on the media item so
// the image can be regenerated when it is edited.

export interface TitleData {
  text: string;
  font: string;
  weight: 400 | 600 | 700 | 800 | 900;
  /** % of frame height */
  size: number;
  color: string;
  align: 'left' | 'center' | 'right';
  /** anchor position as % of the frame (0..100) */
  x: number;
  y: number;
  lineHeight: number;
  letterSpacing: number; // px at 1080p
  uppercase: boolean;
  stroke: string;
  strokeWidth: number; // % of size
  shadow: boolean;
  box: boolean;
  boxColor: string;
  boxOpacity: number;
  boxPadding: number; // % of size
  boxRadius: number; // % of size
}

export const TITLE_FONTS = ['Montserrat', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Impact', 'Verdana', 'Trebuchet MS', 'Courier New'];

const base: TitleData = {
  text: 'Başlık', font: 'Montserrat', weight: 800, size: 9, color: '#ffffff', align: 'center', x: 50, y: 50,
  lineHeight: 1.12, letterSpacing: 0, uppercase: false, stroke: '#000000', strokeWidth: 0, shadow: true,
  box: false, boxColor: '#000000', boxOpacity: 0.7, boxPadding: 35, boxRadius: 18,
};

export const TITLE_PRESETS: { id: string; name: string; data: TitleData }[] = [
  { id: 'baslik', name: 'Büyük başlık', data: { ...base } },
  { id: 'alt-bant', name: 'Alt bant (isim/unvan)', data: { ...base, text: 'Ad Soyad\nUnvan', weight: 700, size: 4.4, align: 'left', x: 8, y: 80, box: true, boxColor: '#111111', boxOpacity: 0.78, boxPadding: 45, boxRadius: 10, shadow: false } },
  { id: 'kanca', name: 'Sosyal kanca', data: { ...base, text: 'BUNU KAÇIRMA!', weight: 900, size: 8, uppercase: true, color: '#ffd400', stroke: '#000000', strokeWidth: 16, y: 22 } },
  { id: 'etiket', name: 'Etiket / fiyat', data: { ...base, text: '₺149', weight: 900, size: 7, color: '#1a0a04', box: true, boxColor: '#ff6a3d', boxOpacity: 1, boxPadding: 30, boxRadius: 40, shadow: false, x: 80, y: 18 } },
  { id: 'altyazi-ust', name: 'Üst yazı (konum)', data: { ...base, text: '📍 Ankara', weight: 600, size: 3.6, x: 50, y: 8, box: true, boxColor: '#000000', boxOpacity: 0.45, boxPadding: 50, boxRadius: 50, shadow: false } },
  { id: 'sade', name: 'Sade metin', data: { ...base, weight: 400, size: 5, shadow: false } },
];

export function titleLines(d: TitleData): string[] {
  const t = d.uppercase ? d.text.toLocaleUpperCase('tr-TR') : d.text;
  return t.split('\n');
}

/** stable key of a design, used to name the rendered image */
export function titleKey(d: TitleData, w: number, h: number): string {
  const s = JSON.stringify([d, w, h]);
  let hsh = 2166136261;
  for (let i = 0; i < s.length; i++) { hsh ^= s.charCodeAt(i); hsh = Math.imul(hsh, 16777619); }
  return (hsh >>> 0).toString(36);
}
