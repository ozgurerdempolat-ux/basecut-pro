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
  tool: Tool;
  mode: Mode;
  snap: boolean;
  linkedSelection: boolean;
  zoom: number; // px per frame
  scrollX: number;
  focus: 'project' | 'source' | 'program' | 'timeline';
  leftTab: 'project' | 'fx' | 'captions';

  sourceMediaId: Id | null;
  sourceTime: number;

  playing: boolean;
  rate: number; // J/K/L shuttle rate
  playbackRes: PlaybackRes;
  useProxies: boolean;

  assets: Record<string, MediaAssets>;
  proxies: Record<string, string>; // media path → proxy path
  needsProxy: Record<string, boolean>;
  jobs: Record<string, JobProgress>;
  toasts: Toast[];
  sys: SystemInfo | null;
  clipboard: Clip[] | null;
  dialog: null | { kind: 'speed' | 'sequence' | 'shortcuts' | 'about' | 'recovery'; data?: unknown };
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
  assets: {},
  proxies: {},
  needsProxy: {},
  jobs: {},
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
  const results = await window.kurgu.probe(paths);
  const items: MediaItem[] = [];
  const failed: string[] = [];
  for (const r of results) {
    if ('error' in r) { failed.push(`${r.path.split(/[\\/]/).pop()}: ${r.error}`); continue; }
    const existing = Object.values(S().project.media).find((m) => m.path === r.path);
    if (existing) { items.push(existing); continue; }
    const m = mediaFromProbe(r);
    items.push(m);
    set((s) => ({ needsProxy: { ...s.needsProxy, [r.path]: r.needsProxy } }));
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
        const dur = m.kind === 'image' ? 5 : m.duration;
        ops.overwriteEdit(s, { media: m, srcIn: 0, srcOut: dur }, at, t.video ?? s.tracks.find((x) => x.kind === 'video')!.id, t.audio ?? s.tracks.find((x) => x.kind === 'audio')!.id);
        at += Math.round(dur * s.fps);
      }
    });
    void seq;
  }
  return items;
}

export async function loadAssets(m: MediaItem) {
  try {
    const a = await window.kurgu.assets(m.path);
    set((s) => ({ assets: { ...s.assets, [m.path]: a } }));
  } catch { /* thumbnails are optional */ }
  const st = S();
  const big = m.kind === 'video' && m.height > 720;
  if (st.needsProxy[m.path] || (st.sys?.lowSpec && big)) void ensureProxy(m.path);
}

export async function ensureProxy(path: string) {
  if (S().proxies[path]) return S().proxies[path];
  try {
    const p = await window.kurgu.makeProxy(path);
    set((s) => ({ proxies: { ...s.proxies, [path]: p } }));
    return p;
  } catch (e) {
    toast(`Proxy oluşturulamadı: ${(e as Error).message}`, 'error');
    return null;
  }
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
  set((s) => ({ selection: additive ? [...new Set([...s.selection, ...withLinks])] : withLinks, focus: 'timeline' }));
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

export async function openProject() {
  const r = await window.kurgu.openProject();
  if (!r) return;
  loadProject(r.project, r.path);
}

export function loadProject(project: Project, path: string | null) {
  // JSON has no Infinity: stills come back with duration null
  project = produce(project, (d) => { for (const m of Object.values(d.media)) if (m.kind === 'image' && !Number.isFinite(m.duration as number)) m.duration = Infinity; });
  set({ project, projectPath: path, past: [], future: [], selection: [], dirty: false, preview: null, sourceMediaId: null });
  for (const m of Object.values(project.media)) void loadAssets(m);
  void window.kurgu.pathExists(Object.values(project.media).map((m) => m.path)).then((exists) => {
    const offline = Object.values(project.media).filter((_, i) => !exists[i]);
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
