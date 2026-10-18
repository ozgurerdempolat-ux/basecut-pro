import { describe, expect, it } from 'vitest';
import { DEFAULT_DUCK, duckKeyframes, speechRegions } from './ducking';
import { defaultTransform, param, Clip, evalParam } from './model';

const clip = (start: number, duration: number): Clip => ({ id: 'm', trackId: 'a2', mediaId: 'mus', stream: 'audio', start, duration, srcIn: 0, speed: 1, linkId: null, enabled: true, name: 'music', label: 'caribbean', transform: defaultTransform(), volumeDb: param(0) });

describe('auto ducking', () => {
  it('finds speech and bridges short pauses', () => {
    const L = new Float32Array(300);
    for (let f = 30; f < 90; f++) L[f] = 0.3;
    for (let f = 100; f < 150; f++) L[f] = 0.3; // 10-frame pause → bridged
    for (let f = 200; f < 202; f++) L[f] = 0.9; // click → ignored
    expect(speechRegions(L, 30, DEFAULT_DUCK)).toEqual([[30, 150]]);
  });

  it('writes keyframes that duck under speech and come back after', () => {
    const c = clip(0, 300);
    const k = duckKeyframes(c, [[60, 150]], 30, DEFAULT_DUCK);
    const v = (f: number) => evalParam({ value: 0, keyframes: k }, f);
    expect(v(10)).toBeCloseTo(0);
    expect(v(100)).toBeCloseTo(-14);
    expect(v(250)).toBeCloseTo(0);
    expect(v(56)).toBeLessThan(0); // easing in during the attack
  });

  it('respects clip boundaries', () => {
    const c = clip(100, 50);
    const k = duckKeyframes(c, [[60, 120]], 30, DEFAULT_DUCK);
    const v = (f: number) => evalParam({ value: 0, keyframes: k }, f);
    expect(v(0)).toBeCloseTo(-14); // already ducked when the clip starts
    expect(v(49)).toBeCloseTo(0);
    expect(duckKeyframes(c, [[400, 500]], 30, DEFAULT_DUCK)).toEqual([]);
  });
});
