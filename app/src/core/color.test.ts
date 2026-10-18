import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOOKS, autoGrade, bakeLut, gradePixel, isNeutral, neutralGrade, parseCube, sampleLut, toCube } from './color';

const req = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG ?? (req('ffmpeg-static') as string);

describe('colour grading', () => {
  it('neutral grade is identity', () => {
    const g = neutralGrade();
    expect(isNeutral(g)).toBe(true);
    for (const [r, gg, b] of [[0, 0, 0], [1, 1, 1], [0.2, 0.5, 0.8], [0.9, 0.1, 0.3]]) {
      const o = gradePixel(r, gg, b, g);
      expect(o[0]).toBeCloseTo(r, 4); expect(o[1]).toBeCloseTo(gg, 4); expect(o[2]).toBeCloseTo(b, 4);
    }
  });

  it('controls move pixels the right way', () => {
    const p = [0.4, 0.4, 0.4] as const;
    const up = (k: Partial<ReturnType<typeof neutralGrade>>) => gradePixel(...p, { ...neutralGrade(), ...k });
    expect(up({ exposure: 1 })[0]).toBeGreaterThan(0.5);
    expect(up({ exposure: -1 })[0]).toBeLessThan(0.35);
    const warm = up({ temperature: 60 });
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(up({ saturation: 0 })).toEqual(up({ saturation: 0 }));
    const grey = gradePixel(0.8, 0.2, 0.2, { ...neutralGrade(), saturation: 0 });
    expect(Math.abs(grey[0] - grey[1])).toBeLessThan(1e-6);
    const bw = gradePixel(0.8, 0.2, 0.2, { ...neutralGrade(), look: 'siyah-beyaz' });
    expect(Math.abs(bw[0] - bw[2])).toBeLessThan(1e-6);
    expect(Object.keys(LOOKS).length).toBeGreaterThanOrEqual(6);
  });

  it('cube round trip and sampling', () => {
    const g = { ...neutralGrade(), contrast: 30, temperature: 20 };
    const lut = bakeLut(g, 17);
    const back = parseCube(toCube(lut));
    expect(back.size).toBe(17);
    const s = sampleLut(back, 0.3, 0.6, 0.2);
    const d = gradePixel(0.3, 0.6, 0.2, g);
    for (let i = 0; i < 3; i++) expect(Math.abs(s[i] - d[i])).toBeLessThan(0.02);
  });

  it('ffmpeg lut3d gives the same colours as the preview math', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kurgu-color-'));
    const g = { ...neutralGrade(), exposure: 0.4, contrast: 20, temperature: 35, saturation: 130, look: 'teal-turuncu' };
    const cube = join(dir, 'g.cube');
    writeFileSync(cube, toCube(bakeLut(g, 33)));
    const colors = [[200, 120, 60], [40, 80, 160], [128, 128, 128]];
    for (const [r, gg, b] of colors) {
      const hex = ((r << 16) | (gg << 8) | b).toString(16).padStart(6, '0');
      const grab = (vf: string) => execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=16x16`, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      const src = grab('format=rgb24'); // the exact input after ffmpeg's own conversion
      const out = grab(`format=rgb24,lut3d=file='${cube}':interp=tetrahedral`);
      const want = gradePixel(src[0] / 255, src[1] / 255, src[2] / 255, g).map((x) => Math.round(x * 255));
      for (let c = 0; c < 3; c++) expect(Math.abs(out[c] - want[c])).toBeLessThanOrEqual(4);
    }
  });

  it('auto grade fixes a dark, blue-cast frame', () => {
    const px = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = 30; px[i + 1] = 40; px[i + 2] = 70; px[i + 3] = 255; }
    const g = autoGrade(px);
    expect(g.exposure).toBeGreaterThan(0.5);
    expect(g.temperature).toBeGreaterThan(10);
    const o = gradePixel(30 / 255, 40 / 255, 70 / 255, g);
    expect((o[0] + o[1] + o[2]) / 3).toBeGreaterThan(40 / 255);
    expect(o[2] / o[0]).toBeLessThan(70 / 30); // the blue cast is reduced
  });
});
