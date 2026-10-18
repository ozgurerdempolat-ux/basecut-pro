import { describe, expect, it } from 'vitest';
import { MediaItem, Sequence, clipEnd, clipSrcOut, clipsOnTrack, evalParam, framesToTimecode, makeSequence, sourceTimeAt, timecodeToFrames, tracksOfKind } from './model';
import * as ops from './ops';

function media(id: string, duration = 10, kind: MediaItem['kind'] = 'video'): MediaItem {
  return {
    id, path: `/m/${id}.mp4`, name: id, kind, duration, fps: 30, width: 1920, height: 1080,
    hasVideo: kind !== 'audio', hasAudio: kind !== 'image', audioChannels: 2, sampleRate: 48000, codec: 'h264',
    binId: null, label: 'iris', online: true, markIn: null, markOut: null,
  };
}

function setup() {
  const s = makeSequence({ fps: 30 });
  const V1 = tracksOfKind(s, 'video')[0].id;
  const V2 = tracksOfKind(s, 'video')[1].id;
  const A1 = tracksOfKind(s, 'audio')[0].id;
  const A2 = tracksOfKind(s, 'audio')[1].id;
  const M: Record<string, MediaItem> = { a: media('a'), b: media('b'), c: media('c'), img: media('img', Infinity, 'image') };
  return { s, V1, V2, A1, A2, M };
}

const vids = (s: Sequence, t: string) => clipsOnTrack(s, t);

describe('timecode', () => {
  it('round-trips', () => {
    expect(framesToTimecode(0, 30)).toBe('00:00:00:00');
    expect(framesToTimecode(30 * 61 + 5, 30)).toBe('00:01:01:05');
    expect(timecodeToFrames('00:01:01:05', 30)).toBe(30 * 61 + 5);
    expect(timecodeToFrames('1:00', 30)).toBe(30);
    expect(timecodeToFrames('150', 30)).toBe(150);
  });
});

describe('overwrite and insert', () => {
  it('overwrite places linked A/V', () => {
    const { s, V1, A1, M } = setup();
    const ids = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 2 }, 0, V1, A1);
    expect(ids).toHaveLength(2);
    const [v, a] = ids.map((id) => s.clips[id]);
    expect(v.duration).toBe(60);
    expect(v.linkId).toBeTruthy();
    expect(v.linkId).toBe(a.linkId);
    expect(a.trackId).toBe(A1);
  });

  it('overwrite into the middle of a clip splits and replaces', () => {
    const { s, V1, A1, M } = setup();
    ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 4 }, 0, V1, A1); // 0-120
    ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 30, V1, A1); // 30-60
    const v = vids(s, V1);
    expect(v.map((c) => [c.mediaId, c.start, c.duration])).toEqual([['a', 0, 30], ['b', 30, 30], ['a', 60, 60]]);
    expect(v[2].srcIn).toBeCloseTo(2);
    expect(Object.keys(s.clips)).toHaveLength(6);
  });

  it('insert pushes everything on sync-locked tracks', () => {
    const { s, V1, V2, A1, M } = setup();
    ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 4 }, 0, V1, A1);
    ops.overwriteEdit(s, { media: M.c, srcIn: 0, srcOut: 1 }, 90, V2, null); // title-ish on V2 at 90
    ops.insertEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 30, V1, A1);
    const v = vids(s, V1);
    expect(v.map((c) => [c.mediaId, c.start, c.duration])).toEqual([['a', 0, 30], ['b', 30, 30], ['a', 60, 90]]);
    expect(vids(s, V2)[0].start).toBe(120); // V2 moved with sync lock
  });

  it('insert does not move tracks with sync lock off', () => {
    const { s, V1, V2, A1, M } = setup();
    ops.overwriteEdit(s, { media: M.c, srcIn: 0, srcOut: 1 }, 90, V2, null);
    s.tracks.find((t) => t.id === V2)!.syncLock = false;
    ops.insertEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 0, V1, A1);
    expect(vids(s, V2)[0].start).toBe(90);
  });

  it('refuses locked target', () => {
    const { s, V1, A1, M } = setup();
    s.tracks.find((t) => t.id === V1)!.locked = true;
    expect(() => ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 0, V1, A1)).toThrow(ops.EditError);
  });

  it('video-only media and audio-only targets', () => {
    const { s, V1, A1, M } = setup();
    const ids = ops.overwriteEdit(s, { media: M.img, srcIn: 0, srcOut: 5 }, 0, V1, A1);
    expect(ids).toHaveLength(1);
    expect(s.clips[ids[0]].linkId).toBeNull();
    expect(() => ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1, video: false }, 0, V1, null)).toThrow();
  });
});

describe('razor and delete', () => {
  it('razor splits linked pair and keeps them linked', () => {
    const { s, V1, A1, M } = setup();
    ops.overwriteEdit(s, { media: M.a, srcIn: 1, srcOut: 5 }, 0, V1, A1);
    const right = ops.razor(s, 30);
    expect(right).toHaveLength(2);
    const [r1, r2] = right.map((id) => s.clips[id]);
    expect(r1.linkId).toBe(r2.linkId);
    expect(r1.srcIn).toBeCloseTo(2);
    const left = vids(s, V1)[0];
    expect(left.linkId).not.toBe(r1.linkId);
    expect(clipSrcOut(left, 30)).toBeCloseTo(2);
  });

  it('razor ignores locked tracks', () => {
    const { s, V1, A1, M } = setup();
    ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 4 }, 0, V1, A1);
    s.tracks.find((t) => t.id === A1)!.locked = true;
    ops.razor(s, 30);
    expect(vids(s, V1)).toHaveLength(2);
    expect(vids(s, A1)).toHaveLength(1);
  });

  it('delete removes linked partner', () => {
    const { s, V1, A1, M } = setup();
    const [v] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 0, V1, A1);
    ops.deleteClips(s, [v]);
    expect(Object.keys(s.clips)).toHaveLength(0);
  });

  it('ripple delete closes the gap on all sync tracks', () => {
    const { s, V1, A1, M } = setup();
    ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 0, V1, A1);
    const [b] = ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 30, V1, A1);
    ops.overwriteEdit(s, { media: M.c, srcIn: 0, srcOut: 1 }, 60, V1, A1);
    ops.rippleDelete(s, [b]);
    expect(vids(s, V1).map((c) => [c.mediaId, c.start])).toEqual([['a', 0], ['c', 30]]);
    expect(vids(s, A1).map((c) => [c.mediaId, c.start])).toEqual([['a', 0], ['c', 30]]);
  });

  it('ripple delete refuses when it would break sync', () => {
    const { s, V1, V2, A1, M } = setup();
    const [b] = ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 0, V1, A1);
    ops.overwriteEdit(s, { media: M.c, srcIn: 0, srcOut: 2 }, 0, V2, null); // spans the gap
    ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 30, V1, A1);
    expect(() => ops.rippleDelete(s, [b])).toThrow(/sync/);
  });

  it('close gap', () => {
    const { s, V1, A1, M } = setup();
    ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 0, V1, A1);
    ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 60, V1, A1);
    ops.closeGapAt(s, V1, 40);
    expect(vids(s, V1).map((c) => c.start)).toEqual([0, 30]);
    expect(vids(s, A1).map((c) => c.start)).toEqual([0, 30]);
  });

  it('close all gaps', () => {
    const { s, V1, A1, M } = setup();
    ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 10, V1, A1);
    ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 60, V1, A1);
    ops.closeAllGaps(s);
    expect(vids(s, V1).map((c) => c.start)).toEqual([0, 30]);
  });

  it('lift leaves a gap, extract closes it', () => {
    const { s, V1, A1, M } = setup();
    ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 4 }, 0, V1, A1);
    s.tracks.find((t) => t.id === A1)!.targeted = true;
    const s2 = structuredClone(s);
    ops.lift(s, 30, 60);
    expect(vids(s, V1).map((c) => [c.start, c.duration])).toEqual([[0, 30], [60, 60]]);
    ops.extract(s2, 30, 60);
    expect(vids(s2, V1).map((c) => [c.start, c.duration])).toEqual([[0, 30], [30, 60]]);
    expect(vids(s2, A1).map((c) => [c.start, c.duration])).toEqual([[0, 30], [30, 60]]);
  });
});

describe('trimming', () => {
  it('normal trim stops at neighbour and media end', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 0, V1, A1);
    ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 45, V1, A1);
    expect(ops.trimEdge(s, M, a, 'out', 100)).toBe(15);
    expect(s.clips[a].duration).toBe(45);
    // head can't go before media start
    expect(ops.trimEdge(s, M, a, 'in', -10)).toBe(0);
  });

  it('trim in moves start and source in', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 2 }, 0, V1, A1);
    ops.trimEdge(s, M, a, 'in', 15);
    expect(s.clips[a].start).toBe(15);
    expect(s.clips[a].duration).toBe(45);
    expect(s.clips[a].srcIn).toBeCloseTo(0.5);
  });

  it('trim cannot exceed media', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 9, srcOut: 10 }, 600, V1, A1);
    expect(ops.trimEdge(s, M, a, 'out', 100)).toBe(0);
    expect(ops.trimEdge(s, M, a, 'in', -1000)).toBe(-270);
    // and never before frame 0
    const [b] = ops.overwriteEdit(s, { media: M.b, srcIn: 5, srcOut: 6 }, 10, V1, A1);
    expect(ops.trimEdge(s, M, b, 'in', -1000)).toBe(-10);
  });

  it('stills can be extended indefinitely', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.img, srcIn: 0, srcOut: 5 }, 0, V1, A1);
    expect(ops.trimEdge(s, M, a, 'out', 1000)).toBe(1000);
  });

  it('ripple trim out moves later clips', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 0, V1, A1);
    ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 30, V1, A1);
    expect(ops.trimEdge(s, M, a, 'out', 30, 'ripple')).toBe(30);
    expect(vids(s, V1).map((c) => [c.start, c.duration])).toEqual([[0, 60], [60, 30]]);
    expect(vids(s, A1).map((c) => [c.start, c.duration])).toEqual([[0, 60], [60, 30]]);
    ops.trimEdge(s, M, a, 'out', -45, 'ripple');
    expect(vids(s, V1).map((c) => [c.start, c.duration])).toEqual([[0, 15], [15, 30]]);
  });

  it('ripple trim in keeps start and pulls later clips', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 2 }, 0, V1, A1);
    ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 60, V1, A1);
    ops.trimEdge(s, M, a, 'in', 20, 'ripple');
    expect(vids(s, V1).map((c) => [c.start, c.duration])).toEqual([[0, 40], [40, 30]]);
    expect(s.clips[a].srcIn).toBeCloseTo(20 / 30);
  });

  it('rolling edit keeps total duration', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 0, V1, A1);
    const [b] = ops.overwriteEdit(s, { media: M.b, srcIn: 2, srcOut: 3 }, 30, V1, A1);
    expect(ops.rollEdit(s, M, a, 10)).toBe(10);
    expect([s.clips[a].duration, s.clips[b].start, s.clips[b].duration]).toEqual([40, 40, 20]);
    expect(s.clips[b].srcIn).toBeCloseTo(2 + 10 / 30);
    // linked audio rolled too
    expect(vids(s, A1).map((c) => [c.start, c.duration])).toEqual([[0, 40], [40, 20]]);
    // roll left limited by b's head room (2s = 60 frames + 10 already used) and a's min length
    expect(ops.rollEdit(s, M, a, -1000)).toBe(-39);
  });

  it('slip changes source but not position', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 1, srcOut: 2 }, 30, V1, A1);
    expect(ops.slip(s, M, a, 15)).toBe(15);
    expect(s.clips[a].srcIn).toBeCloseTo(1.5);
    expect(s.clips[a].start).toBe(30);
    expect(ops.slip(s, M, a, -1000)).toBe(-45);
    expect(s.clips[a].srcIn).toBeCloseTo(0);
    expect(ops.slip(s, M, a, 1000)).toBe(270);
  });

  it('slide moves a clip and trims neighbours', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 0, V1, A1);
    const [b] = ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 30, V1, A1);
    const [c] = ops.overwriteEdit(s, { media: M.c, srcIn: 1, srcOut: 2 }, 60, V1, A1);
    expect(ops.slide(s, M, b, 10)).toBe(10);
    expect([s.clips[a].duration, s.clips[b].start, s.clips[c].start, s.clips[c].duration]).toEqual([40, 40, 70, 20]);
    expect(ops.slide(s, M, b, -20)).toBe(-20);
    expect([s.clips[a].duration, s.clips[b].start, s.clips[c].start, s.clips[c].duration]).toEqual([20, 20, 50, 40]);
    // next clip's head can only grow as far as its source allows (1s + 10f used = 20 more frames)
    expect(ops.slide(s, M, b, -100)).toBe(-19);
  });

  it('rate stretch changes speed', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 2 }, 0, V1, A1);
    ops.rateStretch(s, a, 'out', 60);
    expect(s.clips[a].duration).toBe(120);
    expect(s.clips[a].speed).toBeCloseTo(0.5);
    expect(clipSrcOut(s.clips[a], 30)).toBeCloseTo(2);
  });

  it('set speed with ripple', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 2 }, 0, V1, A1);
    ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 60, V1, A1);
    expect(() => ops.setSpeed(s, a, 0.5, false)).toThrow();
    ops.setSpeed(s, a, 0.5, true);
    expect(vids(s, V1).map((c) => [c.start, c.duration])).toEqual([[0, 120], [120, 30]]);
    ops.setSpeed(s, a, 2, true);
    expect(vids(s, V1).map((c) => [c.start, c.duration])).toEqual([[0, 30], [30, 30]]);
  });

  it('reverse playback maps time backwards', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 1, srcOut: 2 }, 0, V1, A1);
    ops.setSpeed(s, a, -1, true);
    expect(sourceTimeAt(s.clips[a], 0, 30)).toBeCloseTo(2);
    expect(sourceTimeAt(s.clips[a], 29, 30)).toBeCloseTo(1 + 1 / 30);
    const r = ops.razor(s, 15);
    const right = s.clips[r[0]].stream === 'video' ? s.clips[r[0]] : s.clips[r[1]];
    expect(sourceTimeAt(right, 15, 30)).toBeCloseTo(1.5);
  });
});

describe('moving', () => {
  it('drag overwrites destination', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 0, V1, A1);
    ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 2 }, 60, V1, A1);
    ops.moveClips(s, [a], 75);
    expect(vids(s, V1).map((c) => [c.mediaId, c.start, c.duration])).toEqual([['b', 60, 15], ['a', 75, 30], ['b', 105, 15]]);
    expect(vids(s, A1).map((c) => [c.mediaId, c.start, c.duration])).toEqual([['b', 60, 15], ['a', 75, 30], ['b', 105, 15]]);
  });

  it('drag to another track of the same kind', () => {
    const { s, V1, V2, A1, A2, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 0, V1, A1);
    ops.moveClips(s, [a], 0, 1, 1);
    expect(vids(s, V2)).toHaveLength(1);
    expect(vids(s, A2)).toHaveLength(1);
    expect(() => ops.moveClips(s, [a], 0, 5, 0)).toThrow();
  });

  it('insert-drag ripples', () => {
    const { s, V1, A1, M } = setup();
    ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 2 }, 0, V1, A1);
    const [b] = ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 90, V1, A1);
    ops.moveClips(s, [b], -60, 0, 0, 'insert');
    expect(vids(s, V1).map((c) => [c.mediaId, c.start, c.duration])).toEqual([['a', 0, 30], ['b', 30, 30], ['a', 60, 30]]);
  });

  it('cannot move before zero', () => {
    const { s, V1, A1, M } = setup();
    const [a] = ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 1 }, 10, V1, A1);
    ops.moveClips(s, [a], -100);
    expect(s.clips[a].start).toBe(0);
  });
});

describe('tracks and misc', () => {
  it('add, move and delete tracks', () => {
    const { s, V1 } = setup();
    const v4 = ops.addTrack(s, 'video');
    expect(tracksOfKind(s, 'video').map((t) => t.name)).toEqual(['V1', 'V2', 'V3', 'V4']);
    expect(s.tracks.findIndex((t) => t.id === v4)).toBe(3);
    ops.moveTrack(s, V1, 1);
    expect(tracksOfKind(s, 'video')[1].id).toBe(V1);
    ops.deleteTrack(s, v4);
    expect(tracksOfKind(s, 'video')).toHaveLength(3);
  });

  it('keyframes interpolate', () => {
    const p = { value: 0, keyframes: [{ frame: 0, value: 0, ease: 'linear' as const }, { frame: 10, value: 100, ease: 'linear' as const }] };
    expect(evalParam(p, 5)).toBe(50);
    expect(evalParam(p, 20)).toBe(100);
  });

  it('Q/W ripple trim to playhead', () => {
    const { s, V1, A1, M } = setup();
    ops.overwriteEdit(s, { media: M.a, srcIn: 0, srcOut: 2 }, 0, V1, A1);
    ops.overwriteEdit(s, { media: M.b, srcIn: 0, srcOut: 1 }, 60, V1, A1);
    s.playhead = 40;
    ops.rippleTrimToPlayhead(s, M, 'next');
    expect(vids(s, V1).map((c) => [c.start, c.duration])).toEqual([[0, 40], [40, 30]]);
    s.playhead = 10;
    ops.rippleTrimToPlayhead(s, M, 'previous');
    expect(vids(s, V1).map((c) => [c.start, c.duration])).toEqual([[0, 30], [30, 30]]);
    expect(s.playhead).toBe(0);
  });

  it('sequence never has overlapping clips on a track after random edits', () => {
    const { s, V1, V2, A1, M } = setup();
    let seed = 42;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const medias = [M.a, M.b, M.c];
    for (let i = 0; i < 400; i++) {
      const ids = Object.keys(s.clips);
      const pick = ids.length ? ids[rnd(ids.length)] : null;
      try {
        switch (rnd(10)) {
          case 0: ops.overwriteEdit(s, { media: medias[rnd(3)], srcIn: rnd(5), srcOut: 5 + rnd(5) }, rnd(600), rnd(2) ? V1 : V2, A1); break;
          case 1: ops.insertEdit(s, { media: medias[rnd(3)], srcIn: rnd(5), srcOut: 5 + rnd(5) }, rnd(600), V1, A1); break;
          case 2: ops.razor(s, rnd(900)); break;
          case 3: if (pick) ops.trimEdge(s, M, pick, rnd(2) ? 'in' : 'out', rnd(80) - 40, rnd(2) ? 'ripple' : 'normal'); break;
          case 4: if (pick) ops.rollEdit(s, M, pick, rnd(40) - 20); break;
          case 5: if (pick) ops.slip(s, M, pick, rnd(40) - 20); break;
          case 6: if (pick) ops.slide(s, M, pick, rnd(40) - 20); break;
          case 7: if (pick) ops.moveClips(s, [pick], rnd(100) - 50, 0, 0, rnd(2) ? 'insert' : 'overwrite'); break;
          case 8: if (pick) ops.rippleDelete(s, [pick]); break;
          case 9: if (pick) ops.deleteClips(s, [pick]); break;
        }
      } catch (e) { if (!(e instanceof ops.EditError)) throw e; }
      for (const t of s.tracks) {
        const cs = clipsOnTrack(s, t.id);
        for (let k = 0; k < cs.length; k++) {
          expect(cs[k].duration).toBeGreaterThanOrEqual(1);
          expect(cs[k].start).toBeGreaterThanOrEqual(0);
          if (k) expect(cs[k].start).toBeGreaterThanOrEqual(clipEnd(cs[k - 1]));
          const m = M[cs[k].mediaId];
          expect(cs[k].srcIn).toBeGreaterThanOrEqual(-1e-6);
          expect(clipSrcOut(cs[k], 30)).toBeLessThanOrEqual(m.duration + 1e-6);
        }
      }
    }
  });
});
