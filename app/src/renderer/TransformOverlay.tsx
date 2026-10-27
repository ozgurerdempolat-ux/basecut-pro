// Direct manipulation in the Program Monitor (like Premiere's Motion handles):
// drag a selected clip to move it, corner handles to scale, the top knob to
// rotate. Graphic clips: drag a layer (text/shape) to move just that layer.
// Animated properties get a keyframe at the playhead instead of a new value.
import { useEffect, useState } from 'react';
import type { GraphicData } from '../core/graphic';
import { asGraphic } from '../core/graphic';
import { AnimatableParam, Clip, evalParam } from '../core/model';
import type { TitleData } from '../core/title';
import { mapper } from './MaskUI';
import { activeSeq, commitPreview, previewEdit, useStore } from './store';
import { LayerBox, drawGraphic, updateGraphic } from './titles';

function setAt(p: AnimatableParam, local: number, v: number) {
  if (!p.keyframes.length) { p.value = v; return; }
  const k = p.keyframes.find((x) => x.frame === local);
  if (k) k.value = v;
  else { p.keyframes.push({ frame: local, value: v, ease: 'linear' }); p.keyframes.sort((a, b) => a.frame - b.frame); }
}

let measureCanvas: HTMLCanvasElement | null = null;
function layerBoxes(g: GraphicData, W: number, H: number): LayerBox[] {
  measureCanvas ??= document.createElement('canvas');
  // measure at a small size, then scale: only geometry is needed
  const k = Math.min(1, 540 / H);
  measureCanvas.width = Math.max(2, Math.round(W * k)); measureCanvas.height = Math.max(2, Math.round(H * k));
  return drawGraphic(measureCanvas.getContext('2d')!, g, measureCanvas.width, measureCanvas.height).map((b) => ({ ...b, cx: b.cx / k, cy: b.cy / k, w: b.w / k, h: b.h / k }));
}

export function TransformOverlay({ canvas }: { canvas: React.RefObject<HTMLCanvasElement | null> }) {
  const seq = useStore((s) => activeSeq(s));
  const selection = useStore((s) => s.selection);
  const media = useStore((s) => s.project.media);
  const selMask = useStore((s) => s.selMask);
  const tool = useStore((s) => s.tool);
  const playing = useStore((s) => s.playing);
  const selLayer = useStore((s) => s.selLayer);
  const picking = useStore((s) => s.monitorPick);
  const [, force] = useState(0);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  useEffect(() => { const r = () => force((x) => x + 1); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r); }, []);
  const clip = selection.map((id) => seq.clips[id]).find((c): c is Clip => !!c && c.stream === 'video');
  const cv = canvas.current;
  if (!clip || !cv || selMask || playing || picking || tool !== 'select') return null;
  const m = media[clip.mediaId];
  if (!m || m.synthetic?.type === 'adjustment') return null;
  if (seq.playhead < clip.start || seq.playhead >= clip.start + clip.duration) return null;
  const local = seq.playhead - clip.start;
  const map = mapper(clip, m, seq, local);
  const rect = cv.getBoundingClientRect();
  const parent = cv.parentElement!.getBoundingClientRect();
  const k = rect.width / seq.width;
  const ox = rect.left - parent.left, oy = rect.top - parent.top;
  const view = (u: number, v: number): [number, number] => { const [X, Y] = map.fwd(u, v); return [ox + X * k, oy + Y * k]; };
  const corners = [view(0, 0), view(1, 0), view(1, 1), view(0, 1)];
  const centre = view(0.5, 0.5);
  const top = view(0.5, 0);
  const rot = (evalParam(clip.transform.rotation, local) * Math.PI) / 180;
  const knob: [number, number] = [top[0] + Math.sin(rot) * 26, top[1] - Math.cos(rot) * 26];

  const startDrag = (e: React.PointerEvent, kind: 'move' | 'scale' | 'rotate') => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY;
    const t = clip.transform;
    const px0 = evalParam(t.posX, local), py0 = evalParam(t.posY, local), sc0 = evalParam(t.scale, local), r0 = evalParam(t.rotation, local);
    const c0 = [rect.left + (centre[0] - ox), rect.top + (centre[1] - oy)];
    const d0 = Math.hypot(x0 - c0[0], y0 - c0[1]) || 1;
    const a0 = Math.atan2(y0 - c0[1], x0 - c0[0]);
    const mv = (ev: PointerEvent) => {
      previewEdit((s) => {
        const c = s.clips[clip.id];
        if (!c) return;
        if (kind === 'move') {
          let nx = px0 + (ev.clientX - x0) / k, ny = py0 + (ev.clientY - y0) / k;
          if (!ev.shiftKey) { if (Math.abs(nx) < 8 / k) nx = 0; if (Math.abs(ny) < 8 / k) ny = 0; } // snap to centre
          setAt(c.transform.posX, local, Math.round(nx)); setAt(c.transform.posY, local, Math.round(ny));
        } else if (kind === 'scale') {
          const d = Math.hypot(ev.clientX - c0[0], ev.clientY - c0[1]);
          setAt(c.transform.scale, local, Math.max(1, Math.round(sc0 * (d / d0) * 10) / 10));
        } else {
          let r = r0 + ((Math.atan2(ev.clientY - c0[1], ev.clientX - c0[0]) - a0) * 180) / Math.PI;
          if (ev.shiftKey) r = Math.round(r / 15) * 15;
          setAt(c.transform.rotation, local, Math.round(r * 10) / 10);
        }
      });
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); commitPreview(kind === 'move' ? 'Konum' : kind === 'scale' ? 'Ölçek' : 'Döndürme'); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  // graphic layers (in frame coordinates of the graphic image)
  const g = m.title ? asGraphic(m.title as TitleData | GraphicData) : null;
  const boxes = g ? layerBoxes(g, seq.width, seq.height) : [];
  const layerPath = (b: LayerBox, dx = 0, dy = 0) => {
    const r = (b.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const x = (sx * b.w) / 2, y = (sy * b.h) / 2;
      const fx = b.cx + dx + x * cos - y * sin, fy = b.cy + dy + x * sin + y * cos;
      return view(fx / seq.width, fy / seq.height); // graphic image = full frame
    });
    return `M${pts.map((p) => p.join(',')).join('L')}Z`;
  };
  const dragLayer = (e: React.PointerEvent, b: LayerBox) => {
    e.preventDefault(); e.stopPropagation();
    useStore.setState({ selLayer: b.id, leftTab: 'fx' });
    const x0 = e.clientX, y0 = e.clientY;
    const s = (evalParam(clip.transform.scale, local) / 100) * Math.min(seq.width / (m.width || seq.width), seq.height / (m.height || seq.height));
    let last = { dx: 0, dy: 0 };
    const mv = (ev: PointerEvent) => { last = { dx: (ev.clientX - x0) / k / s, dy: (ev.clientY - y0) / k / s }; setDrag({ id: b.id, ...last }); };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      setDrag(null);
      if (Math.abs(last.dx) + Math.abs(last.dy) < 1) return;
      void updateGraphic(m.id, (gg) => { const l = gg.layers.find((x) => x.id === b.id); if (l) { l.x = Math.round((l.x + (last.dx / seq.width) * 100) * 10) / 10; l.y = Math.round((l.y + (last.dy / seq.height) * 100) * 10) / 10; } }, 'Katmanı taşı');
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  const poly = corners.map((p) => p.join(',')).join(' ');
  return (
    <svg className="xf-overlay" width={parent.width} height={parent.height}>
      <polygon points={poly} className="xf-body" onPointerDown={(e) => startDrag(e, 'move')}><title>Sürükle: taşı (Shift: serbest)</title></polygon>
      {boxes.map((b) => (
        <path key={b.id} d={layerPath(b, drag?.id === b.id ? drag.dx : 0, drag?.id === b.id ? drag.dy : 0)} className={`xf-layer ${selLayer === b.id ? 'on' : ''}`} onPointerDown={(e) => dragLayer(e, b)}><title>Katmanı sürükle</title></path>
      ))}
      <line x1={top[0]} y1={top[1]} x2={knob[0]} y2={knob[1]} className="xf-stem" />
      <circle cx={knob[0]} cy={knob[1]} r={6} className="xf-rot" onPointerDown={(e) => startDrag(e, 'rotate')}><title>Döndür (Shift: 15°)</title></circle>
      {corners.map(([x, y], i) => <rect key={i} x={x - 5} y={y - 5} width={10} height={10} className="xf-handle" onPointerDown={(e) => startDrag(e, 'scale')}><title>Ölçekle</title></rect>)}
      <circle cx={centre[0]} cy={centre[1]} r={4} className="xf-centre" />
    </svg>
  );
}
