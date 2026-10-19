// Curve editors for the Color panel: RGB curves and hue curves, plus the HSL secondary.
import { useEffect, useRef, useState } from 'react';
import { ColorGrade, Secondary, curveFn, defaultSecondary, hueCurveFn } from '../core/color';

type Pts = [number, number][];
const IDENT: Pts = [[0, 0], [1, 1]];

export function CurvesEditor({ g, onLive, onCommit }: { g: ColorGrade; onLive: (fn: (x: ColorGrade) => void) => void; onCommit: (label: string) => void }) {
  const [ch, setCh] = useState<'master' | 'r' | 'g' | 'b'>('master');
  const [mode, setMode] = useState<'rgb' | 'hs' | 'hh' | 'hl'>('rgb');
  return (
    <div style={{ padding: '4px 10px 8px' }}>
      <div className="curve-tabs">
        {(['rgb', 'hs', 'hh', 'hl'] as const).map((m) => <button key={m} className={`btn small ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{{ rgb: 'RGB', hs: 'Ton / Doygunluk', hh: 'Ton / Ton', hl: 'Ton / Parlaklık' }[m]}</button>)}
      </div>
      {mode === 'rgb' ? (
        <>
          <div className="curve-tabs">
            {(['master', 'r', 'g', 'b'] as const).map((c) => <button key={c} className={`curve-ch ch-${c} ${ch === c ? 'on' : ''}`} onClick={() => setCh(c)} title={{ master: 'Parlaklık', r: 'Kırmızı', g: 'Yeşil', b: 'Mavi' }[c]} />)}
            <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => { onLive((x) => { if (x.curves) { delete x.curves[ch]; if (!Object.keys(x.curves).length) delete x.curves; } }); onCommit('Eğriyi sıfırla'); }}>Sıfırla</button>
          </div>
          <CurveBox pts={g.curves?.[ch] ?? IDENT} color={{ master: '#e8e8e8', r: '#ff5a5a', g: '#5ad66a', b: '#5aa0ff' }[ch]} hue={false}
            onLive={(p) => onLive((x) => { x.curves = { ...(x.curves ?? {}), [ch]: p }; })} onCommit={() => onCommit('Eğri')} />
        </>
      ) : (
        <>
          <div className="curve-tabs"><span style={{ color: 'var(--text-3)' }}>{{ hs: 'Bir rengin doygunluğunu artırın/azaltın', hh: 'Bir rengi başka tona kaydırın', hl: 'Bir rengi aydınlatın/karartın' }[mode]}</span>
            <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => { const k = { hs: 'hueVsSat', hh: 'hueVsHue', hl: 'hueVsLuma' }[mode] as 'hueVsSat'; onLive((x) => { delete x[k]; }); onCommit('Ton eğrisini sıfırla'); }}>Sıfırla</button></div>
          <CurveBox pts={(g[{ hs: 'hueVsSat', hh: 'hueVsHue', hl: 'hueVsLuma' }[mode] as 'hueVsSat'] ?? [])} color="#fff" hue
            onLive={(p) => { const k = { hs: 'hueVsSat', hh: 'hueVsHue', hl: 'hueVsLuma' }[mode] as 'hueVsSat'; onLive((x) => { x[k] = p; }); }} onCommit={() => onCommit('Ton eğrisi')} />
        </>
      )}
    </div>
  );
}

/** square editor. RGB: x,y 0..1. Hue: x = hue 0..1, y = amount -1..1 (centre line = no change) */
function CurveBox({ pts, color, hue, onLive, onCommit }: { pts: Pts; color: string; hue: boolean; onLive: (p: Pts) => void; onCommit: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const S = 220;
  const toY = (v: number) => (hue ? (1 - (v + 1) / 2) : 1 - v) * S;
  const fromY = (py: number) => (hue ? (1 - py / S) * 2 - 1 : 1 - py / S);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, S, S);
    if (hue) {
      const grad = g.createLinearGradient(0, 0, S, 0);
      for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60}, 80%, 50%)`);
      g.globalAlpha = 0.35; g.fillStyle = grad; g.fillRect(0, 0, S, S); g.globalAlpha = 1;
    } else { g.fillStyle = '#121418'; g.fillRect(0, 0, S, S); }
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo((i * S) / 4, 0); g.lineTo((i * S) / 4, S); g.moveTo(0, (i * S) / 4); g.lineTo(S, (i * S) / 4); g.stroke(); }
    if (hue) { g.strokeStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke(); }
    else { g.strokeStyle = 'rgba(255,255,255,0.15)'; g.beginPath(); g.moveTo(0, S); g.lineTo(S, 0); g.stroke(); }
    const f = hue ? hueCurveFn(pts) : curveFn(pts);
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
    for (let x = 0; x <= S; x++) { const v = f ? f(x / S) : hue ? 0 : x / S; const y = toY(v); if (x) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
    for (const [x, y] of pts) { g.fillStyle = '#111'; g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath(); g.arc(x * S, toY(y), 4.5, 0, Math.PI * 2); g.fill(); g.stroke(); }
  });
  const pick = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(hue ? -1 : 0, Math.min(1, fromY(((e.clientY - r.top) / r.height) * S)))] as [number, number];
  };
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    const [x, y] = pick(e);
    const list = pts.map((p) => [...p] as [number, number]);
    let i = list.findIndex(([px, py]) => Math.abs(px - x) * S < 8 && Math.abs(toY(py) - toY(y)) < 10);
    if (i < 0) { list.push([x, y]); list.sort((a, b) => a[0] - b[0]); i = list.findIndex((p) => p[0] === x && p[1] === y); onLive(list.map((p) => [...p] as [number, number])); } // never hand our working array to the store (it gets frozen)
    const isEnd = !hue && (i === 0 || i === list.length - 1);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect();
      let nx = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const ny = Math.max(hue ? -1 : 0, Math.min(1, fromY(((ev.clientY - r.top) / r.height) * S)));
      if (isEnd) nx = list[i][0]; // the end points only move up/down
      else { const lo = list[i - 1]?.[0] ?? -1, hi = list[i + 1]?.[0] ?? 2; nx = Math.max(lo + 0.01, Math.min(hi - 0.01, nx)); }
      list[i] = [nx, ny];
      onLive(list.map((p) => [...p] as [number, number]));
    };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); onCommit(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  };
  const dbl = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const i = pts.findIndex(([px]) => Math.abs(px - x) * S < 8);
    if (i < 0 || (!hue && (i === 0 || i === pts.length - 1))) return;
    onLive(pts.filter((_, k) => k !== i)); onCommit();
  };
  return <canvas ref={ref} width={S} height={S} className="curve-box" onPointerDown={down} onDoubleClick={dbl} title="Tıklayıp nokta ekleyin, sürükleyin · çift tık: noktayı sil" />;
}

// ------------------------------------------------------------------ HSL secondary

export function SecondaryEditor({ g, onLive, onCommit }: { g: ColorGrade; onLive: (fn: (x: ColorGrade) => void) => void; onCommit: (label: string) => void }) {
  const sec = g.secondary;
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (!picking) return;
    const h = (e: MouseEvent) => {
      const c = (e.target as HTMLElement).closest('.viewer')?.querySelector('canvas');
      if (!c) return;
      e.preventDefault(); e.stopPropagation();
      const r = c.getBoundingClientRect();
      const x = Math.round(((e.clientX - r.left) / r.width) * c.width), y = Math.round(((e.clientY - r.top) / r.height) * c.height);
      const d = c.getContext('2d')!.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
      let R = 0, G = 0, B = 0; for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
      const n = d.length / 4; R /= n * 255; G /= n * 255; B /= n * 255;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2, dd = mx - mn;
      let hue = 0; if (dd > 1e-4) hue = (mx === R ? (G - B) / dd + (G < B ? 6 : 0) : mx === G ? (B - R) / dd + 2 : (R - G) / dd + 4) * 60;
      const s = dd < 1e-4 ? 0 : l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
      onLive((x2) => { const base = x2.secondary ?? defaultSecondary(); x2.secondary = { ...base, hue: Math.round(hue), satMin: Math.max(0, Math.round(s * 100 - 35)), lumMin: Math.max(0, Math.round(l * 100 - 40)), lumMax: Math.min(100, Math.round(l * 100 + 40)) }; });
      onCommit('Renk seç (damlalık)');
      setPicking(false);
    };
    window.addEventListener('mousedown', h, true);
    return () => window.removeEventListener('mousedown', h, true);
  }, [picking, onLive, onCommit]);
  const set = (k: keyof Secondary, v: number) => onLive((x) => { x.secondary = { ...(x.secondary ?? defaultSecondary()), [k]: v }; });
  const row = (label: string, k: keyof Secondary, min: number, max: number, unit = '') => (
    <div className="sec-row"><span>{label}</span>
      <input type="range" min={min} max={max} step={1} value={(sec ?? defaultSecondary())[k]} onChange={(e) => set(k, Number(e.target.value))} onPointerUp={() => onCommit(label)} />
      <b>{(sec ?? defaultSecondary())[k]}{unit}</b></div>
  );
  return (
    <div style={{ padding: '4px 10px 8px' }}>
      <div className="curve-tabs">
        <button className={`btn small ${picking ? 'on' : ''}`} onClick={() => setPicking(!picking)} title="Program monitöründe düzeltmek istediğiniz renge tıklayın">{picking ? 'Monitörde bir renge tıklayın…' : '🎯 Damlalık'}</button>
        {sec && <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => { onLive((x) => { delete x.secondary; }); onCommit('İkincil düzeltmeyi kaldır'); }}>Kaldır</button>}
      </div>
      <div className="sec-hue" style={{ background: `linear-gradient(90deg, ${[0, 60, 120, 180, 240, 300, 360].map((h) => `hsl(${h},80%,50%)`).join(',')})` }}>
        {sec && <div className="sec-band" style={{ left: `${((sec.hue - sec.hueWidth + 360) % 360) / 3.6}%`, width: `${(sec.hueWidth * 2) / 3.6}%` }} />}
      </div>
      <div className="sec-label">Seçim</div>
      {row('Ton', 'hue', 0, 360, '°')}{row('Ton genişliği', 'hueWidth', 2, 90, '°')}
      {row('Doygunluk min', 'satMin', 0, 100)}{row('Doygunluk max', 'satMax', 0, 100)}
      {row('Parlaklık min', 'lumMin', 0, 100)}{row('Parlaklık max', 'lumMax', 0, 100)}
      {row('Yumuşaklık', 'soft', 0, 100)}
      <div className="sec-label">Düzeltme (yalnızca seçilen renge)</div>
      {row('Ton kaydır', 'hueShift', -180, 180, '°')}{row('Doygunluk', 'saturation', -100, 100)}{row('Parlaklık', 'brightness', -100, 100)}{row('Sıcaklık', 'temperature', -100, 100)}
    </div>
  );
}
