// Captions: grouping recognised words into readable lines, SRT/VTT in and out,
// and an animated ASS script that ffmpeg/libass burns into the export.
// Times are sequence frames, like everything else on the timeline.

import type { Id } from './model';

export interface CaptionWord { text: string; start: number; end: number }

export interface Caption {
  id: Id;
  start: number;
  end: number;
  text: string;
  /** word timings when known (automatic captions); drives the animations */
  words: CaptionWord[];
}

export type CaptionAnimation = 'none' | 'highlight' | 'pop' | 'karaoke' | 'word';

export interface CaptionStyle {
  preset: string;
  font: string;
  /** font size as % of the frame height */
  size: number;
  bold: boolean;
  uppercase: boolean;
  color: string; // #rrggbb
  highlight: string; // active word colour
  outline: string;
  outlineWidth: number; // % of size
  shadow: number; // px at 1080p
  box: boolean;
  boxColor: string;
  boxOpacity: number; // 0..1
  position: 'bottom' | 'middle' | 'top';
  /** distance from the edge as % of frame height */
  margin: number;
  maxChars: number; // per line
  maxLines: 1 | 2;
  animation: CaptionAnimation;
}

export interface CaptionTrackData {
  enabled: boolean;
  language: string;
  style: CaptionStyle;
  items: Caption[];
}

export const CAPTION_PRESETS: Record<string, Omit<CaptionStyle, 'preset'>> = {
  'sosyal-vurgu': { font: 'Montserrat', size: 6.2, bold: true, uppercase: true, color: '#ffffff', highlight: '#ffd400', outline: '#000000', outlineWidth: 14, shadow: 3, box: false, boxColor: '#000000', boxOpacity: 0.6, position: 'middle', margin: 22, maxChars: 18, maxLines: 2, animation: 'highlight' },
  'tek-kelime-pop': { font: 'Montserrat', size: 9, bold: true, uppercase: true, color: '#ffffff', highlight: '#ffffff', outline: '#000000', outlineWidth: 12, shadow: 4, box: false, boxColor: '#000000', boxOpacity: 0.6, position: 'middle', margin: 0, maxChars: 14, maxLines: 1, animation: 'word' },
  'karaoke': { font: 'Montserrat', size: 5.6, bold: true, uppercase: false, color: '#ffffff', highlight: '#3cff9a', outline: '#000000', outlineWidth: 12, shadow: 2, box: false, boxColor: '#000000', boxOpacity: 0.6, position: 'bottom', margin: 14, maxChars: 26, maxLines: 2, animation: 'karaoke' },
  'kutulu': { font: 'Montserrat', size: 4.6, bold: true, uppercase: false, color: '#ffffff', highlight: '#ff6a3d', outline: '#000000', outlineWidth: 0, shadow: 0, box: true, boxColor: '#000000', boxOpacity: 0.72, position: 'bottom', margin: 9, maxChars: 34, maxLines: 2, animation: 'pop' },
  'klasik': { font: 'Montserrat', size: 4.2, bold: false, uppercase: false, color: '#ffffff', highlight: '#ffffff', outline: '#000000', outlineWidth: 8, shadow: 2, box: false, boxColor: '#000000', boxOpacity: 0.6, position: 'bottom', margin: 7, maxChars: 42, maxLines: 2, animation: 'none' },
};

export const PRESET_NAMES: Record<string, string> = {
  'sosyal-vurgu': 'Sosyal – kelime vurgulu',
  'tek-kelime-pop': 'Tek kelime – pop',
  'karaoke': 'Karaoke dolgu',
  'kutulu': 'Kutulu – yumuşak giriş',
  'klasik': 'Klasik altyazı',
};

export function presetStyle(id: string): CaptionStyle {
  return { preset: id, ...(CAPTION_PRESETS[id] ?? CAPTION_PRESETS['sosyal-vurgu']) };
}

export function emptyCaptions(language = 'tr'): CaptionTrackData {
  return { enabled: true, language, style: presetStyle('sosyal-vurgu'), items: [] };
}

let cid = 0;
const newCaptionId = () => `cap_${Date.now().toString(36)}${(++cid).toString(36)}`;

// ------------------------------------------------------------------ grouping

/**
 * How many characters fit on one line for this style and frame size.
 * Bold uppercase is much wider than mixed case, so a fixed count overflows on
 * vertical video.
 */
export function fitChars(style: Pick<CaptionStyle, 'size' | 'uppercase' | 'bold' | 'maxChars'>, width: number, height: number): number {
  const px = (style.size / 100) * height;
  const perChar = px * (style.uppercase ? (style.bold ? 0.74 : 0.66) : (style.bold ? 0.58 : 0.52));
  const usable = width * 0.88;
  return Math.max(6, Math.min(style.maxChars, Math.floor(usable / perChar)));
}

/** a style with maxChars clamped to what fits the frame */
export function fitted(style: CaptionStyle, width: number, height: number): CaptionStyle {
  return { ...style, maxChars: fitChars(style, width, height) };
}

/**
 * Group words into captions: break on sentence punctuation, on pauses, when a
 * line would get too long, and keep each caption under ~4 seconds.
 * The one-word style puts every word in its own caption.
 */
export function groupWords(words: CaptionWord[], style: Pick<CaptionStyle, 'maxChars' | 'maxLines' | 'animation'>, fps: number): Caption[] {
  const clean = words.map((w) => ({ ...w, text: w.text.trim() })).filter((w) => w.text);
  if (style.animation === 'word') {
    return clean.map((w) => ({ id: newCaptionId(), start: w.start, end: Math.max(w.end, w.start + Math.round(fps * 0.25)), text: w.text, words: [w] }));
  }
  const out: Caption[] = [];
  const limit = style.maxChars * style.maxLines;
  const maxDur = Math.round(fps * 4.2);
  const pause = Math.round(fps * 0.6);
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ id: newCaptionId(), start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' '), words: cur });
    cur = [];
  };
  for (const w of clean) {
    if (cur.length) {
      const text = [...cur, w].map((x) => x.text).join(' ');
      const gap = w.start - cur[cur.length - 1].end;
      if (text.length > limit || gap > pause || w.end - cur[0].start > maxDur) flush();
    }
    cur.push(w);
    if (/[.!?…]$/.test(w.text)) flush();
  }
  flush();
  // no gaps shorter than a few frames between captions (avoids flicker), no overlaps
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i], b = out[i + 1];
    if (b.start - a.end < Math.round(fps * 0.2)) a.end = b.start;
    if (a.end > b.start) a.end = b.start;
    if (a.end <= a.start) a.end = a.start + 1;
  }
  return out;
}

/** split a caption's text into lines that respect maxChars */
export function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (maxLines === 1) return [words.join(' ')];
  const total = words.join(' ').length;
  if (total <= maxChars) return [words.join(' ')];
  // balanced split into two lines
  let best = 1, bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ').length;
    const b = words.slice(i).join(' ').length;
    const score = Math.max(a, b) + (a > maxChars || b > maxChars ? 1000 : 0);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/** words split over the same lines as wrapLines, keeping their timings */
export function wrapWords(c: Caption, maxChars: number, maxLines: number): CaptionWord[][] {
  const words = c.words.length ? c.words : c.text.split(/\s+/).filter(Boolean).map((t) => ({ text: t, start: c.start, end: c.end }));
  const lines = wrapLines(words.map((w) => w.text).join(' '), maxChars, maxLines);
  const out: CaptionWord[][] = [];
  let i = 0;
  for (const line of lines) {
    const n = line.split(/\s+/).filter(Boolean).length;
    out.push(words.slice(i, i + n));
    i += n;
  }
  return out;
}

/** when the recogniser gives text without word times, spread words over the segment by length */
export function distributeWords(text: string, start: number, end: number): CaptionWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const totalChars = parts.reduce((n, p) => n + p.length + 1, 0);
  let t = start;
  return parts.map((p) => {
    const d = ((end - start) * (p.length + 1)) / totalChars;
    const w = { text: p, start: Math.round(t), end: Math.round(t + d) };
    t += d;
    return w;
  });
}

export function captionAt(items: Caption[], frame: number): Caption | null {
  // items are sorted; binary search
  let lo = 0, hi = items.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = items[mid];
    if (frame < c.start) hi = mid - 1;
    else if (frame >= c.end) lo = mid + 1;
    else return c;
  }
  return null;
}

// ------------------------------------------------------------------ SRT / VTT

function stamp(frames: number, fps: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round((frames / fps) * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  const p = (n: number, l = 2) => n.toString().padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

export function toSRT(items: Caption[], fps: number, style?: Pick<CaptionStyle, 'maxChars' | 'maxLines'>): string {
  return items.map((c, i) => {
    const lines = style ? wrapLines(c.text, style.maxChars, style.maxLines) : [c.text];
    return `${i + 1}\n${stamp(c.start, fps, ',')} --> ${stamp(c.end, fps, ',')}\n${lines.join('\n')}\n`;
  }).join('\n');
}

export function toVTT(items: Caption[], fps: number, style?: Pick<CaptionStyle, 'maxChars' | 'maxLines'>): string {
  return `WEBVTT\n\n${items.map((c) => {
    const lines = style ? wrapLines(c.text, style.maxChars, style.maxLines) : [c.text];
    return `${stamp(c.start, fps, '.')} --> ${stamp(c.end, fps, '.')}\n${lines.join('\n')}\n`;
  }).join('\n')}`;
}

/** parse SRT or VTT into captions */
export function parseSubtitles(text: string, fps: number): Caption[] {
  const out: Caption[] = [];
  const blocks = text.replace(/\r/g, '').replace(/^WEBVTT[^\n]*\n/, '').split(/\n{2,}/);
  const toFrames = (s: string) => {
    const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/.exec(s.trim());
    if (!m) return null;
    const h = Number(m[1] ?? 0), mi = Number(m[2]), se = Number(m[3]), ms = Number(m[4].padEnd(3, '0'));
    return Math.round(((h * 3600 + mi * 60 + se) + ms / 1000) * fps);
  };
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const start = toFrames(a), end = toFrames(z.split(/\s+/).filter(Boolean)[0] ?? '');
    if (start === null || end === null || end <= start) continue;
    const body = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!body) continue;
    out.push({ id: newCaptionId(), start, end, text: body, words: distributeWords(body, start, end) });
  }
  return out.sort((x, y) => x.start - y.start);
}

// ------------------------------------------------------------------ ASS (burn-in with animation)

function assColor(hex: string, alpha = 0): string {
  const h = hex.replace('#', '').padEnd(6, '0');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

function assTime(frames: number, fps: number): string {
  const cs = Math.max(0, Math.round((frames / fps) * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, r = cs % 100;
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${r.toString().padStart(2, '0')}`;
}

function assEscape(t: string): string {
  return t.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, ' ');
}

const upper = (t: string, on: boolean) => (on ? t.toLocaleUpperCase('tr-TR') : t);

/**
 * Build an ASS script. `offset` shifts everything (for in/out range exports).
 */
export function toASS(items: Caption[], styleIn: CaptionStyle, width: number, height: number, fps: number, offset = 0): string {
  const style = fitted(styleIn, width, height);
  const size = Math.round((style.size / 100) * height);
  const outline = style.box ? Math.max(4, Math.round(size * 0.28)) : Math.round((style.outlineWidth / 100) * size);
  const shadow = Math.round((style.shadow / 1080) * height);
  const align = style.position === 'bottom' ? 2 : style.position === 'top' ? 8 : 5;
  const marginV = Math.round((style.margin / 100) * height);
  const marginH = Math.round(width * 0.06);
  const borderStyle = style.box ? 3 : 1;
  const outlineColor = style.box ? assColor(style.boxColor, 1 - style.boxOpacity) : assColor(style.outline);
  const backColor = style.box ? assColor(style.boxColor, 1 - style.boxOpacity) : assColor('#000000', 0.45);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${style.font},${size},${assColor(style.color)},${assColor(style.highlight)},${outlineColor},${backColor},${style.bold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${align},${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events: string[] = [];
  const T = (f: number) => assTime(f - offset, fps);
  const hi = assColor(style.highlight).replace('&H00', '&H');
  const base = assColor(style.color).replace('&H00', '&H');
  for (const c of items) {
    if (c.end - offset <= 0) continue;
    const lines = wrapWords(c, style.maxChars, style.maxLines);
    const allWords = lines.flat();
    const lineText = (render: (w: CaptionWord, i: number) => string) => {
      let i = 0;
      return lines.map((ws) => ws.map((w) => render(w, i++)).join(' ')).join('\\N');
    };
    switch (style.animation) {
      case 'none':
        events.push(`Dialogue: 0,${T(c.start)},${T(c.end)},Cap,,0,0,0,,${lineText((w) => assEscape(upper(w.text, style.uppercase)))}`);
        break;
      case 'pop':
        events.push(`Dialogue: 0,${T(c.start)},${T(c.end)},Cap,,0,0,0,,{\\fad(90,60)\\fscx92\\fscy92\\t(0,140,\\fscx100\\fscy100)}${lineText((w) => assEscape(upper(w.text, style.uppercase)))}`);
        break;
      case 'karaoke': {
        // \kf fills each word from secondary to primary colour over its duration
        let prevEnd = c.start;
        const txt = lineText((w) => {
          const lead = Math.max(0, w.start - prevEnd);
          const dur = Math.max(1, w.end - Math.max(w.start, prevEnd));
          prevEnd = w.end;
          const cs = (f: number) => Math.round((f / fps) * 100);
          return `${lead ? `{\\k${cs(lead)}}` : ''}{\\kf${cs(dur)}}${assEscape(upper(w.text, style.uppercase))}`;
        });
        // for karaoke the "filled" colour is the highlight: swap primary/secondary
        events.push(`Dialogue: 0,${T(c.start)},${T(c.end)},Cap,,0,0,0,,{\\1c${hi}&\\2c${base}&}${txt}`);
        break;
      }
      case 'highlight': {
        // one event per word: the whole caption, with the current word coloured and slightly bigger
        allWords.forEach((w, k) => {
          const s = k === 0 ? c.start : w.start;
          const e = k === allWords.length - 1 ? c.end : allWords[k + 1].start;
          if (e <= s) return;
          const txt = lineText((x, i) => i === k
            ? `{\\1c${hi}&\\fscx108\\fscy108}${assEscape(upper(x.text, style.uppercase))}{\\1c${base}&\\fscx100\\fscy100}`
            : assEscape(upper(x.text, style.uppercase)));
          events.push(`Dialogue: 0,${T(s)},${T(e)},Cap,,0,0,0,,${txt}`);
        });
        break;
      }
      case 'word': {
        const w = allWords[0];
        events.push(`Dialogue: 0,${T(c.start)},${T(c.end)},Cap,,0,0,0,,{\\fscx70\\fscy70\\t(0,110,\\fscx112\\fscy112)\\t(110,190,\\fscx100\\fscy100)}${assEscape(upper(w?.text ?? c.text, style.uppercase))}`);
        break;
      }
    }
  }
  return head + events.join('\n') + '\n';
}

/** which word is active at a frame (for the live preview) */
export function activeWordIndex(c: Caption, frame: number): number {
  const ws = c.words;
  for (let i = ws.length - 1; i >= 0; i--) if (frame >= ws[i].start) return i;
  return 0;
}
