import { prefs } from './prefs';
import { produce } from 'immer';
import { create } from 'zustand';
import {
  Clip, Id, MediaItem, Project, Sequence, makeProject, makeSequence, newId, sequenceDuration,
} from '../core/model';
import * as ops from '../core/ops';
import type { JobProgress, MediaAssets, ProbeResult, SystemInfo } from '../shared/ipc';

export type Tool = 'select' | 'trackSelect' | 'ripple' | 'roll' | 'rate' | 'razor' | 'slip' | 'slide' | 'pen' | 'hand' | 'zoom' | 'type';
export type Mode = 'edit' | 'export';
export type PlaybackRes = 1 | 0.5 | 0.25;

export interface Toast { id: string; kind: 'info' | 'error' | 'success'; text: string }

interface HistoryEntry { project: Project; label: string }

export interface State {
  project: Project;
  projectPath: string | null;
  dirty: boolean;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** live preview of a drag in progress; replaces the active sequence when set */
  preview: Sequence | null;

  selection: Id[];
  selectedMedia: Id[];
  /** a transition picked in the timeline (by the clip it belongs to) */
  selTransition: Id | null;
  /** selected layer of the selected graphic clip */
  selLayer: string | null;
  /** an eyedropper is waiting for a click in the program monitor */
  monitorPick: boolean;
  /** mask being edited on the program monitor */
  selMask: string | null;
  /** program monitor shows the multicam angle grid */
  multicamView: boolean;
  /** live value while dragging (shown in the status bar) */
  toolTip: string | null;
  /** start screen (recent projects) */
  home: boolean;
  tool: Tool;
  mode: Mode;
  snap: boolean;
  linkedSelection: boolean;
  zoom: number; // px per frame
  scrollX: number;
  focus: 'project' | 'source' | 'program' | 'timeline';
  leftTab: 'project' | 'fx' | 'captions' | 'color' | 'effects' | 'mixer' | 'text' | 'markers';

  sourceMediaId: Id | null;
  sourceTime: number;

  playing: boolean;
  rate: number; // J/K/L shuttle rate
  playbackRes: PlaybackRes;
  useProxies: boolean;
  /** proxies were requested for everything (switch or slow playback) */
  proxyAll: boolean;

  assets: Record<string, MediaAssets>;
  proxies: Record<string, string>; // media path → proxy path
  needsProxy: Record<string, boolean>;
  /** media that decodes heavily (4K, HEVC, 10-bit, high bitrate…) */
  heavy: Record<string, boolean>;
  jobs: Record<string, JobProgress>;
  /** bumps when background stabiliser status changes (re-render banners) */
  stabTick: number;
  toasts: Toast[];
  sys: SystemInfo | null;
  clipboard: Clip[] | null;
  dialog: null | { kind: 'speed' | 'sequence' | 'shortcuts' | 'about' | 'recovery' | 'attributes' | 'reframe' | 'multicam' | 'prefs'; data?: unknown };
}

const initialProject = (() => {
  const p = makeProject('Adsız Proje');
  const s = makeSequence({ name: 'Sekans 01' });
  p.sequences[s.id] = s;
  p.activeSequenceId = s.id;
  return p;
})();

export const useStore = create<State>(() => ({
  project: initialProject,
  projectPath: null,
  dirty: false,
  past: [],
  future: [],
  preview: null,
  selection: [],
  selectedMedia: [],
  selTransition: null,
  selLayer: null,
  monitorPick: false,
  selMask: null,
  multicamView: false,
  toolTip: null,
  home: true,
  tool: 'select',
  mode: 'edit',
  snap: true,
  linkedSelection: true,
  zoom: 4,
  scrollX: 0,
  focus: 'timeline',
  leftTab: 'project',
  sourceMediaId: null,
  sourceTime: 0,
  playing: false,
  rate: 1,
  playbackRes: 1,
  useProxies: true,
  proxyAll: false,
  assets: {},
  proxies: {},
  needsProxy: {},
  heavy: {},
  jobs: {},
  stabTick: 0,
  toasts: [],
  sys: null,
  clipboard: null,
  dialog: null,
}));

const S = () => useStore.getState();
const set = useStore.setState;

// ------------------------------------------------------------------ selectors

export function activeSeq(st: State = S()): Sequence {
  if (st.preview) return st.preview;
  const id = st.project.activeSequenceId;
  return st.project.sequences[id ?? ''] ?? Object.values(st.project.sequences)[0];
}

export function committedSeq(st: State = S()): Sequence {
  const id = st.project.activeSequenceId;
  return st.project.sequences[id ?? ''] ?? Object.values(st.project.sequences)[0];
}

// ------------------------------------------------------------------ toasts

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = newId('t');
  set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3200);
}

// ------------------------------------------------------------------ history

const MAX_HISTORY = 300;

function commitProject(next: Project, label: string) {
  const st = S();
  if (next === st.project) return;
  const past = [...st.past, { project: st.project, label }];
  if (past.length > MAX_HISTORY) past.shift();
  set({ project: next, past, future: [], dirty: true, preview: null });
  window.kurgu?.journal(next);
}

/** apply an edit to the active sequence as one undoable step */
export function edit(label: string, fn: (s: Sequence, media: Record<Id, MediaItem>) => void): boolean {
  const st = S();
  const seqId = committedSeq(st).id;
  try {
    const next = produce(st.project, (draft) => { fn(draft.sequences[seqId], draft.media as Record<Id, MediaItem>); });
    commitProject(next, label);
    // drop selection of clips that no longer exist
    const seq = next.sequences[seqId];
    set((s) => ({ selection: s.selection.filter((id) => seq.clips[id]) }));
    return true;
  } catch (e) {
    if (e instanceof ops.EditError) { toast(translateError(e.message), 'error'); return false; }
    throw e;
  }
}

/** background results (e.g. a finished stabiliser render) written without an undo step */
export function patchProjectSilently(fn: (p: Project) => void) {
  const next = produce(S().project, (d) => { fn(d as Project); });
  set({ project: next, dirty: true });
  window.kurgu?.journal(next);
}

/** apply a change to the whole project */
export function editProject(label: string, fn: (p: Project) => void) {
  const next = produce(S().project, (d) => { fn(d as Project); });
  commitProject(next, label);
}

/** drags: compute from the committed state on every move without touching history */
export function previewEdit(fn: (s: Sequence, media: Record<Id, MediaItem>) => void) {
  const st = S();
  try {
    const next = produce(committedSeq(st), (d) => { fn(d as Sequence, st.project.media); });
    set({ preview: next });
  } catch (e) {
    if (!(e instanceof ops.EditError)) throw e;
  }
}

export function commitPreview(label: string) {
  const st = S();
  if (!st.preview) return;
  const seq = st.preview;
  const next = produce(st.project, (d) => { d.sequences[seq.id] = seq as Sequence; });
  commitProject(next, label);
}

export function cancelPreview() { set({ preview: null }); }

export function undo() {
  const st = S();
  const prev = st.past[st.past.length - 1];
  if (!prev) return;
  set({ project: prev.project, past: st.past.slice(0, -1), future: [{ project: st.project, label: prev.label }, ...st.future], dirty: true, preview: null });
  toast(`Geri alındı: ${prev.label}`);
  window.kurgu?.journal(prev.project);
}

export function redo() {
  const st = S();
  const next = st.future[0];
  if (!next) return;
  set({ project: next.project, future: st.future.slice(1), past: [...st.past, { project: st.project, label: next.label }], dirty: true, preview: null });
  toast(`Yinelendi: ${next.label}`);
  window.kurgu?.journal(next.project);
}

const ERRORS: Record<string, string> = {
  'Track is locked': 'İz kilitli',
  'No target track for this media': 'Bu medya için hedef iz yok — iz başlığındaki hedefi açın',
  'Ripple delete would break sync on another track': 'Dalgalı silme başka bir izde senkronu bozar (senkron kilidini kapatın)',
  'No gap here': 'Burada boşluk yok',
  'Closing the gap would break sync': 'Boşluğu kapatmak senkronu bozar',
  'Not enough room; turn on ripple': 'Yer yok — "sonraki klipleri kaydır" seçeneğini açın',
  'No track there': 'Orada iz yok',
  'No clip under the playhead': 'Oynatma kafasının altında klip yok',
  'A sequence needs at least one track of each kind': 'Her türden en az bir iz kalmalı',
  'Invalid speed': 'Geçersiz hız',
};
export function translateError(m: string): string { return ERRORS[m] ?? m; }

// ------------------------------------------------------------------ media import

export function mediaFromProbe(p: ProbeResult): MediaItem {
  return {
    id: newId('m'), path: p.path, name: p.name, kind: p.kind, duration: p.duration, fps: p.fps,
    width: p.width, height: p.height, hasVideo: p.hasVideo, hasAudio: p.hasAudio, audioChannels: p.audioChannels,
    sampleRate: p.sampleRate, codec: p.codec, binId: null, label: p.kind === 'audio' ? 'caribbean' : p.kind === 'image' ? 'lavender' : 'iris',
    online: true, markIn: null, markOut: null,
  };
}

export async function importPaths(paths: string[], opts: { createSequence?: boolean } = {}) {
  if (!paths.length || !window.kurgu) return [];
  set({ home: false });
  const results = await window.kurgu.probe(paths);
  const items: MediaItem[] = [];
  const failed: string[] = [];
  for (const r of results) {
    if ('error' in r) { failed.push(`${r.path.split(/[\\/]/).pop()}: ${r.error}`); continue; }
    const existing = Object.values(S().project.media).find((m) => m.path === r.path);
    if (existing) { items.push(existing); continue; }
    const m = mediaFromProbe(r);
    items.push(m);
    set((s) => ({ needsProxy: { ...s.needsProxy, [r.path]: r.needsProxy }, heavy: { ...s.heavy, [r.path]: !!r.heavy } }));
  }
  const fresh = items.filter((m) => !S().project.media[m.id]);
  if (fresh.length) {
    editProject(`İçe aktar (${fresh.length})`, (p) => {
      for (const m of fresh) p.media[m.id] = m;
      // first import into an empty project: match the sequence to the footage, like "new sequence from clip"
      const seq = p.activeSequenceId ? p.sequences[p.activeSequenceId] : null;
      const firstVideo = fresh.find((m) => m.kind === 'video' && m.width > 0);
      if (seq && firstVideo && Object.keys(seq.clips).length === 0 && Object.keys(p.media).length === fresh.length) {
        seq.width = firstVideo.width % 2 ? firstVideo.width + 1 : firstVideo.width;
        seq.height = firstVideo.height % 2 ? firstVideo.height + 1 : firstVideo.height;
        seq.fps = Math.round(firstVideo.fps * 1000) / 1000;
      }
    });
  }
  if (failed.length) toast(`İçe aktarılamadı: ${failed.join(', ')}`, 'error');
  else if (fresh.length) toast(`${fresh.length} dosya içe aktarıldı`, 'success');
  for (const m of fresh) void loadAssets(m);
  if (opts.createSequence && fresh.length) {
    const seq = committedSeq();
    edit('Sekansa ekle', (s) => {
      let at = sequenceDuration(s);
      const t = ops.targetTracks(s);
      for (const m of fresh) {
        const dur = m.kind === 'image' ? prefs().stillSec : m.duration;
        ops.overwriteEdit(s, { media: m, srcIn: 0, srcOut: dur }, at, t.video ?? s.tracks.find((x) => x.kind === 'video')!.id, t.audio ?? s.tracks.find((x) => x.kind === 'audio')!.id);
        at += Math.round(dur * s.fps);
      }
    });
    void seq;
  }
  return items;
}

export async function loadAssets(m: MediaItem) {
  if (!m.path || m.synthetic?.type === 'multicam' || m.synthetic?.type === 'nest') return; // nothing on disk to analyse
  // reopened projects: we still need to know how hard the file is to play
  if (S().needsProxy[m.path] === undefined && m.online !== false) {
    try {
      const [r] = await window.kurgu.probe([m.path]);
      if (r && !('error' in r)) set((s) => ({ needsProxy: { ...s.needsProxy, [m.path]: r.needsProxy }, heavy: { ...s.heavy, [m.path]: !!r.heavy } }));
    } catch { /* offline */ }
  }
  if (wantsProxy(m)) void ensureProxy(m.path);
  try {
    const a = await window.kurgu.assets(m.path);
    set((s) => ({ assets: { ...s.assets, [m.path]: a } }));
  } catch { /* thumbnails are optional */ }
}

/**
 * Proxy policy. The preview plays a light 540p copy; export always uses the originals.
 *  - files the preview can't decode at all → always
 *  - Preferences "Proxy: Açık" → every video
 *  - "Otomatik" (default) → heavy files (4K, HEVC/AV1, 10-bit, >25 Mbps, 50/60p), every >720p
 *    file on a weak computer, and anything once playback has started dropping frames
 */
export function wantsProxy(m: MediaItem): boolean {
  const st = S();
  if (m.kind !== 'video' || m.synthetic) return false;
  if (st.needsProxy[m.path]) return true;
  const mode = prefs().proxies;
  if (mode === 'off') return false;
  if (mode === 'on' || st.proxyAll) return true;
  return !!st.heavy[m.path] || (!!st.sys?.lowSpec && m.height > 720);
}

const proxyWaiters = new Map<string, Promise<string | null>>();
const proxyQueue: { path: string; resolve: (p: string | null) => void }[] = [];
let proxyRunning = 0;

function pumpProxies() {
  const limit = S().sys?.lowSpec ? 1 : 2; // a weak machine stays usable while proxies build
  while (proxyRunning < limit && proxyQueue.length) {
    const job = proxyQueue.shift()!;
    proxyRunning++;
    window.kurgu.makeProxy(job.path)
      .then((p) => { set((s) => ({ proxies: { ...s.proxies, [job.path]: p } })); job.resolve(p); })
      .catch((e) => { toast(`Proxy oluşturulamadı: ${(e as Error).message}`, 'error'); job.resolve(null); })
      .finally(() => { proxyRunning--; proxyWaiters.delete(job.path); pumpProxies(); });
  }
}

export function ensureProxy(path: string): Promise<string | null> {
  const have = S().proxies[path];
  if (have) return Promise.resolve(have);
  let w = proxyWaiters.get(path);
  if (!w) {
    w = new Promise<string | null>((resolve) => { proxyQueue.push({ path, resolve }); });
    proxyWaiters.set(path, w);
    pumpProxies();
  }
  return w;
}

/** make proxies for every video in the project (Proxy switch, slow playback) */
export function proxyEverything(reason?: string) {
  const st = S();
  const todo = Object.values(st.project.media).filter((m) => m.kind === 'video' && !m.synthetic && m.online !== false && !st.proxies[m.path]);
  if (!todo.length) return 0;
  set({ proxyAll: true, useProxies: true });
  if (reason) toast(reason, 'info');
  for (const m of todo) void ensureProxy(m.path);
  return todo.length;
}

/** the file the preview should play: proxy if we need/want one */
export function playbackPath(m: MediaItem): string | null {
  const st = S();
  const proxy = st.proxies[m.path];
  if (st.needsProxy[m.path]) return proxy ?? null; // can't play the original at all
  if (st.useProxies && proxy) return proxy;
  return m.path;
}

// ------------------------------------------------------------------ playhead

export function setPlayhead(frame: number) {
  const seq = committedSeq();
  const f = Math.max(0, Math.round(frame));
  if (seq.playhead === f) return;
  // playhead moves are not undo steps
  set((s) => ({ project: produce(s.project, (d) => { d.sequences[seq.id].playhead = f; }) }));
}

export function setSeqField<K extends 'inPoint' | 'outPoint'>(k: K, v: number | null) {
  const seq = committedSeq();
  set((s) => ({ project: produce(s.project, (d) => { d.sequences[seq.id][k] = v; }), dirty: true }));
}

export function selectClips(ids: Id[], additive = false) {
  const seq = activeSeq();
  const withLinks = S().linkedSelection ? ops.withLinked(seq, ids) : ids;
  set((s) => ({ selection: additive ? [...new Set([...s.selection, ...withLinks])] : withLinks, focus: 'timeline', selTransition: null }));
}

// ------------------------------------------------------------------ project files

export async function saveProject(as = false) {
  const st = S();
  const path = await window.kurgu.saveProject(st.project, as ? null : st.projectPath);
  if (path) {
    const name = path.split(/[\\/]/).pop()!.replace(/\.(basecut|kurgu)$/, '');
    set((s) => ({ projectPath: path, dirty: false, project: produce(s.project, (d) => { d.name = name; }) }));
    toast('Proje kaydedildi', 'success');
  }
}

export async function openProject(path?: string) {
  try {
    const r = await window.kurgu.openProject(path);
    if (!r) return;
    loadProject(r.project, r.path);
    set({ home: false });
  } catch (e) { toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'); }
}

export function loadProject(project: Project, path: string | null) {
  // JSON has no Infinity: stills come back with duration null
  project = produce(project, (d) => { for (const m of Object.values(d.media)) if (m.kind === 'image' && !Number.isFinite(m.duration as number)) m.duration = Infinity; });
  set({ project, projectPath: path, past: [], future: [], selection: [], dirty: false, preview: null, sourceMediaId: null });
  for (const m of Object.values(project.media)) void loadAssets(m);
  const onDisk = Object.values(project.media).filter((m) => m.synthetic?.type !== 'multicam' && m.synthetic?.type !== 'nest');
  void window.kurgu.pathExists(onDisk.map((m) => m.path)).then((exists) => {
    const offline = onDisk.filter((_, i) => !exists[i]);
    if (offline.length) {
      set((s) => ({ project: produce(s.project, (d) => { for (const m of offline) d.media[m.id].online = false; }) }));
      toast(`${offline.length} medya dosyası çevrimdışı (bulunamadı)`, 'error');
    }
  });
}

export function newProject() {
  const p = makeProject('Adsız Proje');
  const s = makeSequence({ name: 'Sekans 01' });
  p.sequences[s.id] = s;
  p.activeSequenceId = s.id;
  loadProject(p, null);
}

declare global {
  interface Window { kurgu: import('../shared/ipc').KurguApi }
}

// ------------------------------------------------------------------ relink offline media

/** find offline media by file name in a folder the user picks (searches sub-folders) */
export async function relinkOffline(only?: string[]) {
  const st = S();
  const off = Object.values(st.project.media).filter((m) => !m.online && m.path && (!only || only.includes(m.id)));
  if (!off.length) { toast('Çevrimdışı medya yok', 'info'); return; }
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const found = await window.kurgu.relinkSearch(off.map((m) => base(m.path)));
  if (!found) return;
  const fixed = off.filter((m) => found[base(m.path).toLowerCase()]);
  if (!fixed.length) { toast('Bu klasörde eksik dosyaların hiçbiri bulunamadı', 'error'); return; }
  editProject(`Medyayı yeniden bağla (${fixed.length})`, (p) => { for (const m of fixed) { p.media[m.id].path = found[base(m.path).toLowerCase()]; p.media[m.id].online = true; } });
  for (const m of fixed) void loadAssets(S().project.media[m.id]);
  toast(`${fixed.length}/${off.length} medya yeniden bağlandı`, fixed.length === off.length ? 'success' : 'info');
}

/** paths of files dropped from Explorer / Finder */
export function droppedPaths(dt: DataTransfer): string[] {
  return [...dt.files].map((f) => window.kurgu.pathForFile?.(f) || (f as File & { path?: string }).path || '').filter(Boolean);
}
