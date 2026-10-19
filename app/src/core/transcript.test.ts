import { describe, expect, it } from 'vitest';
import { makeSequence, tracksOfKind, MediaItem } from './model';
import * as ops from './ops';
import { fillerRanges, paragraphs, pauseRanges, removeRanges, search, selectionRange } from './transcript';

const media: MediaItem = { id: 'M', path: '/x.mp4', name: 'x', kind: 'video', duration: 60, fps: 25, width: 1920, height: 1080, hasVideo: true, hasAudio: true, audioChannels: 2, sampleRate: 48000, codec: 'h264', binId: null, label: 'iris', online: true, markIn: null, markOut: null };
const W = (text: string, start: number, end: number) => ({ text, start, end });

function seq() {
  const s = makeSequence({ width: 1920, height: 1080, fps: 25 });
  ops.overwriteEdit(s, { media, srcIn: 0, srcOut: 20 }, 0, tracksOfKind(s, 'video')[0].id, tracksOfKind(s, 'audio')[0].id);
  s.transcript = { language: 'tr', words: [W('Merhaba', 10, 30), W('ııı', 40, 55), W('bugün', 60, 80), W('size', 150, 170), W('anlatacağım', 175, 210)] };
  s.captions = { enabled: true, language: 'tr', style: {} as never, items: [{ id: 'c', start: 10, end: 210, text: 'x', words: s.transcript.words.map((w) => ({ ...w })) }] };
  return s;
}

describe('text-based editing', () => {
  it('finds fillers and long pauses', () => {
    const s = seq();
    expect(fillerRanges(s.transcript!.words, 'tr')).toEqual([[40, 60]]);
    expect(pauseRanges(s.transcript!.words, 25, 1, 0.2)).toEqual([[85, 145]]);
    expect(paragraphs(s.transcript!.words, 25, 2).length).toBe(2);
    expect(search(s.transcript!.words, 'BUGÜN size')).toEqual([2]);
  });
  it('removing ranges ripples every track and shifts transcript + captions', () => {
    const s = seq();
    const removed = removeRanges(s, [...fillerRanges(s.transcript!.words, 'tr'), ...pauseRanges(s.transcript!.words, 25, 1, 0.2)]);
    expect(removed).toBe(20 + 60);
    const v = Object.values(s.clips).filter((c) => c.stream === 'video');
    expect(v.reduce((a, c) => a + c.duration, 0)).toBe(500 - 80);
    // contiguous, no gaps
    const sorted = v.sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].start).toBe(sorted[i - 1].start + sorted[i - 1].duration);
    expect(s.transcript!.words.map((w) => w.text)).toEqual(['Merhaba', 'bugün', 'size', 'anlatacağım']);
    expect(s.transcript!.words.map((w) => w.start)).toEqual([10, 40, 70, 95]);
    expect(s.captions!.items[0].words.map((w) => w.start)).toEqual([10, 40, 70, 95]);
    // audio stayed in sync with video
    const a = Object.values(s.clips).filter((c) => c.stream === 'audio').sort((x, y) => x.start - y.start);
    expect(a.map((c) => [c.start, c.duration, c.srcIn])).toEqual(sorted.map((c) => [c.start, c.duration, c.srcIn]));
  });
  it('a text selection covers the words and the air around them', () => {
    const s = seq();
    expect(selectionRange(s.transcript!.words, 2, 3)).toEqual([58, 172]);
  });
});
