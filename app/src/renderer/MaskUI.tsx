// Mask controls (Effect Controls › Opacity) and on-monitor mask editing.
import { useEffect, useRef, useState } from 'react';
import { MASK_MODES, Mask, MaskMode, MaskShape, maskOutline, newMask } from '../core/mask';
import { Clip, MediaItem, Sequence, evalParam, newId } from '../core/model';
import { HotNumber } from './Panels';
import { activeSeq, commitPreview, edit, previewEdit, useStore } from './store';

// ------------------------------------------------------------------ effect controls

export function MaskControls({ clip }: { clip: Clip }) {
  const sel = useStore((s) => s.selMask);
  const masks = clip.masks ?? [];
  const add = (shape: MaskShape) => {
    const id = newId('mask');
    edit('Maske ekle', (s) => { const c = s.clips[clip.id]; (c.masks ?? (c.masks = [])).push(newMask(shape, id, (c.masks?.length ?? 0) + 1)); });
    useStore.setState({ selMask: id });
  };
  const set = (id: string, label: string, fn: (m: Mask) => void) => edit(label, (s) => { const m = s.clips[clip.id].masks?.find((x) => x.id === id); if (m) fn(m); });
  return (
    <div className="mask-box">
      <div className="mask-add">
        <span>Maske:</span>
        <button className="btn small" title="Elips maske" onClick={() => add('ellipse')}>◯ Elips</button>
        <button className="btn small" title="Dikdörtgen maske" onClick={() => add('rect')}>▭ Dikdörtgen</button>
        <button className="btn small" title="Serbest çokgen (noktaları monitörde sürükleyin, kenara çift tıklayıp nokta ekleyin, Alt+tık ile silin)" onClick={() => add('poly')}>✎ Serbest</button>
      </div>
      {masks.map((m) => (
        <div key={m.id} className={`mask-item ${sel === m.id ? 'sel' : ''}`}>
          <div className="mask-h" onClick={() => useStore.setState({ selMask: sel === m.id ? null : m.id })}>
            <span className="mask-ic">{m.shape === 'ellipse' ? '◯' : m.shape === 'rect' ? '▭' : '✎'}</span>
            <span style={{ flex: 1 }}>{m.name ?? 'Maske'}</span>
            <span className="mask-hint">{sel === m.id ? 'monitörde düzenleniyor' : 'düzenlemek için tıkla'}</span>
            <button className="icon-btn" title="Maskeyi sil" onClick={(e) => { e.stopPropagation(); edit('Maskeyi sil', (s) => { const c = s.clips[clip.id]; c.masks = (c.masks ?? []).filter((x) => x.id !== m.id); if (!c.masks.length) { delete c.masks; delete c.maskImage; } }); }}>✕</button>
          </div>
          <div className="fx-row"><span /><span className="lbl">Yumuşatma</span><HotNumber value={m.feather} step={1} unit="px" onCommit={(v) => set(m.id, 'Maske yumuşatma', (x) => { x.feather = Math.max(0, Math.round(v)); })} /><span /></div>
          <div className="fx-row"><span /><span className="lbl">Genişletme</span><HotNumber value={m.expansion} step={1} unit="px" onCommit={(v) => set(m.id, 'Maske genişletme', (x) => { x.expansion = Math.round(v); })} /><span /></div>
          <div className="fx-row"><span /><span className="lbl">Opaklık</span><HotNumber value={m.opacity} step={1} unit="%" onCommit={(v) => set(m.id, 'Maske opaklığı', (x) => { x.opacity = Math.max(0, Math.min(100, v)); })} /><span /></div>
          <div className="fx-row"><span /><span className="lbl">Mod</span>
            <select className="mini" value={m.mode} onChange={(e) => set(m.id, 'Maske modu', (x) => { x.mode = e.target.value as MaskMode; })}>{MASK_MODES.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select><span /></div>
          <div className="fx-row"><span /><span className="lbl">Ters çevir</span><label className="check"><input type="checkbox" checked={m.invert} onChange={(e) => set(m.id, 'Maskeyi ters çevir', (x) => { x.invert = e.target.checked; })} /></label><span /></div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ program monitor overlay

/** source-normalised point → sequence pixels for this clip at a local frame */
function mapper(c: Clip, m: MediaItem, seq: Sequence, local: number) {
  const iw = m.width || seq.width, ih = m.height || seq.height;
  const fit = Math.min(seq.width / iw, seq.height / ih);
  const sc = evalParam(c.transform.scale, local) / 100;
  const w = iw * fit * sc, h = ih * fit * sc;
  const cx = seq.width / 2 + evalParam(c.transform.posX, local), cy = seq.height / 2 + evalParam(c.transform.posY, local);
  const r = (evalParam(c.transform.rotation, local) * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return {
    fwd: (u: number, v: number): [number, number] => { const x = (u - 0.5) * w, y = (v - 0.5) * h; return [cx + x * cos - y * sin, cy + x * sin + y * cos]; },
    inv: (X: number, Y: number): [number, number] => { const x = X - cx, y = Y - cy; return [(x * cos + y * sin) / w + 0.5, (-x * sin + y * cos) / h + 0.5]; },
  };
}

export function MaskOverlay({ canvas }: { canvas: React.RefObject<HTMLCanvasElement | null> }) {
  const selMask = useStore((s) => s.selMask);
  const seq = useStore((s) => activeSeq(s));
  const selection = useStore((s) => s.selection);
  const media = useStore((s) => s.project.media);
  const [, force] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => { const r = () => force((x) => x + 1); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r); }, []);
  const clip = selection.map((id) => seq.clips[id]).find((c) => c && c.stream === 'video' && c.masks?.some((m) => m.id === selMask));
  const cv = canvas.current;
  if (!clip || !selMask || !cv) return null;
  const mask = clip.masks!.find((m) => m.id === selMask)!;
  const m = media[clip.mediaId];
  if (!m) return null;
  const local = Math.max(0, Math.min(clip.duration - 1, seq.playhead - clip.start));
  const map = mapper(clip, m, seq, local);
  const rect = cv.getBoundingClientRect();
  const parent = cv.parentElement!.getBoundingClientRect();
  const k = rect.width / seq.width;
  const ox = rect.left - parent.left, oy = rect.top - parent.top;
  const toView = ([u, v]: [number, number]): [number, number] => { const [X, Y] = map.fwd(u, v); return [ox + X * k, oy + Y * k]; };
  const fromClient = (cx: number, cy: number): [number, number] => map.inv((cx - rect.left) / k, (cy - rect.top) / k);

  const drag = (e: React.PointerEvent, apply: (u: number, v: number, du: number, dv: number, mm: Mask) => void) => {
    e.preventDefault(); e.stopPropagation();
    const [u0, v0] = fromClient(e.clientX, e.clientY);
    const mv = (ev: PointerEvent) => {
      const [u, v] = fromClient(ev.clientX, ev.clientY);
      previewEdit((s) => { const mm = s.clips[clip.id]?.masks?.find((x) => x.id === mask.id); if (mm) apply(u, v, u - u0, v - v0, mm); });
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); commitPreview('Maskeyi düzenle'); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const orig = mask.pts.map((p) => [...p]) as [number, number][];

  // outline in view space
  const iw = m.width || seq.width, ih = m.height || seq.height;
  const o = maskOutline(mask, 1, 1);
  let d = '';
  if (o.kind === 'ellipse') {
    const n = 48;
    for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; const [x, y] = toView([o.cx! + Math.cos(a) * o.rx!, o.cy! + Math.sin(a) * o.ry!]); d += `${i ? 'L' : 'M'}${x},${y}`; }
  } else { o.pts!.forEach((p, i) => { const [x, y] = toView(p); d += `${i ? 'L' : 'M'}${x},${y}`; }); d += 'Z'; }
  void iw; void ih;

  const handles: { at: [number, number]; on: (e: React.PointerEvent) => void; title: string; kind?: string }[] = [];
  if (mask.shape === 'poly') {
    mask.pts.forEach((p, i) => handles.push({
      at: p, title: 'Sürükle: taşı · Alt+tık: sil',
      on: (e) => {
        if (e.altKey && mask.pts.length > 3) { e.stopPropagation(); edit('Maske noktasını sil', (s) => { s.clips[clip.id].masks!.find((x) => x.id === mask.id)!.pts.splice(i, 1); }); return; }
        drag(e, (u, v, _du, _dv, mm) => { mm.pts[i] = [u, v]; });
      },
    }));
  } else {
    const [[cx, cy], [hx, hy]] = mask.pts;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      handles.push({ at: [cx + sx * Math.abs(hx), cy + sy * Math.abs(hy)], title: 'Sürükle: boyut', on: (e) => drag(e, (u, v, _du, _dv, mm) => { mm.pts[1] = [Math.max(0.005, Math.abs(u - cx)), Math.max(0.005, Math.abs(v - cy))]; }) });
    }
    for (const [sx, sy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      handles.push({ at: [cx + sx * Math.abs(hx), cy + sy * Math.abs(hy)], kind: 'edge', title: 'Sürükle: tek yönde boyut', on: (e) => drag(e, (u, v, _du, _dv, mm) => { const h = mm.pts[1]; mm.pts[1] = [sx ? Math.max(0.005, Math.abs(u - cx)) : h[0], sy ? Math.max(0.005, Math.abs(v - cy)) : h[1]]; }) });
    }
  }
  const moveAll = (e: React.PointerEvent) => drag(e, (_u, _v, du, dv, mm) => {
    if (mm.shape === 'poly') mm.pts = orig.map(([x, y]) => [x + du, y + dv]);
    else mm.pts[0] = [orig[0][0] + du, orig[0][1] + dv];
  });
  const addPoint = (e: React.MouseEvent) => {
    if (mask.shape !== 'poly') return;
    e.stopPropagation();
    const [u, v] = fromClient(e.clientX, e.clientY);
    // insert after the nearest edge
    let best = 0, bd = Infinity;
    for (let i = 0; i < mask.pts.length; i++) {
      const a = mask.pts[i], b = mask.pts[(i + 1) % mask.pts.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((u - a[0]) * dx + (v - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const dd = Math.hypot(a[0] + t * dx - u, a[1] + t * dy - v);
      if (dd < bd) { bd = dd; best = i; }
    }
    edit('Maske noktası ekle', (s) => { s.clips[clip.id].masks!.find((x) => x.id === mask.id)!.pts.splice(best + 1, 0, [u, v]); });
  };
  return (
    <svg ref={svgRef} className="mask-overlay" width={parent.width} height={parent.height}>
      <path d={d} className="mask-fill" onPointerDown={moveAll} onDoubleClick={addPoint} />
      <path d={d} className="mask-line" onDoubleClick={addPoint} />
      {handles.map((h, i) => { const [x, y] = toView(h.at); return <rect key={i} x={x - 5} y={y - 5} width={10} height={10} className={`mask-handle ${h.kind ?? ''}`} onPointerDown={h.on}><title>{h.title}</title></rect>; })}
    </svg>
  );
}
