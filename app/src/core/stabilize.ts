// Warp Stabilizer: two-pass camera stabilisation (libvidstab motion analysis +
// smoothed camera path), rendered once in the background into a stabilised
// intermediate. Preview and export both read that intermediate, so what you see
// is exactly what you export, playback stays light, and export does no extra work.
//
// Measured on synthetic handheld footage (tests/stabilize.test.ts): frame-to-frame
// jitter drops by >95 %, a locked-off shot stays within ~1 px.

import type { Clip, MediaItem } from './model';
import { clipSrcOut } from './model';

export interface StabParams {
  /** 0 = smooth motion (keeps intentional pans), 1 = no motion (virtual tripod) */
  mode: number;
  /** 0..100 — how smooth the camera path is (smooth mode) */
  smooth: number;
  /** edges: 0 auto zoom (crop), 1 adaptive zoom, 2 synthesise edges (fill from neighbouring frames), 3 black edges */
  edges: number;
  /** extra zoom in % on top of the automatic one */
  zoom: number;
  /** 0..100 — sharpen to compensate for the zoom */
  sharpen: number;
  /** 0 = fast analysis, 1 = detailed (slower, better on low-texture shots) */
  detail: number;
}

export const DEFAULT_STAB: StabParams = { mode: 0, smooth: 50, edges: 0, zoom: 0, sharpen: 30, detail: 0 };

export function stabParams(p: Record<string, number> | undefined): StabParams {
  return { ...DEFAULT_STAB, ...(p ?? {}) } as StabParams;
}

export const STAB_HANDLE = 1; // seconds analysed beyond the clip on each side (for trims and smoothing at the ends)

/** source range a clip needs (seconds), and the range we analyse */
export function stabRange(c: Clip, m: MediaItem, fps: number): { need: [number, number]; analyse: [number, number] } {
  const a = Math.min(c.srcIn, clipSrcOut(c, fps)), b = Math.max(c.srcIn, clipSrcOut(c, fps));
  const D = Number.isFinite(m.duration) ? m.duration : b + STAB_HANDLE;
  // a clip can ask for more than the media has (fast ramps, frame hold at the end): the render can only cover the media
  return { need: [Math.min(a, D), Math.min(b, D)], analyse: [Math.max(0, a - STAB_HANDLE), Math.min(D, b + STAB_HANDLE)] };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** identifies a finished render: same source, same settings, enough range */
export function stabKey(m: MediaItem, p: StabParams, range: [number, number]): string {
  return [m.path, m.duration, p.mode, p.smooth, p.edges, p.zoom, p.sharpen, p.detail, r3(range[0]), r3(range[1])].join('|');
}

export interface StabResult { key: string; path: string; lo: number; hi: number }

/** the clip's enabled stabiliser effect, if any */
export function stabEffect(c: Clip) {
  return (c.effects ?? []).find((e) => e.type === 'warpstab' && e.enabled) ?? null;
}

/** where to read this clip's frames from, if a valid stabilised render exists */
export function stabilizedSource(c: Clip, m: MediaItem, fps: number): { path: string; offset: number; duration: number } | null {
  const e = stabEffect(c);
  if (!e || !c.stab || c.stream !== 'video' || m.kind !== 'video') return null;
  const p = stabParams(e.params);
  const { need } = stabRange(c, m, fps);
  const s = c.stab;
  if (s.lo > need[0] + 1e-3 || s.hi < need[1] - 1e-3) return null;
  if (s.key !== stabKey(m, p, [s.lo, s.hi])) return null;
  return { path: s.path, offset: s.lo, duration: s.hi - s.lo };
}

/** true when the clip has a stabiliser that still has to be (re)analysed */
export function needsStabilize(c: Clip, m: MediaItem | undefined, fps: number): boolean {
  return !!m && !!stabEffect(c) && m.kind === 'video' && !stabilizedSource(c, m, fps);
}

// ------------------------------------------------------------------ ffmpeg arguments

// same quoting as the other file arguments in our filter graphs (Windows drive colons escaped)
const escapePath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

/** pass 1: motion analysis into a .trf file */
export function detectArgs(src: string, range: [number, number], trf: string, p: StabParams): string[] {
  const opts = [
    `shakiness=${p.mode === 1 ? 10 : 8}`,
    'accuracy=15',
    `stepsize=${p.detail ? 4 : 6}`,
    `mincontrast=${p.detail ? 0.15 : 0.25}`,
    `result='${escapePath(trf)}'`,
  ];
  return ['-v', 'error', '-y', '-nostdin', '-progress', 'pipe:1', '-ss', String(range[0]), '-t', String(range[1] - range[0]), '-i', src,
    '-an', '-vf', `vidstabdetect=${opts.join(':')}`, '-f', 'null', '-'];
}

/** pass 2: smoothed camera path applied, edges handled, written as an edit-friendly intermediate */
export function transformArgs(src: string, range: [number, number], trf: string, out: string, p: StabParams, fps: number): string[] {
  const frames = Math.max(1, Math.round((range[1] - range[0]) * fps));
  // camera path low-pass: 0.15 s .. 2 s of frames for smooth motion; very long for a locked-off camera
  const smoothing = p.mode === 1 ? Math.min(frames, Math.round(fps * 5)) : Math.max(2, Math.round(fps * (0.15 + 1.85 * (p.smooth / 100))));
  const t = [
    `input='${escapePath(trf)}'`,
    `smoothing=${smoothing}`,
    'optalgo=gauss',
    'interpol=bicubic',
    `optzoom=${p.edges === 0 ? 1 : p.edges === 1 ? 2 : 0}`,
    ...(p.edges === 1 ? ['zoomspeed=0.25'] : []),
    `zoom=${p.zoom}`,
    `crop=${p.edges === 3 ? 'black' : 'keep'}`,
    'maxshift=-1', 'maxangle=-1',
  ];
  const chain = [`vidstabtransform=${t.join(':')}`];
  if (p.sharpen > 0) chain.push(`unsharp=5:5:${(p.sharpen / 100) * 1.2}:3:3:0`);
  chain.push('format=yuv420p');
  return ['-v', 'error', '-y', '-nostdin', '-progress', 'pipe:1', '-ss', String(range[0]), '-t', String(range[1] - range[0]), '-i', src,
    '-an', '-vf', chain.join(','), '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-g', String(Math.max(1, Math.round(fps / 2))), '-bf', '0',
    '-movflags', '+faststart', out];
}
