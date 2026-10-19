import { useEffect, useRef } from 'react';
import { Clip, clipEnd, sequenceDuration, sourceTimeAt } from '../core/model';
import * as ops from '../core/ops';
import { Dialogs } from './Dialogs';
import { ContextMenuHost } from './ContextMenu';
import { flattenMulticam, switchAngle } from './multicam';
import { ExportMode } from './ExportMode';
import { I } from './icons';
import { ProgramMonitor, SourceMonitor, sourceEdit } from './Monitors';
import { ProjectPanel, Tools } from './Panels';
import { player } from './player';
import {
  Tool, activeSeq, committedSeq, edit, importPaths, newProject, openProject, redo, saveProject, selectClips,
  setPlayhead, setSeqField, toast, undo, useStore,
} from './store';
import { Timeline, fitZoom } from './Timeline';
import { applyDefaultAudioTransition, applyDefaultTransition, removeTransition } from './Effects';

const TOOL_KEYS: Record<string, Tool> = { v: 'select', a: 'trackSelect', b: 'ripple', n: 'roll', r: 'rate', c: 'razor', y: 'slip', u: 'slide', h: 'hand', z: 'zoom', t: 'type' };

export function App() {
  const mode = useStore((s) => s.mode);
  const project = useStore((s) => s.project);
  const dirty = useStore((s) => s.dirty);
  const jobs = useStore((s) => s.jobs);
  const toasts = useStore((s) => s.toasts);
  const sys = useStore((s) => s.sys);
  const useProxies = useStore((s) => s.useProxies);
  const wsRef = useRef<HTMLDivElement>(null);

  // boot: system info, recovery, job events, menu commands
  useEffect(() => {
    void window.kurgu.systemInfo().then((sys) => {
      useStore.setState({ sys, playbackRes: sys.lowSpec ? 0.5 : 1 });
      if (sys.lowSpec) toast('Bu bilgisayar için hafif mod açık: yarım çözünürlük önizleme + otomatik proxy. Export her zaman tam kalitede.', 'info');
    });
    void window.kurgu.recover().then((r) => {
      if (r && r.project && Object.keys(r.project.media).length) useStore.setState({ dialog: { kind: 'recovery', data: r } });
    });
    const offJob = window.kurgu.onJob((j) => {
      useStore.setState((s) => ({ jobs: { ...s.jobs, [j.jobId]: j } }));
      if (j.done) {
        if (j.error) toast(`${j.label}: ${j.error}`, 'error');
        else if (j.kind === 'export') toast('Dışa aktarma tamamlandı', 'success');
        if (j.kind !== 'export') setTimeout(() => useStore.setState((s) => { const n = { ...s.jobs }; delete n[j.jobId]; return { jobs: n }; }), 2500);
      }
    });
    const offMenu = window.kurgu.onMenu((c) => runCommand(c));
    const onCmd = (e: Event) => runCommand((e as CustomEvent<string>).detail);
    window.addEventListener('kurgu-command', onCmd);
    const beforeUnload = () => { if (!useStore.getState().dirty) void window.kurgu.clearRecovery(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { offJob(); offMenu(); window.removeEventListener('kurgu-command', onCmd); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);

  useEffect(() => {
    window.kurgu.setTitle(`${dirty ? '● ' : ''}${project.name} — BaseCut Pro`);
  }, [dirty, project.name]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA')) return;
      if (useStore.getState().dialog) return;
      // panels with their own Delete/Escape (e.g. the transcript) handle those keys themselves
      if (tgt?.closest?.('[data-keys="local"]') && ['Delete', 'Backspace', 'Escape'].includes(e.key)) return;
      const handled = handleKey(e);
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const activeJobs = Object.values(jobs).filter((j) => !j.done || j.kind === 'export');

  return (
    <div className="app">
      <div className="header">
        <div className="brand"><div className="brand-mark" />BaseCut<span className="brand-pro">PRO</span></div>
        <div className="modes">
          <button className={mode === 'edit' ? 'on' : ''} onClick={() => useStore.setState({ mode: 'edit' })}>Kurgu</button>
          <button className={mode === 'export' ? 'on' : ''} onClick={() => useStore.setState({ mode: 'export' })}>Dışa Aktar</button>
        </div>
        <div className="spacer" />
        <div className="project-name"><b>{project.name}</b>{dirty ? ' · kaydedilmedi' : ''}</div>
        <div className="spacer" />
        {sys?.lowSpec && <span className="pill warn" title="Zayıf donanım algılandı">Hafif mod</span>}
        <label className="check pill" title="Önizlemede hafif proxy dosyalarını kullan (export her zaman orijinalden)">
          <input type="checkbox" checked={useProxies} onChange={(e) => useStore.setState({ useProxies: e.target.checked })} /> Proxy
        </label>
        <button className="btn small" onClick={() => runCommand('import')}>{I.import} İçe aktar</button>
        <button className="btn small primary" onClick={() => useStore.setState({ mode: 'export' })}>{I.exportI} Dışa aktar</button>
      </div>

      {mode === 'edit' ? (
        <div className="workspace" ref={wsRef}>
          <div className="top-row">
            <ProjectPanel />
            <Splitter dir="v" target={wsRef} varName="--left-w" />
            <SourceMonitor />
            <div className="splitter" />
            <ProgramMonitor />
          </div>
          <Splitter dir="h" target={wsRef} varName="--top-h" />
          <div className="bottom-row">
            <Tools />
            <Timeline />
          </div>
        </div>
      ) : <ExportMode />}

      <div className="statusbar">
        <span>{Object.keys(project.media).length} medya · {Object.keys(activeSeq().clips).length} klip</span>
        <span className="grow" />
        <div className="jobs">
          {activeJobs.map((j) => (
            <div key={j.jobId} className="job" title={j.error ?? ''}>
              <span>{j.label}</span>
              <div className="bar"><div style={{ width: `${Math.round(j.progress * 100)}%`, background: j.error ? 'var(--err)' : undefined }} /></div>
              <span>{j.error ? 'hata' : j.done ? 'bitti' : `${Math.round(j.progress * 100)}%`}</span>
            </div>
          ))}
        </div>
        <span>{sys ? `${sys.cpus} çekirdek · ${sys.totalMemGb} GB` : ''}</span>
        <button className="btn small ghost" onClick={() => useStore.setState({ dialog: { kind: 'shortcuts' } })}>Kısayollar</button>
      </div>

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
      <Dialogs />
      <ContextMenuHost />
    </div>
  );
}

function Splitter({ dir, target, varName }: { dir: 'h' | 'v'; target: React.RefObject<HTMLDivElement | null>; varName: string }) {
  return (
    <div className={`splitter ${dir === 'h' ? 'h' : ''}`} onMouseDown={(e) => {
      e.preventDefault();
      const el = target.current!;
      const r = el.getBoundingClientRect();
      const mv = (ev: MouseEvent) => {
        const pct = dir === 'h' ? ((ev.clientY - r.top) / r.height) * 100 : ((ev.clientX - r.left) / r.width) * 100;
        el.style.setProperty(varName, `${Math.max(15, Math.min(80, pct))}%`);
      };
      const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    }} />
  );
}

// -------------------------------------------------------------------- commands

function selectedClips(): Clip[] {
  const st = useStore.getState();
  const seq = committedSeq(st);
  return st.selection.map((id) => seq.clips[id]).filter(Boolean);
}

export function runCommand(c: string) {
  const st = useStore.getState();
  const seq = committedSeq(st);
  switch (c) {
    case 'new-project':
      if (st.dirty && !window.confirm('Kaydedilmemiş değişiklikler var. Yine de yeni proje açılsın mı?')) return;
      newProject(); return;
    case 'new-sequence': useStore.setState({ dialog: { kind: 'sequence' } }); return;
    case 'open':
      if (st.dirty && !window.confirm('Kaydedilmemiş değişiklikler var. Yine de başka proje açılsın mı?')) return;
      void openProject(); return;
    case 'save': void saveProject(false).then(() => window.kurgu.clearRecovery()); return;
    case 'save-as': void saveProject(true); return;
    case 'import': void window.kurgu.openFiles().then((p) => importPaths(p)); return;
    case 'export': useStore.setState({ mode: 'export' }); return;
    case 'export-frame': void exportFrame(); return;
    case 'undo': undo(); return;
    case 'redo': redo(); return;
    case 'copy': copy(); return;
    case 'cut': copy(); edit('Kes', (s) => ops.deleteClips(s, st.selection)); return;
    case 'paste': paste(false); return;
    case 'paste-insert': paste(true); return;
    case 'select-all': useStore.setState({ selection: Object.keys(seq.clips) }); return;
    case 'deselect': useStore.setState({ selection: [] }); return;
    case 'shortcuts': useStore.setState({ dialog: { kind: 'shortcuts' } }); return;
    case 'about': useStore.setState({ dialog: { kind: 'about' } }); return;
    case 'speed': useStore.setState({ dialog: { kind: 'speed' } }); return;
    case 'toggle-link': {
      const sel = selectedClips();
      if (!sel.length) return;
      if (sel.some((x) => x.linkId) && sel.every((x) => x.linkId === sel[0].linkId)) edit('Bağlantıyı kaldır', (s) => ops.unlink(s, sel.map((x) => x.id)));
      else edit('Bağla', (s) => ops.link(s, sel.map((x) => x.id)));
      return;
    }
    case 'toggle-enable': {
      const sel = selectedClips();
      if (sel.length) edit('Etkinleştir', (s) => ops.setEnabled(s, sel.map((x) => x.id), !sel[0].enabled));
      return;
    }
    case 'add-edit': {
      const targeted = seq.tracks.filter((t) => t.targeted).map((t) => t.id);
      const sel = selectedClips();
      edit('Kesim ekle', (s) => {
        if (sel.length) ops.splitAt(s, s.playhead, [...new Set(sel.map((x) => x.trackId))]);
        else ops.razor(s, s.playhead, targeted.length ? targeted : undefined);
      });
      return;
    }
    case 'add-edit-all': edit('Tüm izlerde kes', (s) => { ops.razor(s, s.playhead); }); return;
    case 'auto-reframe': useStore.setState({ dialog: { kind: 'reframe' } }); return;
    case 'create-multicam': if (st.selectedMedia.length < 2) toast('Proje panelinde en az iki kamera dosyası seçin', 'error'); else useStore.setState({ dialog: { kind: 'multicam' } }); return;
    case 'flatten-multicam': flattenMulticam(); return;
    case 'multicam-view': useStore.setState((s) => ({ multicamView: !s.multicamView })); return;
    case 'close-gaps': edit('Boşlukları kapat', (s) => ops.closeAllGaps(s)); return;
    case 'default-transition': applyDefaultTransition(); return;
    case 'default-audio-transition': applyDefaultAudioTransition(); return;
    case 'frame-hold': case 'frame-hold-segment': case 'frame-hold-whole': {
      const at = seq.playhead;
      let ids = selectedClips().filter((x) => x.stream === 'video' && at >= x.start && at < clipEnd(x)).map((x) => x.id);
      if (!ids.length) ids = ops.clipsAt(seq, at).filter((x) => x.stream === 'video').slice(0, 1).map((x) => x.id);
      if (!ids.length) { toast('Oynatma kafasının altında video klibi yok', 'error'); return; }
      const mode = c === 'frame-hold' ? 'after' : c === 'frame-hold-segment' ? 'segment' : 'whole';
      let made: string[] = [];
      edit(mode === 'segment' ? 'Kare dondurma bölümü ekle' : 'Kare dondur', (s) => { made = ops.frameHold(s, ids, at, mode, Math.round(s.fps * 2)); });
      if (made.length) { selectClips(made); toast(mode === 'segment' ? '2 saniyelik donmuş kare eklendi' : 'Kare donduruldu', 'success'); }
      return;
    }
    case 'paste-attributes': if (!st.clipboard?.length) toast('Önce bir klip kopyalayın (Ctrl+C)', 'error'); else useStore.setState({ dialog: { kind: 'attributes', data: 'paste' } }); return;
    case 'remove-attributes': if (st.selection.length) useStore.setState({ dialog: { kind: 'attributes', data: 'remove' } }); return;
    case 'rename-clip': {
      const sel = selectedClips()[0];
      if (!sel) return;
      const name = window.prompt('Klip adı', sel.name);
      if (name && name.trim()) edit('Yeniden adlandır', (s) => { if (s.clips[sel.id]) s.clips[sel.id].name = name.trim(); });
      return;
    }
    case 'match-frame': {
      const cl = ops.clipsAt(seq, seq.playhead, seq.tracks.filter((t) => t.targeted).map((t) => t.id))[0] ?? ops.clipsAt(seq, seq.playhead)[0];
      if (!cl) return;
      const t = sourceTimeAt(cl, seq.playhead, seq.fps) ?? cl.srcIn;
      useStore.setState({ sourceMediaId: cl.mediaId, focus: 'source' });
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('kurgu-source', { detail: `seek:${t}` })), 50);
      return;
    }
    case 'reveal-in-project': {
      const cl = selectedClips()[0];
      if (cl) useStore.setState({ leftTab: 'project', selectedMedia: [cl.mediaId], focus: 'project' });
      return;
    }
    case 'reveal-in-folder': {
      const cl = selectedClips()[0];
      const m = cl ? st.project.media[cl.mediaId] : null;
      if (m) window.kurgu.revealInFolder(m.path);
      return;
    }
    case 'add-video-track': edit('Video izi ekle', (s) => { ops.addTrack(s, 'video'); }); return;
    case 'add-audio-track': edit('Ses izi ekle', (s) => { ops.addTrack(s, 'audio'); }); return;
  }
}

function copy() {
  const sel = selectedClips();
  if (!sel.length) return;
  useStore.setState({ clipboard: structuredClone(sel) });
  toast(`${sel.length} klip kopyalandı`);
}

function paste(insert: boolean) {
  const st = useStore.getState();
  const clips = st.clipboard;
  if (!clips?.length) return;
  const seq = committedSeq(st);
  const min = Math.min(...clips.map((c) => c.start));
  const span = Math.max(...clips.map(clipEnd)) - min;
  const at = seq.playhead;
  const ids: string[] = [];
  edit(insert ? 'Yapıştır ve ekle' : 'Yapıştır', (s) => {
    const tracks = clips.map((c) => c.trackId).filter((t) => s.tracks.some((x) => x.id === t));
    if (insert) { const rt = ops.rippleTracks(s, tracks); ops.splitAt(s, at, rt); ops.shiftFrom(s, rt, at, span); }
    const links = new Map<string, string>();
    for (const c of clips) {
      if (!s.tracks.some((t) => t.id === c.trackId)) continue;
      const nc = structuredClone(c);
      nc.id = `clip_${Math.random().toString(36).slice(2, 10)}`;
      nc.start = at + (c.start - min);
      if (c.linkId) { if (!links.has(c.linkId)) links.set(c.linkId, `link_${Math.random().toString(36).slice(2, 10)}`); nc.linkId = links.get(c.linkId)!; }
      if (!insert) ops.clearRange(s, nc.trackId, nc.start, nc.start + nc.duration);
      s.clips[nc.id] = nc;
      ids.push(nc.id);
    }
    s.playhead = at + span;
  });
  useStore.setState({ selection: ids });
}

async function exportFrame() {
  const st = useStore.getState();
  const seq = committedSeq(st);
  const out = await window.kurgu.chooseExportPath(`${seq.name}-kare-${seq.playhead}`, 'png');
  if (!out) return;
  const canvas = player.canvas;
  if (!canvas) return;
  // re-render at full resolution for the still
  const prev = st.playbackRes;
  useStore.setState({ playbackRes: 1 });
  player.invalidate();
  await new Promise((r) => setTimeout(r, 250));
  const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  useStore.setState({ playbackRes: prev });
  if (!blob) return;
  const buf = new Uint8Array(await blob.arrayBuffer());
  await window.kurgu.writeBinary(out, buf);
  toast('Kare kaydedildi', 'success');
}

// -------------------------------------------------------------------- keys

function step(n: number) {
  player.pause();
  const seq = committedSeq();
  setPlayhead(Math.max(0, seq.playhead + n));
}

function handleKey(e: KeyboardEvent): boolean {
  const st = useStore.getState();
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  const seq = committedSeq(st);
  const sourceFocused = st.focus === 'source' && st.sourceMediaId;
  const src = (cmd: string) => { window.dispatchEvent(new CustomEvent('kurgu-source', { detail: cmd })); return true; };

  // Ctrl/Cmd shortcuts (menu shows them; we handle them here)
  if (ctrl) {
    const shift = e.shiftKey, alt = e.altKey;
    const map: [boolean, string][] = [
      [k === 'z' && !shift, 'undo'], [(k === 'z' && shift) || k === 'y', 'redo'],
      [k === 's' && !shift, 'save'], [k === 's' && shift, 'save-as'], [k === 'o', 'open'],
      [k === 'n' && alt, 'new-project'], [k === 'n' && !alt, 'new-sequence'],
      [k === 'i', 'import'], [k === 'm', 'export'], [k === 'e' && shift, 'export-frame'],
      [k === 'c', 'copy'], [k === 'x' && !shift, 'cut'], [k === 'v' && !shift && !alt, 'paste'], [k === 'v' && shift, 'paste-insert'], [k === 'v' && alt && !shift, 'paste-attributes'],
      [k === 'a' && !shift, 'select-all'], [k === 'a' && shift, 'deselect'],
      [k === 'k' && !shift, 'add-edit'], [k === 'k' && shift, 'add-edit-all'],
      [k === 'r', 'speed'], [k === 'l', 'toggle-link'], [k === 'k' && alt, 'shortcuts'], [k === 'd' && !shift, 'default-transition'], [k === 'd' && shift, 'default-audio-transition'],
    ];
    const hit = map.find(([m]) => m);
    if (hit) { runCommand(hit[1]); return true; }
  }
  if (st.mode === 'export' && k !== ' ') return false;

  // transport
  if (k === ' ') { if (sourceFocused) return src('toggle'); player.toggle(); return true; }
  if (!ctrl && k === 'j') { if (sourceFocused) return src('shuttle-left'); player.shuttle(-1); return true; }
  if (!ctrl && k === 'k') { if (sourceFocused) return src('shuttle-stop'); player.shuttle(0); return true; }
  if (!ctrl && k === 'l') { if (sourceFocused) return src('shuttle-right'); player.shuttle(1); return true; }
  if (k === 'arrowleft' && e.altKey) { const sel = st.selection; if (sel.length) edit('İt', (s) => ops.nudge(s, sel, e.shiftKey ? -5 : -1)); return true; }
  if (k === 'arrowright' && e.altKey) { const sel = st.selection; if (sel.length) edit('İt', (s) => ops.nudge(s, sel, e.shiftKey ? 5 : 1)); return true; }
  if (k === 'arrowleft') { if (sourceFocused) return src(e.shiftKey ? 'step-back-5' : 'step-back'); step(e.shiftKey ? -5 : -1); return true; }
  if (k === 'arrowright') { if (sourceFocused) return src(e.shiftKey ? 'step-fwd-5' : 'step-fwd'); step(e.shiftKey ? 5 : 1); return true; }
  if (k === 'arrowup' || k === 'arrowdown') {
    player.pause();
    const pts = ops.editPoints(seq, e.shiftKey ? undefined : seq.tracks.filter((t) => t.targeted).map((t) => t.id).concat(seq.tracks.filter((t) => t.targeted).length ? [] : seq.tracks.map((t) => t.id)));
    const f = seq.playhead;
    const next = k === 'arrowdown' ? pts.find((p) => p > f) : [...pts].reverse().find((p) => p < f);
    if (next !== undefined) setPlayhead(next);
    return true;
  }
  if (k === 'home') { if (sourceFocused) return src('home'); player.pause(); setPlayhead(0); return true; }
  if (k === 'end') { if (sourceFocused) return src('end'); player.pause(); setPlayhead(Math.max(0, sequenceDuration(seq) - 1)); return true; }

  // marks
  if (!ctrl && k === 'i') {
    if (e.shiftKey) { if (sourceFocused) return src('go-in'); if (seq.inPoint !== null) setPlayhead(seq.inPoint); return true; }
    if (sourceFocused) return src('mark-in');
    setSeqField('inPoint', seq.playhead); return true;
  }
  if (!ctrl && k === 'o') {
    if (e.shiftKey) { if (sourceFocused) return src('go-out'); if (seq.outPoint !== null) setPlayhead(seq.outPoint - 1); return true; }
    if (sourceFocused) return src('mark-out');
    setSeqField('outPoint', seq.playhead + 1); return true;
  }
  if (ctrl && e.shiftKey && k === 'x') { setSeqField('inPoint', null); setSeqField('outPoint', null); return true; }
  if (!ctrl && e.key === 'X') { // mark clip under playhead
    const c = ops.clipsAt(seq, seq.playhead)[0];
    if (c) { setSeqField('inPoint', c.start); setSeqField('outPoint', clipEnd(c)); }
    return true;
  }
  if (!ctrl && k === ',') { sourceEdit('insert'); return true; }
  if (!ctrl && k === '.') { sourceEdit('overwrite'); return true; }
  if (!ctrl && k === ';') { if (seq.inPoint !== null && seq.outPoint !== null) edit('Kaldır', (s) => ops.lift(s, seq.inPoint!, seq.outPoint!)); return true; }
  if (!ctrl && k === "'") { if (seq.inPoint !== null && seq.outPoint !== null) edit('Ayıkla', (s) => ops.extract(s, seq.inPoint!, seq.outPoint!)); return true; }

  // editing
  if (k === 'delete' || k === 'backspace') {
    if (st.selTransition) {
      removeTransition(st.selTransition);
      useStore.setState({ selTransition: null });
      return true;
    }
    if (!st.selection.length) return true;
    if (e.shiftKey || (e.altKey && k === 'backspace')) edit('Dalgalı sil', (s) => ops.rippleDelete(s, st.selection, st.linkedSelection));
    else edit('Sil', (s) => ops.deleteClips(s, st.selection, st.linkedSelection));
    return true;
  }
  if (!ctrl && !e.shiftKey && k === 'q') { edit('Öncekini kırp', (s, m) => ops.rippleTrimToPlayhead(s, m, 'previous')); return true; }
  if (!ctrl && !e.shiftKey && k === 'w') { edit('Sonrakini kırp', (s, m) => ops.rippleTrimToPlayhead(s, m, 'next')); return true; }
  if (!ctrl && k === 'm') {
    if (e.shiftKey) { const n = seq.markers.find((m) => m.frame > seq.playhead); if (n) setPlayhead(n.frame); return true; }
    edit('Marker ekle', (s) => { ops.addMarker(s, s.playhead); });
    return true;
  }
  if (!ctrl && k === 's' && !e.shiftKey) { useStore.setState((s) => ({ snap: !s.snap })); toast(`Yapıştırma ${useStore.getState().snap ? 'açık' : 'kapalı'}`); return true; }
  if (!ctrl && (k === '=' || k === '+')) { useStore.setState((s) => ({ zoom: Math.min(60, s.zoom * 1.5) })); return true; }
  if (!ctrl && k === '-') { useStore.setState((s) => ({ zoom: Math.max(0.02, s.zoom / 1.5) })); return true; }
  if (!ctrl && k === '\\') { fitZoom(); return true; }
  if (!ctrl && e.shiftKey && k === 'e') { runCommand('toggle-enable'); return true; }
  if (!ctrl && !e.shiftKey && k === 'f') { runCommand('match-frame'); return true; }
  if (!ctrl && e.shiftKey && k === 'arrowdown') return false;

  if (!ctrl && e.shiftKey && e.code === 'Digit0') { runCommand('multicam-view'); return true; }
  // multicam: 1–9 pick the camera angle at the playhead
  if (!ctrl && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key) && switchAngle(Number(e.key) - 1)) return true;

  // tools
  if (!ctrl && !e.altKey && !e.shiftKey && TOOL_KEYS[k]) { useStore.setState({ tool: TOOL_KEYS[k] }); return true; }
  if (!ctrl && e.shiftKey && k === 'a') { useStore.setState({ tool: 'trackSelect' }); return true; }

  // select clip under playhead on targeted tracks (D)
  if (!ctrl && k === 'd') {
    const c = ops.clipsAt(seq, seq.playhead, seq.tracks.filter((t) => t.targeted).map((t) => t.id))[0] ?? ops.clipsAt(seq, seq.playhead)[0];
    if (c) selectClips([c.id]);
    return true;
  }
  if (k === 'escape') { useStore.setState({ selection: [], selTransition: null }); return true; }
  return false;
}
