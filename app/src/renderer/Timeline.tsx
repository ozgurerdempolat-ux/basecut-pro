import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Clip, Id, Sequence, Track, clipEnd, framesToTimecode, sequenceDuration, timecodeToFrames } from '../core/model';
import * as ops from '../core/ops';
import { I } from './icons';
import { FX_MIME, FxDrag, addAudioEffect, addEffect, addTransition, transitionTarget } from './Effects';
import { clipMenu, laneMenu, trackMenu, transitionMenu } from './menus';
import { openNested } from './multicam';
import { stabilizedSource } from '../core/stabilize';
import { hasRemap } from '../core/model';
import { stabStatus } from './stabilizer';
import { TRANSITION_BY_ID, transitionWindows } from '../core/fx';
import { AUDIO_TRANSITIONS } from '../core/audiofx';
import { player } from './player';
import {
  activeSeq, cancelPreview, commitPreview, committedSeq, edit, previewEdit, selectClips, setPlayhead, toast, useStore,
} from './store';

const HEADER_W = 168;
const SNAP_PX = 9;

interface Lane { track: Track; y: number; h: number }

function layoutLanes(seq: Sequence): { lanes: Lane[]; height: number; sepY: number } {
  const vids = seq.tracks.filter((t) => t.kind === 'video').slice().reverse();
  const auds = seq.tracks.filter((t) => t.kind === 'audio');
  const lanes: Lane[] = [];
  let y = 0;
  for (const t of vids) { lanes.push({ track: t, y, h: t.height }); y += t.height; }
  const sepY = y;
  y += 4;
  for (const t of auds) { lanes.push({ track: t, y, h: t.height }); y += t.height; }
  return { lanes, height: y, sepY };
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'move'; ids: Id[]; startX: number; startY: number; lane: number; insert: boolean; linked: boolean; anchor: number; anchorEnd: number }
  | { kind: 'trim'; id: Id; edge: ops.Edge; mode: 'normal' | 'ripple' | 'roll' | 'rate'; startX: number; anchor: number; linked: boolean }
  | { kind: 'slip'; id: Id; startX: number; linked: boolean }
  | { kind: 'slide'; id: Id; startX: number; anchor: number; anchorEnd: number; linked: boolean }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: 'hand'; startX: number; startY: number; sx: number; sy: number };

export function Timeline() {
  const seq = useStore((s) => activeSeq(s));
  const committed = useStore((s) => committedSeq(s));
  const zoom = useStore((s) => s.zoom);
  const tool = useStore((s) => s.tool);
  const selection = useStore((s) => s.selection);
  const selTransition = useStore((s) => s.selTransition);
  const snapOn = useStore((s) => s.snap);
  const linkedSel = useStore((s) => s.linkedSelection);
  const focused = useStore((s) => s.focus === 'timeline');
  const project = useStore((s) => s.project);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dropLane, setDropLane] = useState<number | null>(null);
  const [viewW, setViewW] = useState(800);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });

  const { lanes, height, sepY } = useMemo(() => layoutLanes(seq), [seq]);
  const capH = seq.captions?.items.length ? 28 : 0;
  const capRef = useRef(capH);
  capRef.current = capH;
  const total = sequenceDuration(seq);
  const contentW = Math.max(viewW, (total + seq.fps * 30) * zoom);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // follow the playhead while playing (page-turn style, like the original)
  const playing = useStore((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    const el = scrollRef.current!;
    const x = committed.playhead * zoom;
    if (x > el.scrollLeft + el.clientWidth - 20 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 40);
  }, [committed.playhead, playing, zoom]);

  // zoom keeping the playhead in place
  const prevZoom = useRef(zoom);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || prevZoom.current === zoom) return;
    const ph = committed.playhead;
    const screenX = ph * prevZoom.current - el.scrollLeft;
    el.scrollLeft = Math.max(0, ph * zoom - screenX);
    prevZoom.current = zoom;
  }, [zoom, committed.playhead]);

  const frameAtClientX = useCallback((clientX: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + el.scrollLeft) / zoom);
  }, [zoom]);

  const laneAtClientY = useCallback((clientY: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    const y = clientY - r.top + el.scrollTop - 26 - capRef.current;
    return lanes.findIndex((l) => y >= l.y && y < l.y + l.h);
  }, [lanes]);

  /** snap a frame to nearby edit points / playhead / markers */
  const snapFrame = useCallback((f: number, exclude: Set<Id>): { f: number; snapped: boolean } => {
    if (!useStore.getState().snap) return { f: Math.round(f), snapped: false };
    const base = committedSeq();
    const pts = new Set<number>([base.playhead, 0]);
    if (base.inPoint !== null) pts.add(base.inPoint);
    if (base.outPoint !== null) pts.add(base.outPoint);
    for (const m of base.markers) pts.add(m.frame);
    for (const c of Object.values(base.clips)) {
      if (exclude.has(c.id)) continue;
      pts.add(c.start); pts.add(clipEnd(c));
    }
    let best = Math.round(f);
    let bestD = SNAP_PX / zoom;
    let snapped = false;
    for (const p of pts) {
      const d = Math.abs(p - f);
      if (d < bestD) { bestD = d; best = p; snapped = true; }
    }
    return { f: best, snapped };
  }, [zoom]);

  // ---------------------------------------------------------------- pointer handling

  const onMouseMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const st = useStore.getState();
    const fps = committedSeq(st).fps;
    const showTip = (text: string) => setTip({ x: e.clientX + 14, y: e.clientY + 14, text });
    switch (d.kind) {
      case 'scrub': {
        const { f } = snapFrame(frameAtClientX(e.clientX), new Set());
        setPlayhead(f);
        break;
      }
      case 'hand': {
        const el = scrollRef.current!;
        el.scrollLeft = d.sx - (e.clientX - d.startX);
        el.scrollTop = d.sy - (e.clientY - d.startY);
        break;
      }
      case 'marquee': {
        const el = scrollRef.current!;
        const r = el.getBoundingClientRect();
        d.x1 = e.clientX - r.left + el.scrollLeft;
        d.y1 = e.clientY - r.top + el.scrollTop - 26 - capRef.current;
        setMarquee({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) });
        break;
      }
      case 'move': {
        const raw = (e.clientX - d.startX) / zoom;
        const excl = new Set(d.ids);
        // snap either the left or right edge of the moved block, whichever is closer
        const a = snapFrame(d.anchor + raw, excl);
        const b = snapFrame(d.anchorEnd + raw, excl);
        let delta = Math.round(raw);
        let sn: number | null = null;
        if (a.snapped && (!b.snapped || Math.abs(a.f - (d.anchor + raw)) <= Math.abs(b.f - (d.anchorEnd + raw)))) { delta = a.f - d.anchor; sn = a.f; }
        else if (b.snapped) { delta = b.f - d.anchorEnd; sn = b.f; }
        setSnapAt(sn);
        const li = laneAtClientY(e.clientY);
        const startLane = lanes[d.lane];
        let dv = 0, da = 0;
        if (li >= 0 && startLane) {
          const target = lanes[li].track;
          if (target.kind === startLane.track.kind) {
            const kindTracks = committedSeq(st).tracks.filter((t) => t.kind === target.kind);
            const off = kindTracks.indexOf(target) - kindTracks.findIndex((t) => t.id === startLane.track.id);
            if (target.kind === 'video') dv = off; else da = off;
          }
        }
        const insert = d.insert || e.ctrlKey || e.metaKey;
        previewEdit((s) => ops.moveClips(s, d.ids, delta, dv, da, insert ? 'insert' : 'overwrite', d.linked && !e.altKey));
        showTip(`${delta >= 0 ? '+' : '−'}${framesToTimecode(Math.abs(delta), fps)}${insert ? '  ekle' : ''}`);
        break;
      }
      case 'trim': {
        const raw = (e.clientX - d.startX) / zoom;
        const { f, snapped } = snapFrame(d.anchor + raw, new Set(ops.withLinked(committedSeq(st), [d.id])));
        setSnapAt(snapped ? f : null);
        const delta = f - d.anchor;
        let applied = 0;
        previewEdit((s, media) => {
          if (d.mode === 'roll') applied = ops.rollEdit(s, media, d.edge === 'out' ? d.id : prevAdjacent(s, d.id) ?? d.id, delta, d.linked && !e.altKey);
          else if (d.mode === 'rate') applied = ops.rateStretch(s, d.id, d.edge, delta, d.linked && !e.altKey);
          else applied = ops.trimEdge(s, media, d.id, d.edge, delta, d.mode, d.linked && !e.altKey);
        });
        const c = useStore.getState().preview?.clips[d.id];
        showTip(`${applied >= 0 ? '+' : '−'}${framesToTimecode(Math.abs(applied), fps)}${c ? `   süre ${framesToTimecode(c.duration, fps)}` : ''}${d.mode === 'rate' && c ? `   %${Math.round(c.speed * 100)}` : ''}`);
        break;
      }
      case 'slip': {
        const delta = Math.round((e.clientX - d.startX) / zoom);
        let applied = 0;
        previewEdit((s, media) => { applied = ops.slip(s, media, d.id, -delta, d.linked && !e.altKey); });
        const c = useStore.getState().preview?.clips[d.id];
        showTip(`kayma ${applied >= 0 ? '+' : '−'}${framesToTimecode(Math.abs(applied), fps)}${c ? `   kaynak ${c.srcIn.toFixed(2)}s` : ''}`);
        break;
      }
      case 'slide': {
        const raw = (e.clientX - d.startX) / zoom;
        const { f, snapped } = snapFrame(d.anchor + raw, new Set([d.id]));
        setSnapAt(snapped ? f : null);
        let applied = 0;
        previewEdit((s, media) => { applied = ops.slide(s, media, d.id, f - d.anchor, d.linked && !e.altKey); });
        showTip(`kaydır ${applied >= 0 ? '+' : '−'}${framesToTimecode(Math.abs(applied), fps)}`);
        break;
      }
    }
  }, [zoom, frameAtClientX, laneAtClientY, lanes, snapFrame]);

  const onMouseUp = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setSnapAt(null);
    setTip(null);
    if (!d) return;
    const st = useStore.getState();
    if (d.kind === 'marquee') {
      setMarquee(null);
      const x0 = Math.min(d.x0, d.x1) / zoom, x1 = Math.max(d.x0, d.x1) / zoom;
      const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if (Math.abs(d.x1 - d.x0) < 3 && Math.abs(d.y1 - d.y0) < 3) { if (!d.additive) useStore.setState({ selection: [] }); return; }
      const hit = Object.values(committedSeq(st).clips).filter((c) => {
        const lane = lanes.find((l) => l.track.id === c.trackId);
        return lane && c.start < x1 && clipEnd(c) > x0 && lane.y < y1 && lane.y + lane.h > y0;
      }).map((c) => c.id);
      selectClips(hit, d.additive);
      return;
    }
    if (st.preview) {
      const label = d.kind === 'move' ? 'Klip taşı' : d.kind === 'trim' ? ({ normal: 'Kırp', ripple: 'Dalgalı kırp', roll: 'Kaydırarak kırp', rate: 'Hız esnet' } as const)[d.mode] : d.kind === 'slip' ? 'Slip' : d.kind === 'slide' ? 'Slide' : 'Düzenle';
      const changed = JSON.stringify(st.preview.clips) !== JSON.stringify(committedSeq(st).clips);
      if (changed) commitPreview(label); else cancelPreview();
    }
    void e;
  }, [lanes, zoom]);

  // handlers change identity on every render (they close over zoom/lanes);
  // window listeners must not, or a drag dies after its first update
  const moveRef = useRef(onMouseMove);
  const upRef = useRef(onMouseUp);
  moveRef.current = onMouseMove;
  upRef.current = onMouseUp;
  const stableMove = useRef((e: MouseEvent) => moveRef.current(e)).current;
  const stableUp = useRef((e: MouseEvent) => {
    window.removeEventListener('mousemove', stableMove);
    window.removeEventListener('mouseup', stableUp);
    upRef.current(e);
  }).current;

  const beginDrag = (d: Drag) => {
    dragRef.current = d;
    window.addEventListener('mousemove', stableMove);
    window.addEventListener('mouseup', stableUp);
  };

  useEffect(() => () => {
    window.removeEventListener('mousemove', stableMove);
    window.removeEventListener('mouseup', stableUp);
  }, [stableMove, stableUp]);

  const onClipMouseDown = (e: React.MouseEvent, c: Clip, edge: ops.Edge | null) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    useStore.setState({ focus: 'timeline' });
    const st = useStore.getState();
    const linked = st.linkedSelection;
    const frame = frameAtClientX(e.clientX);
    switch (st.tool) {
      case 'razor': {
        const { f } = snapFrame(frame, new Set());
        edit('Jilet', (s) => { if (e.shiftKey) ops.razor(s, f); else ops.razorClip(s, c.id, f, linked && !e.altKey); });
        return;
      }
      case 'trackSelect': {
        const base = committedSeq(st);
        const ids = Object.values(base.clips).filter((x) => clipEnd(x) > frame && (!e.shiftKey || x.trackId === c.trackId)).map((x) => x.id);
        selectClips(ids);
        if (ids.length) beginMove(e, ids, c);
        return;
      }
      case 'hand': return beginDrag({ kind: 'hand', startX: e.clientX, startY: e.clientY, sx: scrollRef.current!.scrollLeft, sy: scrollRef.current!.scrollTop });
      case 'zoom': return zoomBy(e.altKey ? 0.5 : 2);
      case 'slip': selectClips([c.id]); return beginDrag({ kind: 'slip', id: c.id, startX: e.clientX, linked });
      case 'slide': selectClips([c.id]); return beginDrag({ kind: 'slide', id: c.id, startX: e.clientX, anchor: c.start, anchorEnd: clipEnd(c), linked });
      default: break;
    }
    if (edge) {
      const mode = st.tool === 'ripple' ? 'ripple' : st.tool === 'roll' ? 'roll' : st.tool === 'rate' ? 'rate' : (e.ctrlKey || e.metaKey) ? 'ripple' : 'normal';
      selectClips([c.id]);
      beginDrag({ kind: 'trim', id: c.id, edge, mode, startX: e.clientX, anchor: edge === 'in' ? c.start : clipEnd(c), linked });
      return;
    }
    // selection
    const additive = e.shiftKey || e.metaKey || (e.ctrlKey && false);
    const already = st.selection.includes(c.id);
    if (additive) {
      if (already) useStore.setState({ selection: st.selection.filter((id) => !ops.withLinked(committedSeq(st), [c.id]).includes(id)) });
      else selectClips([c.id], true);
      return;
    }
    if (!already) selectClips([c.id]);
    const ids = already ? st.selection : (linked && !e.altKey ? ops.withLinked(committedSeq(st), [c.id]) : [c.id]);
    beginMove(e, ids, c);
  };

  const beginMove = (e: React.MouseEvent, ids: Id[], c: Clip) => {
    const base = committedSeq();
    const clips = ids.map((id) => base.clips[id]).filter(Boolean);
    const anchor = Math.min(...clips.map((x) => x.start));
    const anchorEnd = Math.max(...clips.map(clipEnd));
    const lane = lanes.findIndex((l) => l.track.id === c.trackId);
    beginDrag({ kind: 'move', ids, startX: e.clientX, startY: e.clientY, lane, insert: false, linked: useStore.getState().linkedSelection && !e.altKey, anchor, anchorEnd });
  };

  const onLanesMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    useStore.setState({ focus: 'timeline' });
    const st = useStore.getState();
    if (st.tool === 'hand') return beginDrag({ kind: 'hand', startX: e.clientX, startY: e.clientY, sx: scrollRef.current!.scrollLeft, sy: scrollRef.current!.scrollTop });
    if (st.tool === 'zoom') return zoomBy(e.altKey ? 0.5 : 2);
    if (st.tool === 'razor') {
      if (e.shiftKey) { const { f } = snapFrame(frameAtClientX(e.clientX), new Set()); edit('Jilet', (s) => { ops.razor(s, f); }); }
      return;
    }
    if (st.tool === 'trackSelect') {
      const frame = frameAtClientX(e.clientX);
      const li = laneAtClientY(e.clientY);
      const ids = Object.values(committedSeq(st).clips).filter((x) => clipEnd(x) > frame && (!e.shiftKey || (li >= 0 && x.trackId === lanes[li].track.id))).map((x) => x.id);
      selectClips(ids);
      return;
    }
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left + el.scrollLeft;
    const y = e.clientY - r.top + el.scrollTop - 26 - capRef.current;
    beginDrag({ kind: 'marquee', x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey });
  };

  const onLaneDoubleClick = (e: React.MouseEvent) => {
    // double-click on a gap selects it for ripple delete
    const li = laneAtClientY(e.clientY);
    if (li < 0) return;
    const f = frameAtClientX(e.clientX);
    if (window.confirm('Bu boşluğu kapat?')) edit('Boşluğu kapat', (s) => ops.closeGapAt(s, lanes[li].track.id, f));
  };

  const zoomBy = (k: number) => useStore.setState((s) => ({ zoom: Math.max(0.02, Math.min(60, s.zoom * k)) }));

  const onWheel = (e: React.WheelEvent) => {
    if (e.altKey || e.ctrlKey) {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }
  };

  // ---------------------------------------------------------------- drag & drop from project / source

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(FX_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropLane(laneAtClientY(e.clientY)); return; }
    if (!e.dataTransfer.types.includes('application/x-kurgu-media') && !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropLane(laneAtClientY(e.clientY));
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropLane(null);
    const st = useStore.getState();
    const li = laneAtClientY(e.clientY);
    const { f } = snapFrame(frameAtClientX(e.clientX), new Set());
    const fxRaw = e.dataTransfer.getData(FX_MIME);
    if (fxRaw) {
      const fx = JSON.parse(fxRaw) as FxDrag;
      if (li < 0) return;
      const lane = lanes[li].track;
      const wantsAudio = fx.kind === 'afx' || fx.kind === 'atrans';
      if ((lane.kind === 'audio') !== wantsAudio) {
        toast(wantsAudio ? 'Ses efektleri ve ses geçişleri ses kanallarına (A1, A2…) bırakılır' : 'Video efektleri ve geçişleri video kanallarına (V1, V2…) bırakılır', 'error');
        return;
      }
      const base = committedSeq(st);
      const frame = frameAtClientX(e.clientX);
      if (fx.kind === 'transition' || fx.kind === 'atrans') {
        const target = transitionTarget(base, lane.id, frame, 14 / zoom, lane.kind);
        if (target) addTransition(target.clip.id, fx.id, undefined, target.side);
        else toast('Geçişi bir klibin başına, sonuna ya da iki klibin arasına bırakın', 'error');
      } else {
        const under = Object.values(base.clips).find((c) => c.trackId === lane.id && frame >= c.start && frame < clipEnd(c));
        if (under) { if (fx.kind === 'afx') addAudioEffect([under.id], fx.id); else addEffect([under.id], fx.id); selectClips([under.id]); }
      }
      return;
    }
    const raw = e.dataTransfer.getData('application/x-kurgu-media');
    let mediaIds: Id[] = [];
    let range: { in: number; out: number } | null = null;
    if (raw) {
      const p = JSON.parse(raw) as { ids: Id[]; in?: number; out?: number };
      mediaIds = p.ids;
      if (p.in !== undefined && p.out !== undefined) range = { in: p.in, out: p.out };
    } else if (e.dataTransfer.files.length) {
      const { importPaths } = await import('./store');
      const paths = [...e.dataTransfer.files].map((x) => (x as File & { path?: string }).path ?? '').filter(Boolean);
      mediaIds = (await importPaths(paths)).map((m) => m.id);
    }
    if (!mediaIds.length) return;
    const insert = e.ctrlKey || e.metaKey;
    edit(insert ? 'Ekle' : 'Üzerine yaz', (s, media) => {
      let at = f;
      const target = li >= 0 ? lanes[li].track : null;
      const vTracks = s.tracks.filter((t) => t.kind === 'video');
      const aTracks = s.tracks.filter((t) => t.kind === 'audio');
      // dropped on a video track → video there, audio on the matching audio track index; and vice versa
      let v = target?.kind === 'video' ? target.id : vTracks[0].id;
      let a = target?.kind === 'audio' ? target.id : aTracks[0].id;
      if (target?.kind === 'video') a = aTracks[Math.min(vTracks.findIndex((t) => t.id === v), aTracks.length - 1)].id;
      if (target?.kind === 'audio') v = vTracks[Math.min(aTracks.findIndex((t) => t.id === a), vTracks.length - 1)].id;
      for (const id of mediaIds) {
        const m = media[id];
        if (!m) continue;
        const srcIn = range?.in ?? m.markIn ?? 0;
        const srcOut = range?.out ?? m.markOut ?? (m.kind === 'image' ? 5 : m.duration);
        const fn = insert ? ops.insertEdit : ops.overwriteEdit;
        const created = fn(s, { media: m, srcIn, srcOut, video: !(target?.kind === 'audio' && e.shiftKey), audio: !(target?.kind === 'video' && e.shiftKey) }, at, v, a);
        at += s.clips[created[0]].duration;
      }
    });
    void st;
  };

  // ---------------------------------------------------------------- render

  const onScroll = () => {
    const el = scrollRef.current!;
    if (headersRef.current) headersRef.current.scrollTop = el.scrollTop;
    setScroll({ x: el.scrollLeft, y: el.scrollTop });
    useStore.setState({ scrollX: el.scrollLeft });
  };

  const clipsByTrack = useMemo(() => {
    const m = new Map<Id, Clip[]>();
    for (const c of Object.values(seq.clips)) {
      if (!m.has(c.trackId)) m.set(c.trackId, []);
      m.get(c.trackId)!.push(c);
    }
    return m;
  }, [seq.clips]);

  const visFrom = scroll.x / zoom - 50;
  const visTo = (scroll.x + viewW) / zoom + 50;

  return (
    <div className={`panel timeline-panel ${focused ? 'focused' : ''}`} onMouseDown={() => useStore.setState({ focus: 'timeline' })}>
      <div className="timeline">
        <TimelineToolbar seq={committed} />
        <div className="tl-main">
          <div className="tl-headers" ref={headersRef}>
            <div className="tl-header-ruler">
              <button className={`icon-btn ${snapOn ? 'on' : ''}`} title="Yapıştır (S)" onClick={() => useStore.setState((s) => ({ snap: !s.snap }))}>{I.snap}</button>
              <button className={`icon-btn ${linkedSel ? 'on' : ''}`} title="Bağlı seçim" onClick={() => useStore.setState((s) => ({ linkedSelection: !s.linkedSelection }))}>{I.link}</button>
              <button className="icon-btn" title="Marker ekle (M)" onClick={() => edit('Marker ekle', (s) => { ops.addMarker(s, s.playhead); })}>{I.marker}</button>
            </div>
            {capH > 0 && (
              <div className="track-header" style={{ height: capH, background: '#1d1a14' }}>
                <div className="tname" style={{ width: 'auto', padding: '2px 6px', background: seq.captions?.enabled ? 'var(--sel)' : 'var(--bg-3)', color: '#1a1406' }}
                  title="Altyazıyı göster/gizle" onClick={() => edit('Altyazıyı göster', (s) => { if (s.captions) s.captions.enabled = !s.captions.enabled; })}>Altyazı</div>
                <div style={{ flex: 1 }} />
                <button className="btn small ghost" onClick={() => useStore.setState({ leftTab: 'captions' })}>Düzenle</button>
              </div>
            )}
            <div style={{ position: 'relative', height: height + 200 }}>
              {lanes.map((l) => <TrackHeader key={l.track.id} track={l.track} y={l.y} />)}
              <div className="track-sep" style={{ position: 'absolute', top: sepY, left: 0, right: 0 }} />
            </div>
          </div>
          <div className="tl-scroll" ref={scrollRef} onScroll={onScroll} onWheel={onWheel} onDragOver={onDragOver} onDragLeave={() => setDropLane(null)} onDrop={onDrop}>
            <div style={{ width: contentW, position: 'relative' }}>
              <Ruler seq={committed} zoom={zoom} width={viewW} scrollX={scroll.x} onScrub={(e) => {
                const { f } = snapFrame(frameAtClientX(e.clientX), new Set());
                player.pause();
                setPlayhead(f);
                beginDrag({ kind: 'scrub' });
              }} />
              {capH > 0 && <CaptionLane seq={seq} zoom={zoom} height={capH} from={visFrom} to={visTo} />}
              <div className="lanes" style={{ height: height + 200 }} onMouseDown={onLanesMouseDown} onDoubleClick={onLaneDoubleClick} data-tool={tool}
                onContextMenu={(e) => { const li = laneAtClientY(e.clientY); if (li >= 0) laneMenu(e, lanes[li].track, frameAtClientX(e.clientX)); else e.preventDefault(); }}>
                {lanes.map((l, i) => (
                  <div key={l.track.id} className={`lane kind-${l.track.kind} ${l.track.locked ? 'locked' : ''} ${dropLane === i ? 'drop' : ''}`} style={{ position: 'absolute', top: l.y, height: l.h, left: 0, right: 0 }}>
                    {(clipsByTrack.get(l.track.id) ?? []).filter((c) => clipEnd(c) >= visFrom && c.start <= visTo).map((c) => (
                      <ClipView key={c.id} clip={c} zoom={zoom} height={l.h} selected={selection.includes(c.id)} tool={tool} onMouseDown={onClipMouseDown} fps={seq.fps} media={project.media[c.mediaId]} />
                    ))}
                    {transitionWindows((clipsByTrack.get(l.track.id) ?? []).filter((c) => c.stream === l.track.kind && c.enabled).sort((a, b) => a.start - b.start)).windows.map((w) => {
                      const key = `${w.owner.id}:${w.side}`;
                      const name = TRANSITION_BY_ID[w.type]?.name ?? AUDIO_TRANSITIONS.find((t) => t.id === w.type)?.name ?? w.type;
                      return (
                        <div key={`tr-${key}`} className={`trans-block ${w.side === 'out' && !w.B ? 'tail' : ''} ${!w.A ? 'head' : ''} ${selTransition === key ? 'sel' : ''}`}
                          style={{ left: w.a * zoom, width: Math.max(6, (w.b - w.a) * zoom) }}
                          title={`${name} · ${framesToTimecode(w.b - w.a, seq.fps)}${!w.B ? ' · kapanış' : !w.A ? ' · açılış' : ''}\nÇift tık: süre · Delete: kaldır`}
                          onMouseDown={(e) => { e.stopPropagation(); if (e.button !== 0) return; useStore.setState({ selection: [w.owner.id], selTransition: key, leftTab: 'fx', focus: 'timeline' }); }}
                          onContextMenu={(e) => transitionMenu(e, w.owner, w.side, w.b - w.a)}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            const v = window.prompt('Geçiş süresi (saniye)', ((w.b - w.a) / seq.fps).toFixed(2));
                            const n = v ? Number(v.replace(',', '.')) : NaN;
                            if (Number.isFinite(n) && n > 0) edit('Geçiş süresi', (s) => { const c = s.clips[w.owner.id]; const t = w.side === 'in' ? c?.transIn : c?.transOut; if (t) t.duration = Math.max(2, Math.round(n * s.fps)); });
                          }}>{(w.b - w.a) * zoom > 40 ? name : ''}</div>
                      );
                    })}
                  </div>
                ))}
                <div className="track-sep" style={{ position: 'absolute', top: sepY, left: 0, right: 0 }} />
                {marquee && <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
              </div>
              <div className="playhead" style={{ left: committed.playhead * zoom, height: height + 226 + capH }} />
              {snapAt !== null && <div className="snapline" style={{ left: snapAt * zoom, height: height + 226 + capH }} />}
            </div>
          </div>
        </div>
      </div>
      {tip && <div className="drag-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}

function CaptionLane({ seq, zoom, height, from, to }: { seq: Sequence; zoom: number; height: number; from: number; to: number }) {
  const items = seq.captions?.items ?? [];
  const on = seq.captions?.enabled;
  return (
    <div style={{ position: 'relative', height, background: '#15130f', borderBottom: '1px solid var(--line)', opacity: on ? 1 : 0.45 }}>
      {items.filter((c) => c.end >= from && c.start <= to).map((c) => (
        <div key={c.id} title={c.text} onMouseDown={(e) => { e.stopPropagation(); setPlayhead(c.start); useStore.setState({ leftTab: 'captions' }); }}
          style={{ position: 'absolute', left: c.start * zoom, width: Math.max(2, (c.end - c.start) * zoom - 1), top: 3, bottom: 3, background: '#c9a227', color: '#1a1406', borderRadius: 3, fontSize: 10, fontWeight: 700, padding: '2px 4px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', cursor: 'pointer' }}>
          {c.text}
        </div>
      ))}
    </div>
  );
}

function prevAdjacent(s: Sequence, id: Id): Id | null {
  const c = s.clips[id];
  const p = Object.values(s.clips).find((x) => x.trackId === c.trackId && clipEnd(x) === c.start);
  return p?.id ?? null;
}

// -------------------------------------------------------------------- toolbar

function TimelineToolbar({ seq }: { seq: Sequence }) {
  const [tc, setTc] = useState<string | null>(null);
  const zoom = useStore((s) => s.zoom);
  const seqMap = useStore((s) => s.project.sequences);
  const seqs = Object.values(seqMap);
  return (
    <div className="tl-toolbar">
      <input className="tc" value={tc ?? framesToTimecode(seq.playhead, seq.fps)} onFocus={(e) => { setTc(framesToTimecode(seq.playhead, seq.fps)); e.target.select(); }}
        onChange={(e) => setTc(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            const f = tc?.startsWith('+') || tc?.startsWith('-')
              ? seq.playhead + (timecodeToFrames(tc.slice(1), seq.fps) ?? 0) * (tc.startsWith('-') ? -1 : 1)
              : timecodeToFrames(tc ?? '', seq.fps);
            if (f !== null) setPlayhead(f);
            setTc(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') { setTc(null); (e.target as HTMLInputElement).blur(); }
        }}
        onBlur={() => setTc(null)} title="Zaman kodu yazın (+10 / -1:00 göreli)" />
      <select className="mini" value={seq.id} onChange={(e) => useStore.setState((s) => ({ project: { ...s.project, activeSequenceId: e.target.value }, selection: [] }))}>
        {seqs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <span className="pill">{seq.width}×{seq.height} · {Math.round(seq.fps * 100) / 100} fps</span>
      <div style={{ flex: 1 }} />
      <button className="icon-btn" title="Video izi ekle" onClick={() => edit('Video izi ekle', (s) => { ops.addTrack(s, 'video'); })}>{I.film}</button>
      <button className="icon-btn" title="Ses izi ekle" onClick={() => edit('Ses izi ekle', (s) => { ops.addTrack(s, 'audio'); })}>{I.wave}</button>
      <span style={{ color: 'var(--text-3)' }}>Yakınlaştır</span>
      <input type="range" min={-4} max={4} step={0.01} value={Math.log2(zoom)} onChange={(e) => useStore.setState({ zoom: Math.pow(2, Number(e.target.value)) })} style={{ width: 120 }} />
      <button className="btn small ghost" title="Sekansı sığdır (\\)" onClick={() => fitZoom()}>Sığdır</button>
    </div>
  );
}

export function fitZoom() {
  const seq = committedSeq();
  const el = document.querySelector('.tl-scroll') as HTMLElement | null;
  const w = (el?.clientWidth ?? 1000) - 40;
  const total = Math.max(sequenceDuration(seq), seq.fps * 10);
  useStore.setState({ zoom: Math.max(0.02, w / total) });
  if (el) el.scrollLeft = 0;
}

// -------------------------------------------------------------------- ruler

function Ruler({ seq, zoom, width, scrollX, onScrub }: { seq: Sequence; zoom: number; width: number; scrollX: number; onScrub: (e: React.MouseEvent) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr; c.height = 26 * dpr;
    c.style.width = `${width}px`; c.style.left = `${scrollX}px`;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, 26);
    const fps = seq.fps;
    // choose a tick spacing that leaves ~80px between labels
    const steps = [1, 2, 5, 10, Math.round(fps / 2), Math.round(fps), Math.round(fps) * 2, Math.round(fps) * 5, Math.round(fps) * 10, Math.round(fps) * 30, Math.round(fps) * 60, Math.round(fps) * 300, Math.round(fps) * 600];
    const major = steps.find((s) => s * zoom >= 80) ?? steps[steps.length - 1];
    const minor = steps.slice().reverse().find((s) => s < major && major % s === 0 && s * zoom >= 8) ?? major;
    const f0 = Math.floor(scrollX / zoom / minor) * minor;
    const f1 = (scrollX + width) / zoom;
    ctx.strokeStyle = '#4a4a55';
    ctx.fillStyle = '#9a9aa6';
    ctx.font = '10px ui-monospace, monospace';
    for (let f = f0; f <= f1; f += minor) {
      const x = Math.round(f * zoom - scrollX) + 0.5;
      const isMajor = f % major === 0;
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 12 : 19);
      ctx.lineTo(x, 26);
      ctx.stroke();
      if (isMajor) ctx.fillText(framesToTimecode(f, fps), x + 3, 10);
    }
  }, [seq.fps, zoom, width, scrollX]);
  const markerColors: Record<string, string> = { green: '#3ccf91', red: '#ff5470', purple: '#a77bff', orange: '#ff9f43', yellow: '#ffd166', white: '#eee', blue: '#4b8cff', cyan: '#3ad1e6' };
  return (
    <div className="tl-ruler" onMouseDown={(e) => { if (e.button === 0) onScrub(e); }}>
      <canvas ref={ref} />
      {seq.inPoint !== null && seq.outPoint !== null && (
        <div className="inout" style={{ left: seq.inPoint * zoom, width: (seq.outPoint - seq.inPoint) * zoom }} />
      )}
      {seq.markers.map((m) => (
        <div key={m.id} className="marker" title={m.name || 'Marker'} style={{ left: m.frame * zoom, background: markerColors[m.color] }}
          onMouseDown={(e) => { e.stopPropagation(); setPlayhead(m.frame); }}
          onDoubleClick={() => {
            const name = window.prompt('Marker adı', m.name);
            if (name !== null) edit('Marker düzenle', (s) => { const mk = s.markers.find((x) => x.id === m.id); if (mk) mk.name = name; });
          }} />
      ))}
    </div>
  );
}

// -------------------------------------------------------------------- track header

function TrackHeader({ track, y }: { track: Track; y: number }) {
  const toggle = (label: string, fn: (t: Track) => void) => edit(label, (s) => { fn(s.tracks.find((x) => x.id === track.id)!); });
  const isV = track.kind === 'video';
  return (
    <div className={`track-header kind-${track.kind}`} style={{ position: 'absolute', top: y, height: track.height, left: 0, right: 0 }} onContextMenu={(e) => trackMenu(e, track)}>
      <div className={`tname ${track.targeted ? 'target' : ''}`} title="Hedef iz (kaynak düzenlemeleri buraya gelir)" onClick={() => edit('Hedef iz', (s) => ops.targetTrack(s, track.id))}>{track.name}</div>
      <button className={`icon-btn ${track.locked ? 'on' : ''}`} title="İzi kilitle" onClick={() => toggle('İz kilidi', (t) => { t.locked = !t.locked; })}>{track.locked ? I.lock : I.unlock}</button>
      <button className={`icon-btn ${track.syncLock ? 'on' : ''}`} title="Senkron kilidi" onClick={() => toggle('Senkron kilidi', (t) => { t.syncLock = !t.syncLock; })}>{I.sync}</button>
      {isV ? (
        <button className={`icon-btn ${track.muted ? '' : 'on'}`} title="İz çıkışını aç/kapat" onClick={() => toggle('İz görünürlüğü', (t) => { t.muted = !t.muted; })}>{track.muted ? I.eyeOff : I.eye}</button>
      ) : (
        <>
          <button className={`icon-btn ${track.muted ? 'on' : ''}`} title="Sessiz (M)" onClick={() => toggle('Sessiz', (t) => { t.muted = !t.muted; })}>{track.muted ? I.mute : I.speaker}</button>
          <button className={`icon-btn ${track.solo ? 'on' : ''}`} title="Solo" onClick={() => toggle('Solo', (t) => { t.solo = !t.solo; })}>{I.solo}</button>
        </>
      )}
      <div style={{ flex: 1 }} />
      <TrackMenu track={track} />
    </div>
  );
}

function TrackMenu({ track }: { track: Track }) {
  return (
    <select className="mini" style={{ width: 22, padding: 0, border: 0, background: 'transparent', color: 'var(--text-3)' }} value="" title="İz seçenekleri"
      onChange={(e) => {
        const v = e.target.value;
        if (v === 'up') edit('İzi yukarı taşı', (s) => ops.moveTrack(s, track.id, track.kind === 'video' ? 1 : -1));
        if (v === 'down') edit('İzi aşağı taşı', (s) => ops.moveTrack(s, track.id, track.kind === 'video' ? -1 : 1));
        if (v === 'delete') edit('İzi sil', (s) => ops.deleteTrack(s, track.id));
        if (v === 'rename') { const n = window.prompt('İz adı', track.name); if (n) edit('İzi yeniden adlandır', (s) => { s.tracks.find((t) => t.id === track.id)!.name = n; }); }
        if (v === 'taller') edit('İz yüksekliği', (s) => { const t = s.tracks.find((x) => x.id === track.id)!; t.height = Math.min(200, t.height + 24); });
        if (v === 'shorter') edit('İz yüksekliği', (s) => { const t = s.tracks.find((x) => x.id === track.id)!; t.height = Math.max(28, t.height - 24); });
        e.target.value = '';
      }}>
      <option value="">⋯</option>
      <option value="up">Yukarı taşı</option>
      <option value="down">Aşağı taşı</option>
      <option value="taller">Yüksekliği artır</option>
      <option value="shorter">Yüksekliği azalt</option>
      <option value="rename">Yeniden adlandır</option>
      <option value="delete">İzi sil</option>
    </select>
  );
}

// -------------------------------------------------------------------- clip

const ClipView = memo(function ClipView({ clip, zoom, height, selected, tool, onMouseDown, fps, media }: {
  clip: Clip; zoom: number; height: number; selected: boolean; tool: string; fps: number;
  media: import('../core/model').MediaItem | undefined;
  onMouseDown: (e: React.MouseEvent, c: Clip, edge: ops.Edge | null) => void;
}) {
  const assets = useStore((s) => (media ? s.assets[media.path] : undefined));
  const left = clip.start * zoom;
  const width = Math.max(2, clip.duration * zoom);
  const kind = media?.kind === 'image' ? 'image' : clip.stream;
  const hasFx = clip.transform.scale.value !== 100 || clip.transform.opacity.value !== 100 || clip.transform.posX.value !== 0 || clip.transform.posY.value !== 0 || clip.transform.rotation.value !== 0
    || [clip.transform.scale, clip.transform.opacity, clip.transform.posX, clip.transform.posY, clip.transform.rotation].some((p) => p.keyframes.length)
    || !!clip.color;
  const cursor = tool === 'razor' ? 'crosshair' : tool === 'slip' || tool === 'slide' ? 'ew-resize' : tool === 'hand' ? 'grab' : tool === 'zoom' ? 'zoom-in' : 'default';
  const edgeCursor = tool === 'roll' ? 'col-resize' : tool === 'ripple' ? 'w-resize' : tool === 'rate' ? 'ew-resize' : 'ew-resize';
  const showEdges = ['select', 'ripple', 'roll', 'rate', 'trackSelect'].includes(tool) && width > 14;

  // filmstrip: lay the whole source out in time and offset to the clip's source in
  let stripStyle: React.CSSProperties | undefined;
  if (clip.stream === 'video' && assets?.filmstrip && media && Number.isFinite(media.duration) && height > 30) {
    const pxPerSec = (zoom * fps) / Math.abs(clip.speed || 1);
    stripStyle = {
      backgroundImage: `url("${window.kurgu.mediaUrl(assets.filmstrip)}")`,
      backgroundSize: `${media.duration * pxPerSec}px 100%`,
      backgroundPositionX: `${-clip.srcIn * pxPerSec}px`,
      backgroundRepeat: 'no-repeat',
    };
  }
  return (
    <div className={`clip ${kind} ${selected ? 'sel' : ''} ${clip.enabled ? '' : 'disabled'} ${media && !media.online ? 'offline' : ''}`}
      style={{ left, width, cursor }} onMouseDown={(e) => onMouseDown(e, clip, null)} onContextMenu={(e) => clipMenu(e, clip)}
      onDoubleClick={(e) => { if (clip.nest || clip.mc) { e.stopPropagation(); openNested(clip.id); } }}
      title={`${clip.name}\n${framesToTimecode(clip.start, fps)} → ${framesToTimecode(clipEnd(clip), fps)} (${framesToTimecode(clip.duration, fps)})${clip.speed !== 1 ? `\nHız %${Math.round(clip.speed * 100)}` : ''}`}>
      <div className="cname">{clip.name}{clip.speed !== 1 && <span className="speed">%{Math.round(clip.speed * 100)}</span>}{hasRemap(clip) && <span className="speed" title="Hız rampası">⤴ rampa</span>}</div>
      {hasFx && <div className="fx">fx</div>}
      {clip.stream === 'video' && (clip.effects ?? []).some((e) => e.type === 'warpstab' && e.enabled) && <StabBadge clip={clip} media={media} fps={fps} />}
      {stripStyle && <div className="strip" style={stripStyle} />}
      {clip.stream === 'audio' && assets?.peaks && <Wave clip={clip} zoom={zoom} height={height - 4} width={width} peaks={assets.peaks} pps={assets.peaksPerSecond ?? 50} fps={fps} />}
      {clip.stream === 'audio' && <div className="rubber" style={{ top: `${Math.max(14, Math.min(height - 6, (height - 4) * (0.35 - clip.volumeDb.value / 60)))}px` }} />}
      {showEdges && (
        <>
          <div className="edge in" style={{ cursor: edgeCursor }} onMouseDown={(e) => onMouseDown(e, clip, 'in')} />
          <div className="edge out" style={{ cursor: edgeCursor }} onMouseDown={(e) => onMouseDown(e, clip, 'out')} />
        </>
      )}
    </div>
  );
});

function Wave({ clip, zoom, height, width, peaks, pps, fps }: { clip: Clip; zoom: number; height: number; width: number; peaks: number[]; pps: number; fps: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.min(width, 4096);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = w; c.height = height;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = 'rgba(210, 255, 236, 0.75)';
    const mid = height / 2 + 6;
    const amp = (height - 14) / 2;
    const speed = Math.abs(clip.speed || 1);
    const gain = Math.pow(10, clip.volumeDb.value / 20);
    for (let x = 0; x < w; x++) {
      const frame = (x / zoom);
      const t = clip.speed >= 0 ? clip.srcIn + (frame / fps) * speed : clip.srcIn + ((clip.duration - frame) / fps) * speed;
      const i0 = Math.floor(t * pps);
      const i1 = Math.max(i0 + 1, Math.floor((t + speed / (zoom * fps)) * pps));
      let p = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) p = Math.max(p, peaks[i] ?? 0);
      const hh = Math.min(1, p * gain) * amp;
      ctx.fillRect(x, mid - hh, 1, hh * 2 || 1);
    }
  }, [clip.srcIn, clip.speed, clip.duration, clip.volumeDb.value, zoom, w, height, peaks, pps, fps]);
  return <canvas ref={ref} className="wave" style={{ width: w, height }} />;
}

export { toast };

function StabBadge({ clip, media, fps }: { clip: Clip; media: import('../core/model').MediaItem | undefined; fps: number }) {
  useStore((s) => s.stabTick);
  if (!media) return null;
  const done = stabilizedSource(clip, media, fps);
  const st = stabStatus.get(clip.id);
  if (done) return <div className="stab-badge ok" title="Warp Stabilizer hazır">⌖</div>;
  return (
    <div className={`stab-badge ${st?.state === 'error' ? 'err' : 'run'}`} title="Warp Stabilizer">
      {st?.state === 'error' ? 'Sabitleme hatası' : st?.state === 'running' ? `Analiz %${Math.round(st.progress * 100)}` : 'Sabitleme sırada'}
    </div>
  );
}
