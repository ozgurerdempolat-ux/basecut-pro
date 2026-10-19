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

describe('curves and secondaries', () => {
  it('curves are smooth, monotone and identity when straight', async () => {
    const { curveFn } = await import('./color');
    expect(curveFn([[0, 0], [1, 1]])).toBeNull();
    const f = curveFn([[0, 0], [0.25, 0.15], [0.75, 0.9], [1, 1]])!; // S-curve
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.01) { const y = f(x); expect(y).toBeGreaterThanOrEqual(prev - 1e-9); prev = y; }
    expect(f(0.25)).toBeCloseTo(0.15, 5);
    expect(f(0.5)).toBeGreaterThan(0.45); expect(f(0.5)).toBeLessThan(0.6);
  });
  it('RGB and hue curves do what they say', () => {
    const base = neutralGrade();
    const lifted = gradePixel(0.3, 0.3, 0.3, { ...base, curves: { b: [[0, 0], [0.5, 0.7], [1, 1]] } });
    expect(lifted[2]).toBeGreaterThan(0.38); expect(lifted[0]).toBeCloseTo(0.3, 3);
    // hue vs sat: kill reds only
    const g = { ...base, hueVsSat: [[0, -1], [0.17, 0], [0.5, 0], [0.83, 0]] as [number, number][] };
    const red = gradePixel(0.8, 0.2, 0.2, g), blue = gradePixel(0.2, 0.3, 0.8, g);
    expect(Math.max(...red) - Math.min(...red)).toBeLessThan(0.15);
    expect(Math.max(...blue) - Math.min(...blue)).toBeGreaterThan(0.5);
  });
  it('HSL secondary changes only the qualified colour (e.g. make the sky bluer, leave skin alone)', async () => {
    const { defaultSecondary } = await import('./color');
    const sec = { ...defaultSecondary(), hue: 210, hueWidth: 25, saturation: 60, brightness: -20 };
    const g = { ...neutralGrade(), secondary: sec };
    const sky = [0.45, 0.6, 0.85], skin = [0.88, 0.67, 0.55];
    const sky2 = gradePixel(sky[0], sky[1], sky[2], g), skin2 = gradePixel(skin[0], skin[1], skin[2], g);
    expect(sky2[2] - sky2[0]).toBeGreaterThan(sky[2] - sky[0] + 0.05);
    for (let c = 0; c < 3; c++) expect(skin2[c]).toBeCloseTo(skin[c], 2);
  });
  it('export LUT matches the preview for curves + secondary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kurgu-color2-'));
    const g = { ...neutralGrade(), curves: { master: [[0, 0.05], [0.5, 0.45], [1, 0.95]] as [number, number][] }, hueVsSat: [[0.0, 0.5], [0.33, -0.5], [0.66, 0]] as [number, number][], secondary: { hue: 30, hueWidth: 20, satMin: 20, satMax: 100, lumMin: 10, lumMax: 95, soft: 30, hueShift: 10, saturation: 30, brightness: 5, temperature: 10 } };
    const cube = join(dir, 'g.cube');
    writeFileSync(cube, toCube(bakeLut(g, 33)));
    for (const [r, gg, b] of [[200, 120, 60], [40, 80, 160], [128, 128, 128], [220, 170, 140]]) {
      const hex = ((r << 16) | (gg << 8) | b).toString(16).padStart(6, '0');
      const grab = (vf: string) => execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=16x16`, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      const src = grab('format=rgb24');
      const out = grab(`format=rgb24,lut3d=file='${cube}':interp=tetrahedral`);
      const want = gradePixel(src[0] / 255, src[1] / 255, src[2] / 255, g).map((x) => Math.round(x * 255));
      for (let c = 0; c < 3; c++) expect(Math.abs(out[c] - want[c])).toBeLessThanOrEqual(5);
    }
  });
});
