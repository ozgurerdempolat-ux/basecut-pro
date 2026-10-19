// Text-based editing: the sequence transcript (word timings in sequence frames),
// cutting by text, removing pauses and filler words. Every cut is a ripple
// extract across all unlocked tracks; transcript, captions and markers follow.

import type { CaptionWord } from './captions';
import type { Sequence } from './model';
import { extract } from './ops';

export interface Para { start: number; end: number; words: { w: CaptionWord; i: number }[] }

/** split into paragraphs at long pauses */
export function paragraphs(words: CaptionWord[], fps: number, gapSec = 1.2): Para[] {
  const out: Para[] = [];
  words.forEach((w, i) => {
    const last = out[out.length - 1];
    if (!last || w.start - last.end > gapSec * fps || last.words.length > 80) out.push({ start: w.start, end: w.end, words: [{ w, i }] });
    else { last.words.push({ w, i }); last.end = w.end; }
  });
  return out;
}

const norm = (t: string) => t.toLocaleLowerCase('tr-TR').replace(/[.,!?;:"'“”‘’…()-]/g, '').trim();

export const FILLERS: Record<string, string[]> = {
  tr: ['ı', 'ıı', 'ııı', 'ıııı', 'ee', 'eee', 'eeee', 'eh', 'ehh', 'hı', 'hıı', 'hm', 'hmm', 'hmmm', 'mm', 'mmm', 'aa', 'aaa', 'ah', 'öö', 'ööö'],
  en: ['uh', 'uhh', 'um', 'umm', 'uhm', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm'],
};

/** frames to cut for every filler word (with a little of the surrounding silence) */
export function fillerRanges(words: CaptionWord[], lang: string, extra: string[] = []): [number, number][] {
  const set = new Set([...(FILLERS[lang] ?? FILLERS.tr), ...extra.map(norm)]);
  const r: [number, number][] = [];
  words.forEach((w, i) => {
    if (!set.has(norm(w.text))) return;
    const prevEnd = i > 0 ? words[i - 1].end : w.start;
    const nextStart = i < words.length - 1 ? words[i + 1].start : w.end;
    // take the filler and the gap up to the next word, so the remaining speech joins naturally
    r.push([Math.max(prevEnd, w.start), Math.max(w.end, Math.min(nextStart, w.end + 6))]);
  });
  return merge(r);
}

/** silences between words longer than minSec; keepSec of air stays on each side */
export function pauseRanges(words: CaptionWord[], fps: number, minSec: number, keepSec: number): [number, number][] {
  const r: [number, number][] = [];
  const keep = Math.round(keepSec * fps);
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1].end, b = words[i].start;
    if (b - a >= minSec * fps && b - a > 2 * keep) r.push([a + keep, b - keep]);
  }
  return merge(r);
}

export function merge(r: [number, number][]): [number, number][] {
  const s = r.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const x of s) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push([...x]); }
  return out;
}

/** shift one frame position through a removal of [a,b) */
const through = (f: number, a: number, b: number) => (f >= b ? f - (b - a) : f > a ? a : f);

/**
 * Ripple-delete the ranges from every unlocked track (last first so earlier
 * positions stay valid) and keep transcript, captions and markers in step.
 * Returns the total frames removed.
 */
export function removeRanges(s: Sequence, ranges: [number, number][]): number {
  const list = merge(ranges).reverse();
  let removed = 0;
  const tracks = s.tracks.filter((t) => !t.locked).map((t) => t.id);
  for (const [a, b] of list) {
    extract(s, a, b, tracks);
    removed += b - a;
    if (s.transcript) {
      s.transcript.words = s.transcript.words.filter((w) => !(w.start >= a && w.end <= b)).map((w) => ({ ...w, start: through(w.start, a, b), end: Math.max(through(w.start, a, b) + 1, through(w.end, a, b)) }));
    }
    if (s.captions) {
      s.captions.items = s.captions.items
        .map((c) => ({ ...c, start: through(c.start, a, b), end: through(c.end, a, b), words: c.words.filter((w) => !(w.start >= a && w.end <= b)).map((w) => ({ ...w, start: through(w.start, a, b), end: Math.max(through(w.start, a, b) + 1, through(w.end, a, b)) })) }))
        .filter((c) => c.end > c.start);
    }
    s.markers = s.markers.filter((m) => !(m.frame >= a && m.frame < b)).map((m) => ({ ...m, frame: through(m.frame, a, b) }));
    if (s.playhead > a) s.playhead = through(s.playhead, a, b);
  }
  return removed;
}

/** frames covered by a word selection [i, j] (inclusive), extended into the silence around it */
export function selectionRange(words: CaptionWord[], i: number, j: number): [number, number] {
  const lo = Math.min(i, j), hi = Math.max(i, j);
  const prevEnd = lo > 0 ? words[lo - 1].end : words[lo].start;
  const nextStart = hi < words.length - 1 ? words[hi + 1].start : words[hi].end;
  return [Math.max(prevEnd, words[lo].start - 2), Math.min(nextStart, words[hi].end + 2)];
}

export function search(words: CaptionWord[], q: string): number[] {
  const qs = norm(q).split(/\s+/).filter(Boolean);
  if (!qs.length) return [];
  const hits: number[] = [];
  for (let i = 0; i + qs.length <= words.length; i++) if (qs.every((x, k) => norm(words[i + k].text).includes(x))) hits.push(i);
  return hits;
}
