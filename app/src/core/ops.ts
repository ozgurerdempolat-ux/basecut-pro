// Edit operations on a Sequence. Each function mutates the sequence it is
// given (the store passes an immer draft, tests pass a clone) and throws
// EditError when the edit is not possible, leaving the caller to discard the
// draft. Nothing here knows about the UI.

import {
  Clip, Id, MediaItem, Sequence, Track, clipEnd, clipSrcOut, clipSrcSpan, clipsOnTrack,
  defaultTransform, makeTrack, newId, param, tracksOfKind,
} from './model';

export class EditError extends Error {}

const EPS = 1e-6;

// ---------------------------------------------------------------- helpers

export function getTrack(s: Sequence, id: Id): Track {
  const t = s.tracks.find((x) => x.id === id);
  if (!t) throw new EditError('Track not found');
  return t;
}

function getClip(s: Sequence, id: Id): Clip {
  const c = s.clips[id];
  if (!c) throw new EditError('Clip not found');
  return c;
}

/** clip ids plus their linked partners */
export function withLinked(s: Sequence, ids: Id[]): Id[] {
  const out = new Set(ids);
  const links = new Set(ids.map((id) => s.clips[id]?.linkId).filter(Boolean) as Id[]);
  if (links.size) for (const c of Object.values(s.clips)) if (c.linkId && links.has(c.linkId)) out.add(c.id);
  return [...out];
}

/** tracks that move when something ripples: unlocked and sync-locked, plus any explicitly given */
export function rippleTracks(s: Sequence, mustInclude: Id[] = []): Id[] {
  return s.tracks.filter((t) => !t.locked && (t.syncLock || mustInclude.includes(t.id))).map((t) => t.id);
}

/** media limits in seconds for a clip's source */
function mediaLimits(m: MediaItem | undefined): { min: number; max: number } {
  if (!m || m.kind === 'image' || !Number.isFinite(m.duration)) return { min: -Infinity, max: Infinity };
  return { min: 0, max: m.duration };
}

function srcPerFrame(c: Clip, fps: number): number {
  return Math.abs(c.speed) / fps;
}

/** largest number of frames a clip can grow at its in (head) or out (tail) edge within its media */
function headroom(c: Clip, m: MediaItem | undefined, fps: number, edge: 'in' | 'out'): number {
  const lim = mediaLimits(m);
  const per = srcPerFrame(c, fps);
  if (!Number.isFinite(lim.max)) return Infinity;
  const reversed = c.speed < 0;
  const extendsTowardStart = (edge === 'in') !== reversed; // in-edge of a forward clip reaches back into the source
  const room = extendsTowardStart ? c.srcIn - lim.min : lim.max - clipSrcOut(c, fps);
  return Math.max(0, Math.floor(room / per + EPS));
}

function prevOnTrack(s: Sequence, c: Clip): Clip | undefined {
  return clipsOnTrack(s, c.trackId).filter((x) => x.id !== c.id && clipEnd(x) <= c.start).pop();
}

function nextOnTrack(s: Sequence, c: Clip): Clip | undefined {
  return clipsOnTrack(s, c.trackId).find((x) => x.id !== c.id && x.start >= clipEnd(c));
}

function assertUnlocked(s: Sequence, trackId: Id): void {
  if (getTrack(s, trackId).locked) throw new EditError('Track is locked');
}

// ------------------------------------------------------------- primitives

/** deep copy that also works on immer drafts (structuredClone does not) */
export function cloneClip(c: Clip): Clip {
  return JSON.parse(JSON.stringify(c)) as Clip;
}

/**
 * Split every clip on the given tracks that crosses `frame`. Linked partners
 * split at the same frame stay linked to each other. Returns new right-hand ids.
 */
export function splitAt(s: Sequence, frame: number, trackIds: Id[]): Id[] {
  const newLinks = new Map<Id, Id>();
  const created: Id[] = [];
  for (const c of Object.values(s.clips)) {
    if (!trackIds.includes(c.trackId)) continue;
    if (frame <= c.start || frame >= clipEnd(c)) continue;
    const leftDur = frame - c.start;
    const right: Clip = cloneClip(c);
    right.id = newId('clip');
    right.start = frame;
    right.duration = c.duration - leftDur;
    if (c.speed >= 0) right.srcIn = c.srcIn + (leftDur / s.fps) * c.speed;
    else {
      // reversed: the left part shows the end of the source range
      right.srcIn = c.srcIn;
      c.srcIn = c.srcIn + (right.duration / s.fps) * Math.abs(c.speed);
    }
    if (c.linkId) {
      if (!newLinks.has(c.linkId)) newLinks.set(c.linkId, newId('link'));
      right.linkId = newLinks.get(c.linkId)!;
    }
    shiftKeyframes(right, -leftDur);
    delete right.transIn; // a transition belongs to the head of the original clip
    c.duration = leftDur;
    s.clips[right.id] = right;
    created.push(right.id);
  }
  return created;
}

function shiftKeyframes(c: Clip, delta: number): void {
  const all = [c.transform.posX, c.transform.posY, c.transform.scale, c.transform.rotation, c.transform.opacity, c.volumeDb];
  for (const p of all) {
    if (!p.keyframes.length) continue;
    p.keyframes = p.keyframes.map((k) => ({ ...k, frame: k.frame + delta }));
  }
}

/** remove everything on a track between [from, to): fully covered clips go, others are trimmed or split */
export function clearRange(s: Sequence, trackId: Id, from: number, to: number): void {
  if (to <= from) return;
  splitAt(s, from, [trackId]);
  splitAt(s, to, [trackId]);
  for (const c of clipsOnTrack(s, trackId)) {
    if (c.start >= from && clipEnd(c) <= to) delete s.clips[c.id];
  }
}

/** move clips that start at or after `at` by `delta` frames on the given tracks */
export function shiftFrom(s: Sequence, trackIds: Id[], at: number, delta: number): void {
  if (!delta) return;
  for (const c of Object.values(s.clips)) {
    if (trackIds.includes(c.trackId) && c.start >= at) c.start += delta;
  }
}

/** true if [from,to) on a track has no clip */
export function isRangeEmpty(s: Sequence, trackId: Id, from: number, to: number, ignore: Id[] = []): boolean {
  return !Object.values(s.clips).some(
    (c) => c.trackId === trackId && !ignore.includes(c.id) && c.start < to && clipEnd(c) > from,
  );
}

// ------------------------------------------------------------- source edits

export interface SourceRange {
  media: MediaItem;
  srcIn: number;
  srcOut: number;
  /** which streams to bring; defaults to whatever the media has */
  video?: boolean;
  audio?: boolean;
}

function buildClips(s: Sequence, src: SourceRange, at: number, vTrack: Id | null, aTrack: Id | null): Clip[] {
  const m = src.media;
  const span = Math.max(0, src.srcOut - src.srcIn);
  const duration = Math.max(1, Math.round(span * s.fps));
  const wantV = (src.video ?? true) && m.hasVideo && vTrack;
  const wantA = (src.audio ?? true) && m.hasAudio && aTrack;
  if (!wantV && !wantA) throw new EditError('No target track for this media');
  const linkId = wantV && wantA ? newId('link') : null;
  const base = (stream: 'video' | 'audio', trackId: Id): Clip => ({
    id: newId('clip'), trackId, mediaId: m.id, stream, start: at, duration, srcIn: src.srcIn, speed: 1,
    linkId, enabled: true, name: m.name, label: m.label, transform: defaultTransform(), volumeDb: param(0),
  });
  const out: Clip[] = [];
  if (wantV) out.push(base('video', vTrack as Id));
  if (wantA) out.push(base('audio', aTrack as Id));
  return out;
}

/** default target tracks: the targeted (or first) track of each kind */
export function targetTracks(s: Sequence): { video: Id | null; audio: Id | null } {
  const pick = (kind: 'video' | 'audio') => {
    const ts = tracksOfKind(s, kind);
    return (ts.find((t) => t.targeted) ?? null)?.id ?? null;
  };
  return { video: pick('video'), audio: pick('audio') };
}

export function insertEdit(s: Sequence, src: SourceRange, at: number, vTrack: Id | null, aTrack: Id | null): Id[] {
  for (const t of [vTrack, aTrack]) if (t) assertUnlocked(s, t);
  const clips = buildClips(s, src, at, vTrack, aTrack);
  const dur = clips[0].duration;
  const tracks = rippleTracks(s, clips.map((c) => c.trackId));
  splitAt(s, at, tracks);
  shiftFrom(s, tracks, at, dur);
  for (const c of clips) s.clips[c.id] = c;
  return clips.map((c) => c.id);
}

export function overwriteEdit(s: Sequence, src: SourceRange, at: number, vTrack: Id | null, aTrack: Id | null): Id[] {
  for (const t of [vTrack, aTrack]) if (t) assertUnlocked(s, t);
  const clips = buildClips(s, src, at, vTrack, aTrack);
  for (const c of clips) clearRange(s, c.trackId, at, at + c.duration);
  for (const c of clips) s.clips[c.id] = c;
  return clips.map((c) => c.id);
}

// ------------------------------------------------------------- cutting

/** razor: cut at frame on the given tracks (default all unlocked) */
export function razor(s: Sequence, frame: number, trackIds?: Id[]): Id[] {
  const tracks = (trackIds ?? s.tracks.map((t) => t.id)).filter((id) => !getTrack(s, id).locked);
  return splitAt(s, frame, tracks);
}

/** razor a single clip (and its linked partners) */
export function razorClip(s: Sequence, clipId: Id, frame: number, linked = true): Id[] {
  const ids = linked ? withLinked(s, [clipId]) : [clipId];
  return splitAt(s, frame, [...new Set(ids.map((id) => getClip(s, id).trackId))].filter((t) => !getTrack(s, t).locked));
}

export function deleteClips(s: Sequence, ids: Id[], linked = true): void {
  const all = linked ? withLinked(s, ids) : ids;
  for (const id of all) {
    const c = s.clips[id];
    if (!c) continue;
    assertUnlocked(s, c.trackId);
    delete s.clips[id];
  }
}

/**
 * Ripple delete: remove clips and close the gap on every sync-locked track.
 * Refuses (like the original) when closing the gap would push into content on
 * another sync-locked track and break sync.
 */
export function rippleDelete(s: Sequence, ids: Id[], linked = true): void {
  const all = linked ? withLinked(s, ids) : ids;
  const clips = all.map((id) => getClip(s, id));
  for (const c of clips) assertUnlocked(s, c.trackId);
  // group into contiguous ranges, process latest first so earlier ranges stay valid
  const ranges = mergeRanges(clips.map((c) => [c.start, clipEnd(c)] as [number, number]));
  const own = new Set(clips.map((c) => c.trackId));
  for (const id of all) delete s.clips[id];
  const tracks = rippleTracks(s, [...own]);
  for (const [from, to] of ranges.sort((a, b) => b[0] - a[0])) {
    for (const t of tracks) {
      if (!isRangeEmpty(s, t, from, to)) throw new EditError('Ripple delete would break sync on another track');
    }
    shiftFrom(s, tracks, to, -(to - from));
  }
}

function mergeRanges(r: [number, number][]): [number, number][] {
  const sorted = [...r].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([...x]);
  }
  return out;
}

/** close the gap on a track that contains `frame` (ripple, sync-locked) */
export function closeGapAt(s: Sequence, trackId: Id, frame: number): void {
  const clips = clipsOnTrack(s, trackId);
  let gapStart = 0;
  let gapEnd: number | null = null;
  for (const c of clips) {
    if (c.start > frame) { gapEnd = c.start; break; }
    gapStart = Math.max(gapStart, clipEnd(c));
  }
  if (gapEnd === null || frame < gapStart) throw new EditError('No gap here');
  const len = gapEnd - gapStart;
  const tracks = rippleTracks(s, [trackId]);
  for (const t of tracks) if (!isRangeEmpty(s, t, gapStart, gapEnd)) throw new EditError('Closing the gap would break sync');
  shiftFrom(s, tracks, gapEnd, -len);
}

/** remove every gap on all unlocked tracks, keeping linked clips together */
export function closeAllGaps(s: Sequence): void {
  let guard = 0;
  for (;;) {
    if (guard++ > 10000) break;
    const end = Math.max(0, ...Object.values(s.clips).map(clipEnd));
    let found = false;
    for (let f = 0; f < end && !found; f++) {
      const tracks = s.tracks.filter((t) => !t.locked);
      if (tracks.every((t) => isRangeEmpty(s, t.id, f, f + 1))) {
        // find the extent of this all-track gap
        let g = f;
        while (g < end && tracks.every((t) => isRangeEmpty(s, t.id, g, g + 1))) g++;
        shiftFrom(s, tracks.map((t) => t.id), g, -(g - f));
        found = true;
      }
    }
    if (!found) break;
  }
}

/** Lift: remove [in,out) from targeted tracks, leaving a gap */
export function lift(s: Sequence, from: number, to: number, trackIds?: Id[]): void {
  const tracks = (trackIds ?? s.tracks.filter((t) => t.targeted).map((t) => t.id)).filter((id) => !getTrack(s, id).locked);
  for (const t of tracks) clearRange(s, t, from, to);
}

/** Extract: remove [in,out) and close the gap on every sync-locked track */
export function extract(s: Sequence, from: number, to: number, trackIds?: Id[]): void {
  const target = (trackIds ?? s.tracks.filter((t) => t.targeted).map((t) => t.id)).filter((id) => !getTrack(s, id).locked);
  const tracks = rippleTracks(s, target);
  for (const t of tracks) clearRange(s, t, from, to);
  shiftFrom(s, tracks, to, -(to - from));
}

// ------------------------------------------------------------- trimming

export type Edge = 'in' | 'out';

/**
 * Trim one edge of a clip by delta frames (+ moves the edge right).
 * mode 'normal' (selection tool): stops at neighbours and media limits.
 * mode 'ripple' (ripple edit tool): later clips on sync-locked tracks follow.
 * Returns the delta actually applied.
 */
export function trimEdge(
  s: Sequence, media: Record<Id, MediaItem>, clipId: Id, edge: Edge, delta: number,
  mode: 'normal' | 'ripple' = 'normal', linked = true,
): number {
  const ids = linked ? withLinked(s, [clipId]) : [clipId];
  const clips = ids.map((id) => getClip(s, id));
  for (const c of clips) assertUnlocked(s, c.trackId);
  let d = Math.round(delta);
  for (const c of clips) {
    const m = media[c.mediaId];
    if (edge === 'out') {
      d = Math.max(d, 1 - c.duration); // keep at least 1 frame
      d = Math.min(d, headroom(c, m, s.fps, 'out'));
      if (mode === 'normal') {
        const nx = nextOnTrack(s, c);
        if (nx) d = Math.min(d, nx.start - clipEnd(c));
      }
    } else {
      d = Math.min(d, c.duration - 1);
      d = Math.max(d, -headroom(c, m, s.fps, 'in'));
      if (mode === 'normal') {
        const pv = prevOnTrack(s, c);
        d = Math.max(d, (pv ? clipEnd(pv) : 0) - c.start);
      }
    }
  }
  if (!d) return 0;
  const oldEnds = clips.map(clipEnd);
  for (const c of clips) {
    const per = srcPerFrame(c, s.fps);
    if (edge === 'out') {
      if (c.speed < 0) c.srcIn -= d * per;
      c.duration += d;
    } else {
      if (c.speed >= 0) c.srcIn += d * per;
      if (mode === 'normal') { c.start += d; c.duration -= d; shiftKeyframes(c, -d); }
      else { c.duration -= d; shiftKeyframes(c, -d); }
    }
  }
  if (mode === 'ripple') {
    const tracks = rippleTracks(s, clips.map((c) => c.trackId));
    const shift = edge === 'out' ? d : -d;
    const at = Math.min(...oldEnds);
    const exclude = new Set(ids);
    for (const c of Object.values(s.clips)) {
      if (!exclude.has(c.id) && tracks.includes(c.trackId) && c.start >= at) c.start += shift;
    }
  }
  return d;
}

/** Rolling edit: move the cut between two adjacent clips, total duration unchanged */
export function rollEdit(s: Sequence, media: Record<Id, MediaItem>, leftId: Id, delta: number, linked = true): number {
  const lefts = linked ? withLinked(s, [leftId]) : [leftId];
  const pairs = lefts.map((id) => {
    const l = getClip(s, id);
    assertUnlocked(s, l.trackId);
    return { l, r: clipsOnTrack(s, l.trackId).find((c) => c.start === clipEnd(l)) };
  });
  let d = Math.round(delta);
  for (const { l, r } of pairs) {
    d = Math.min(d, headroom(l, media[l.mediaId], s.fps, 'out'));
    d = Math.max(d, 1 - l.duration);
    if (r) {
      d = Math.min(d, r.duration - 1);
      d = Math.max(d, -headroom(r, media[r.mediaId], s.fps, 'in'));
    } else {
      const nx = nextOnTrack(s, l);
      if (nx) d = Math.min(d, nx.start - clipEnd(l));
    }
  }
  if (!d) return 0;
  for (const { l, r } of pairs) {
    // left tail moves by d
    if (l.speed < 0) l.srcIn -= d * srcPerFrame(l, s.fps);
    l.duration += d;
    if (r) {
      // right head moves by d, its end stays
      if (r.speed >= 0) r.srcIn += d * srcPerFrame(r, s.fps);
      r.start += d;
      r.duration -= d;
      shiftKeyframes(r, -d);
    }
  }
  return d;
}

/** Slip: change which part of the source is used, clip stays put */
export function slip(s: Sequence, media: Record<Id, MediaItem>, clipId: Id, deltaFrames: number, linked = true): number {
  const ids = linked ? withLinked(s, [clipId]) : [clipId];
  let d = deltaFrames;
  for (const id of ids) {
    const c = getClip(s, id);
    assertUnlocked(s, c.trackId);
    const lim = mediaLimits(media[c.mediaId]);
    const per = srcPerFrame(c, s.fps);
    const span = clipSrcSpan(c, s.fps);
    const minD = (lim.min - c.srcIn) / per;
    const maxD = (lim.max - span - c.srcIn) / per;
    d = Math.max(Math.ceil(minD - EPS), Math.min(Math.floor(maxD + EPS), d));
  }
  if (!d) return 0;
  for (const id of ids) {
    const c = getClip(s, id);
    c.srcIn += d * srcPerFrame(c, s.fps) * (c.speed < 0 ? -1 : 1);
  }
  return d;
}

/** Slide: move a clip between its neighbours, which trim to compensate */
export function slide(s: Sequence, media: Record<Id, MediaItem>, clipId: Id, delta: number, linked = true): number {
  const ids = linked ? withLinked(s, [clipId]) : [clipId];
  let d = Math.round(delta);
  const plan = ids.map((id) => {
    const c = getClip(s, id);
    assertUnlocked(s, c.trackId);
    const pv = prevOnTrack(s, c);
    const nx = nextOnTrack(s, c);
    const pvAdj = pv && clipEnd(pv) === c.start ? pv : undefined;
    const nxAdj = nx && nx.start === clipEnd(c) ? nx : undefined;
    // moving right: prev grows (out), next shrinks (in)
    let maxR = Infinity, maxL = Infinity;
    if (pvAdj) { maxR = Math.min(maxR, headroom(pvAdj, media[pvAdj.mediaId], s.fps, 'out')); maxL = Math.min(maxL, pvAdj.duration - 1); }
    else maxL = Math.min(maxL, c.start - (pv ? clipEnd(pv) : 0));
    if (nxAdj) { maxR = Math.min(maxR, nxAdj.duration - 1); maxL = Math.min(maxL, headroom(nxAdj, media[nxAdj.mediaId], s.fps, 'in')); }
    else maxR = Math.min(maxR, nx ? nx.start - clipEnd(c) : Infinity);
    return { c, pvAdj, nxAdj, maxR, maxL };
  });
  for (const p of plan) d = Math.max(-p.maxL, Math.min(p.maxR, d));
  if (!d) return 0;
  for (const p of plan) {
    if (p.pvAdj) rawEdge(s, p.pvAdj, 'out', d);
    if (p.nxAdj) rawEdge(s, p.nxAdj, 'in', d);
    p.c.start += d;
  }
  return d;
}

/** move one edge by d frames with no limit checks (callers have clamped already) */
function rawEdge(s: Sequence, c: Clip, edge: Edge, d: number): void {
  const per = srcPerFrame(c, s.fps);
  if (edge === 'out') {
    if (c.speed < 0) c.srcIn -= d * per;
    c.duration += d;
  } else {
    if (c.speed >= 0) c.srcIn += d * per;
    c.start += d;
    c.duration -= d;
    shiftKeyframes(c, -d);
  }
}

/** Rate stretch: change duration by changing speed; source range stays the same */
export function rateStretch(s: Sequence, clipId: Id, edge: Edge, delta: number, linked = true): number {
  const ids = linked ? withLinked(s, [clipId]) : [clipId];
  let d = Math.round(delta);
  for (const id of ids) {
    const c = getClip(s, id);
    assertUnlocked(s, c.trackId);
    if (edge === 'out') {
      d = Math.max(d, 1 - c.duration);
      const nx = nextOnTrack(s, c);
      if (nx) d = Math.min(d, nx.start - clipEnd(c));
    } else {
      d = Math.min(d, c.duration - 1);
      const pv = prevOnTrack(s, c);
      d = Math.max(d, (pv ? clipEnd(pv) : 0) - c.start);
    }
  }
  if (!d) return 0;
  for (const id of ids) {
    const c = getClip(s, id);
    const span = clipSrcSpan(c, s.fps);
    const newDur = edge === 'out' ? c.duration + d : c.duration - d;
    if (edge === 'in') c.start += d;
    c.duration = newDur;
    c.speed = Math.sign(c.speed || 1) * (span / (newDur / s.fps));
  }
  return d;
}

/** Speed/Duration dialog */
export function setSpeed(s: Sequence, clipId: Id, speed: number, ripple: boolean, linked = true): void {
  if (!speed || !Number.isFinite(speed)) throw new EditError('Invalid speed');
  const ids = linked ? withLinked(s, [clipId]) : [clipId];
  const clips = ids.map((id) => getClip(s, id));
  const oldEnd = Math.max(...clips.map(clipEnd));
  let newDur = 0;
  for (const c of clips) {
    const span = clipSrcSpan(c, s.fps);
    newDur = Math.max(1, Math.round((span / Math.abs(speed)) * s.fps));
  }
  const delta = newDur - clips[0].duration;
  if (!ripple && delta > 0) {
    for (const c of clips) {
      const nx = nextOnTrack(s, c);
      if (nx && clipEnd(c) + delta > nx.start) throw new EditError('Not enough room; turn on ripple');
    }
  }
  for (const c of clips) {
    const span = clipSrcSpan(c, s.fps);
    c.duration = newDur;
    c.speed = speed;
    // keep the same source range (rounding may change it by < 1 frame)
    void span;
  }
  if (ripple && delta) {
    const tracks = rippleTracks(s, clips.map((c) => c.trackId));
    const moved = new Set(ids);
    for (const c of Object.values(s.clips)) if (!moved.has(c.id) && tracks.includes(c.trackId) && c.start >= oldEnd) c.start += delta;
  }
}

// ------------------------------------------------------------- moving

/**
 * Drag clips: move by dFrames and by dTracks (within the same track kind).
 * Overwrites whatever is at the destination, like the selection tool does.
 * Ctrl-drag "insert" mode ripples the destination instead.
 */
export function moveClips(
  s: Sequence, ids: Id[], dFrames: number, dVideoTracks = 0, dAudioTracks = 0,
  mode: 'overwrite' | 'insert' = 'overwrite', linked = true,
): void {
  const all = linked ? withLinked(s, ids) : ids;
  const clips = all.map((id) => getClip(s, id));
  const minStart = Math.min(...clips.map((c) => c.start));
  const df = Math.max(dFrames, -minStart);
  const plan = clips.map((c) => {
    const kindTracks = tracksOfKind(s, c.stream === 'video' ? 'video' : 'audio');
    const idx = kindTracks.findIndex((t) => t.id === c.trackId);
    const dt = c.stream === 'video' ? dVideoTracks : dAudioTracks;
    const dest = kindTracks[idx + dt];
    if (!dest) throw new EditError('No track there');
    if (dest.locked || getTrack(s, c.trackId).locked) throw new EditError('Track is locked');
    return { c, dest: dest.id, start: c.start + df };
  });
  for (const p of plan) delete s.clips[p.c.id];
  if (mode === 'insert') {
    const at = Math.min(...plan.map((p) => p.start));
    const len = Math.max(...plan.map((p) => p.start + p.c.duration)) - at;
    const tracks = rippleTracks(s, plan.map((p) => p.dest));
    splitAt(s, at, tracks);
    shiftFrom(s, tracks, at, len);
  } else {
    for (const p of plan) clearRange(s, p.dest, p.start, p.start + p.c.duration);
  }
  for (const p of plan) { p.c.trackId = p.dest; p.c.start = p.start; s.clips[p.c.id] = p.c; }
}

/** nudge by frames without crossing neighbours (Alt+arrow) */
export function nudge(s: Sequence, ids: Id[], d: number): void {
  moveClips(s, ids, d, 0, 0, 'overwrite');
}

export function link(s: Sequence, ids: Id[]): void {
  const linkId = newId('link');
  for (const id of ids) getClip(s, id).linkId = linkId;
}

export function unlink(s: Sequence, ids: Id[]): void {
  for (const id of withLinked(s, ids)) getClip(s, id).linkId = null;
}

export function setEnabled(s: Sequence, ids: Id[], enabled: boolean): void {
  for (const id of ids) getClip(s, id).enabled = enabled;
}

// ------------------------------------------------------------- tracks

export function addTrack(s: Sequence, kind: 'video' | 'audio'): Id {
  const n = tracksOfKind(s, kind).length + 1;
  const t = makeTrack(kind, n);
  t.targeted = false;
  if (kind === 'video') {
    const lastVideo = s.tracks.map((x) => x.kind).lastIndexOf('video');
    s.tracks.splice(lastVideo + 1, 0, t);
  } else s.tracks.push(t);
  return t.id;
}

export function deleteTrack(s: Sequence, trackId: Id): void {
  const t = getTrack(s, trackId);
  if (tracksOfKind(s, t.kind).length <= 1) throw new EditError('A sequence needs at least one track of each kind');
  for (const c of Object.values(s.clips)) if (c.trackId === trackId) delete s.clips[c.id];
  s.tracks = s.tracks.filter((x) => x.id !== trackId);
  tracksOfKind(s, t.kind).forEach((x, i) => {
    if (/^[VA]\d+$/.test(x.name)) x.name = `${t.kind === 'video' ? 'V' : 'A'}${i + 1}`;
  });
}

/** move a track up or down within its kind (a requested missing feature) */
export function moveTrack(s: Sequence, trackId: Id, dir: -1 | 1): void {
  const t = getTrack(s, trackId);
  const same = tracksOfKind(s, t.kind);
  const i = same.indexOf(t);
  const j = i + dir;
  if (j < 0 || j >= same.length) return;
  const a = s.tracks.indexOf(same[i]);
  const b = s.tracks.indexOf(same[j]);
  [s.tracks[a], s.tracks[b]] = [s.tracks[b], s.tracks[a]];
}

export function targetTrack(s: Sequence, trackId: Id): void {
  const t = getTrack(s, trackId);
  for (const x of s.tracks) if (x.kind === t.kind) x.targeted = x.id === trackId ? !x.targeted : false;
}

// ------------------------------------------------------------- markers

export function addMarker(s: Sequence, frame: number, name = ''): Id {
  const id = newId('mk');
  s.markers.push({ id, frame, duration: 0, name, comment: '', color: 'green' });
  s.markers.sort((a, b) => a.frame - b.frame);
  return id;
}

// ------------------------------------------------------------- navigation

/** all cut points (clip starts/ends) on unmuted tracks, sorted, unique */
export function editPoints(s: Sequence, trackIds?: Id[]): number[] {
  const set = new Set<number>([0]);
  for (const c of Object.values(s.clips)) {
    if (trackIds && !trackIds.includes(c.trackId)) continue;
    set.add(c.start);
    set.add(clipEnd(c));
  }
  return [...set].sort((a, b) => a - b);
}

/** clips under the playhead on given tracks */
export function clipsAt(s: Sequence, frame: number, trackIds?: Id[]): Clip[] {
  return Object.values(s.clips).filter(
    (c) => (!trackIds || trackIds.includes(c.trackId)) && c.start <= frame && clipEnd(c) > frame,
  );
}

/** Q / W: ripple trim previous/next edit of clips under playhead to playhead */
export function rippleTrimToPlayhead(s: Sequence, media: Record<Id, MediaItem>, which: 'previous' | 'next'): void {
  const f = s.playhead;
  const targeted = s.tracks.filter((t) => t.targeted && !t.locked).map((t) => t.id);
  const under = clipsAt(s, f, targeted.length ? targeted : undefined);
  if (!under.length) throw new EditError('No clip under the playhead');
  const c = under[0];
  if (which === 'next') {
    const d = f - clipEnd(c);
    trimEdge(s, media, c.id, 'out', d, 'ripple');
  } else {
    const d = f - c.start;
    trimEdge(s, media, c.id, 'in', d, 'ripple');
    s.playhead = c.start;
  }
}
