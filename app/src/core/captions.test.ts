import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaptionWord, captionAt, groupWords, parseSubtitles, presetStyle, toASS, toSRT, toVTT, wrapLines } from './captions';
import { makeProject, makeSequence, tracksOfKind, MediaItem } from './model';
import * as ops from './ops';
import { buildRenderPlan, defaultExport } from './render-graph';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);
const fontDir = dirname(req.resolve('@expo-google-fonts/montserrat/800ExtraBold/Montserrat_800ExtraBold.ttf'));

const sentence = 'Merhaba arkadaşlar bugün size harika bir mekan tanıtacağız. Ankara\'nın en güzel kahvaltısı burada!';
function words(fps = 30): CaptionWord[] {
  let f = 0;
  return sentence.split(' ').map((t) => { const w = { text: t, start: f, end: f + 10 }; f += 12; return w; });
}

describe('captions', () => {
  it('groups words into readable captions', () => {
    const caps = groupWords(words(), presetStyle('sosyal-vurgu'), 30);
    expect(caps.length).toBeGreaterThan(2);
    for (const c of caps) {
      expect(c.text.length).toBeLessThanOrEqual(36);
      expect(c.end).toBeGreaterThan(c.start);
    }
    // a sentence end always breaks
    expect(caps.some((c) => c.text.endsWith('tanıtacağız.'))).toBe(true);
    // sorted, non overlapping
    for (let i = 1; i < caps.length; i++) expect(caps[i].start).toBeGreaterThanOrEqual(caps[i - 1].end);
    expect(captionAt(caps, 13)?.text.startsWith('Merhaba')).toBe(true);
    expect(captionAt(caps, 100000)).toBeNull();
  });

  it('one-word style makes a caption per word', () => {
    const caps = groupWords(words(), presetStyle('tek-kelime-pop'), 30);
    expect(caps).toHaveLength(sentence.split(' ').length);
  });

  it('wraps into balanced lines', () => {
    expect(wrapLines('bir iki üç dört beş altı yedi', 18, 2)).toEqual(['bir iki üç dört', 'beş altı yedi']);
    expect(wrapLines('kısa', 18, 2)).toEqual(['kısa']);
  });

  it('SRT and VTT round trip', () => {
    const caps = groupWords(words(), presetStyle('klasik'), 30);
    const srt = toSRT(caps, 30);
    expect(srt).toContain('00:00:00,000 --> ');
    const back = parseSubtitles(srt, 30);
    expect(back.map((c) => c.text)).toEqual(caps.map((c) => c.text));
    expect(back.map((c) => c.start)).toEqual(caps.map((c) => c.start));
    const vtt = toVTT(caps, 30);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(parseSubtitles(vtt, 30)).toHaveLength(caps.length);
  });

  it('ASS has one event per word for the highlight style', () => {
    const caps = groupWords(words(), presetStyle('sosyal-vurgu'), 30);
    const ass = toASS(caps, presetStyle('sosyal-vurgu'), 1080, 1920, 30);
    const n = ass.split('\n').filter((l) => l.startsWith('Dialogue:')).length;
    expect(n).toBe(sentence.split(' ').length);
    expect(ass).toContain('MERHABA'); // Turkish-aware uppercase
    expect(ass).toContain('ANKARA\'NIN');
  });

  for (const preset of ['sosyal-vurgu', 'tek-kelime-pop', 'karaoke', 'kutulu', 'klasik']) {
    it(`burns "${preset}" captions into a real export`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'kurgu-cap-'));
      const src = join(dir, 'bg.mp4');
      execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x204060:s=540x960:r=30:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
      const p = makeProject();
      const s = makeSequence({ width: 540, height: 960, fps: 30 });
      const m: MediaItem = { id: 'bg', path: src, name: 'bg', kind: 'video', duration: 3, fps: 30, width: 540, height: 960, hasVideo: true, hasAudio: true, audioChannels: 2, sampleRate: 48000, codec: 'h264', binId: null, label: 'iris', online: true, markIn: null, markOut: null };
      p.media.bg = m;
      ops.overwriteEdit(s, { media: m, srcIn: 0, srcOut: 3 }, 0, tracksOfKind(s, 'video')[0].id, tracksOfKind(s, 'audio')[0].id);
      const style = presetStyle(preset);
      const caps = groupWords(words(), style, 30);
      const assFile = join(dir, 'c.ass');
      writeFileSync(assFile, toASS(caps, style, 540, 960, 30));
      const out = join(dir, 'out.mp4');
      execFileSync(FFMPEG, buildRenderPlan(p, s, { ...defaultExport(out), burnSubtitles: assFile, subtitlesFontsDir: fontDir }).args, { stdio: 'pipe' });
      // grab the frame at 0.2s and look for bright caption pixels on the dark background
      const raw = execFileSync(FFMPEG, ['-v', 'error', '-ss', '0.2', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
      let bright = 0;
      for (const v of raw) if (v > 200) bright++;
      expect(bright).toBeGreaterThan(300);
    }, 60000);
  }
});
