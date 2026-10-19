import { useEffect, useRef, useState } from 'react';
import { ColorGrade, LOOKS, RGB, autoGrade, isNeutral, neutralGrade } from '../core/color';
import { Clip } from '../core/model';
import { I } from './icons';
import { player } from './player';
import { CurvesEditor, SecondaryEditor } from './Curves';
import { activeSeq, cancelPreview, commitPreview, edit, previewEdit, toast, useStore } from './store';

let gradeClipboard: ColorGrade | null = null;

function gradeOf(c: Clip): ColorGrade { return c.color ?? neutralGrade(); }

/** live while dragging (preview), one undo step on release */
function liveSet(ids: string[], fn: (g: ColorGrade) => void) {
  previewEdit((s) => { for (const id of ids) { const c = s.clips[id]; if (!c) continue; const g = c.color ?? neutralGrade(); fn(g); c.color = g; } });
}

export function ColorPanel() {
  const seq = useStore((s) => activeSeq(s));
  const selection = useStore((s) => s.selection);
  const clips = selection.map((id) => seq.clips[id]).filter((c): c is Clip => !!c && c.stream === 'video');
  const clip = clips[0];
  if (!clip) {
    return <div className="empty"><div className="big">Renk düzenleme</div><div>Timeline'da bir video klibi seçin. Pozlama, beyaz dengesi, kontrast, renk tekerlekleri, hazır görünümler ve LUT; önizlemede gördüğünüz renk export'ta birebir aynı çıkar.</div></div>;
  }
  const ids = clips.map((c) => c.id);
  const g = gradeOf(clip);
  const commit = (label = 'Renk') => commitPreview(label);
  const slider = (label: string, key: keyof ColorGrade, min: number, max: number, step = 1, def = 0, unit = '') => (
    <GradeSlider key={key} label={label} value={g[key] as number} min={min} max={max} step={step} def={def} unit={unit}
      onLive={(v) => liveSet(ids, (x) => { (x[key] as number) = v; })} onCommit={() => commit(label)} />
  );
  return (
    <div className="panel-body" style={{ paddingBottom: 12 }}>
      <div style={{ display: 'flex', gap: 6, padding: '8px 10px', alignItems: 'center', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
        <b style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{clips.length > 1 ? `${clips.length} klip` : clip.name}</b>
        <button className="btn small" title="Bu karenin pozlamasını ve beyaz dengesini otomatik düzelt" onClick={() => {
          const el = player.sourceOf(clip.id);
          if (!el) { toast('Önce oynatma kafasını bu klibin üzerine getirin', 'error'); return; }
          const cv = document.createElement('canvas'); cv.width = 160; cv.height = 90;
          const cx = cv.getContext('2d')!; cx.drawImage(el, 0, 0, 160, 90);
          const auto = autoGrade(cx.getImageData(0, 0, 160, 90).data, g);
          edit('Otomatik renk', (s) => { for (const id of ids) { const c = s.clips[id]; c.color = { ...(c.color ?? neutralGrade()), exposure: auto.exposure, temperature: auto.temperature, tint: auto.tint, contrast: auto.contrast }; } });
        }}>Otomatik</button>
        <button className="btn small" title="Rengi kopyala" onClick={() => { gradeClipboard = structuredClone(g); toast('Renk kopyalandı'); }}>Kopyala</button>
        <button className="btn small" title="Seçili kliplere yapıştır" disabled={!gradeClipboard} onClick={() => gradeClipboard && edit('Renk yapıştır', (s) => { for (const id of ids) s.clips[id].color = structuredClone(gradeClipboard!); })}>Yapıştır</button>
        <button className="btn small" title="Sıfırla" disabled={isNeutral(g) && !g.vignette} onClick={() => edit('Rengi sıfırla', (s) => { for (const id of ids) delete s.clips[id].color; })}>{I.reset}</button>
      </div>
      <Section title="Temel düzeltme">
        {slider('Sıcaklık', 'temperature', -100, 100)}
        {slider('Ton', 'tint', -100, 100)}
        {slider('Pozlama', 'exposure', -4, 4, 0.01, 0, ' EV')}
        {slider('Kontrast', 'contrast', -100, 100)}
        {slider('Parlak alanlar', 'highlights', -100, 100)}
        {slider('Gölgeler', 'shadows', -100, 100)}
        {slider('Beyazlar', 'whites', -100, 100)}
        {slider('Siyahlar', 'blacks', -100, 100)}
        {slider('Doygunluk', 'saturation', 0, 200, 1, 100, '%')}
        {slider('Canlılık', 'vibrance', -100, 100)}
      </Section>
      <Section title="Yaratıcı">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4, padding: '4px 10px' }}>
          <button className={`preset ${!g.look ? 'on' : ''}`} style={{ padding: '5px 8px' }} onClick={() => edit('Görünüm', (s) => { for (const id of ids) { const c = s.clips[id]; c.color = { ...(c.color ?? neutralGrade()), look: null }; } })}>Yok</button>
          {Object.entries(LOOKS).map(([id, l]) => (
            <button key={id} className={`preset ${g.look === id ? 'on' : ''}`} style={{ padding: '5px 8px' }} onClick={() => edit('Görünüm', (s) => { for (const cid of ids) { const c = s.clips[cid]; c.color = { ...(c.color ?? neutralGrade()), look: id }; } })}>{l.name}</button>
          ))}
        </div>
        {g.look && slider('Görünüm yoğunluğu', 'lookIntensity', 0, 100, 1, 100, '%')}
        {slider('Soluk film', 'fade', 0, 100)}
        {slider('Vinyet', 'vignette', -100, 0)}
        <div style={{ display: 'flex', gap: 6, padding: '6px 10px', alignItems: 'center' }}>
          <button className="btn small" onClick={async () => {
            const r = await window.kurgu.openText(['cube']);
            if (!r) return;
            if (!/LUT_3D_SIZE/i.test(r.content)) { toast('Bu bir 3D .cube LUT dosyası değil', 'error'); return; }
            edit('LUT yükle', (s) => { for (const id of ids) { const c = s.clips[id]; c.color = { ...(c.color ?? neutralGrade()), lutPath: r.path }; } });
          }}>LUT yükle (.cube)</button>
          {g.lutPath && <><span style={{ flex: 1, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.lutPath.split(/[\\/]/).pop()}</span>
            <button className="icon-btn" title="LUT'u kaldır" onClick={() => edit('LUT kaldır', (s) => { for (const id of ids) { const c = s.clips[id]; if (c.color) c.color.lutPath = null; } })}>{I.close}</button></>}
        </div>
        {g.lutPath && slider('LUT yoğunluğu', 'lutIntensity', 0, 100, 1, 100, '%')}
      </Section>
      <Section title="Renk tekerlekleri">
        <div style={{ display: 'flex', justifyContent: 'space-around', padding: '6px 4px' }}>
          {(['lift', 'gamma', 'gain'] as const).map((k) => (
            <Wheel key={k} label={{ lift: 'Gölgeler', gamma: 'Orta tonlar', gain: 'Parlak' }[k]} value={g[k]}
              onLive={(v) => liveSet(ids, (x) => { x[k] = v; })} onCommit={() => commit('Renk tekerleği')} />
          ))}
        </div>
      </Section>
      <Section title="Eğriler">
        <CurvesEditor g={g} onLive={(fn) => liveSet(ids, fn)} onCommit={(l) => commit(l)} />
      </Section>
      <Section title="HSL ikincil (tek renge düzeltme)">
        <SecondaryEditor g={g} onLive={(fn) => liveSet(ids, fn)} onCommit={(l) => commit(l)} />
      </Section>
      <Section title="Scope'lar"><Scopes /></Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="fx-group">
      <div className="gh" onClick={() => setOpen(!open)}><span style={{ color: 'var(--text-3)' }}>{open ? '▾' : '▸'}</span>{title}</div>
      {open && children}
    </div>
  );
}

function GradeSlider({ label, value, min, max, step, def, unit, onLive, onCommit }: {
  label: string; value: number; min: number; max: number; step: number; def: number; unit: string; onLive: (v: number) => void; onCommit: () => void;
}) {
  const [v, setV] = useState<number | null>(null);
  const shown = v ?? value;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '96px 1fr 52px', gap: 6, alignItems: 'center', padding: '2px 10px' }}
      onDoubleClick={() => { onLive(def); onCommit(); }} title="Çift tık: sıfırla">
      <span style={{ color: shown !== def ? 'var(--text)' : 'var(--text-2)' }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={shown}
        onChange={(e) => { const n = Number(e.target.value); setV(n); onLive(n); }}
        onPointerUp={() => { setV(null); onCommit(); }}
        onKeyUp={() => { setV(null); onCommit(); }} />
      <span style={{ font: '11px var(--mono)', textAlign: 'right', color: '#6cc4ff' }}>{Math.round(shown * 100) / 100}{unit}</span>
    </div>
  );
}

/** colour wheel: drag the puck towards a hue to tint; vertical bar for brightness */
function Wheel({ label, value, onLive, onCommit }: { label: string; value: RGB; onLive: (v: RGB) => void; onCommit: () => void }) {
  const R = 46;
  // invert r/g/b offsets to a 2D position (projection onto the colour plane)
  const lum = (value.r + value.g + value.b) / 3;
  const cr = value.r - lum, cg = value.g - lum, cb = value.b - lum;
  const x = cr - 0.5 * cg - 0.5 * cb;
  const y = (Math.sqrt(3) / 2) * (cg - cb);
  const px = R + Math.max(-R, Math.min(R, (x / 0.6) * R));
  const py = R - Math.max(-R, Math.min(R, (y / 0.6) * R));
  const toRgb = (dx: number, dy: number, l: number): RGB => {
    // dx,dy in -1..1 → chroma offsets, plus luminance l
    const ang = Math.atan2(dy, dx);
    const rad = Math.min(1, Math.hypot(dx, dy)) * 0.4;
    return {
      r: l + rad * Math.cos(ang),
      g: l + rad * Math.cos(ang - (2 * Math.PI) / 3),
      b: l + rad * Math.cos(ang + (2 * Math.PI) / 3),
    };
  };
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const dx = ((ev.clientX - r.left) - R) / R;
      const dy = -((ev.clientY - r.top) - R) / R;
      onLive(toRgb(dx, dy, lum));
    };
    move(e.nativeEvent);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); onCommit(); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div onPointerDown={drag} onDoubleClick={() => { onLive({ r: 0, g: 0, b: 0 }); onCommit(); }} title="Sürükleyin · çift tık sıfırlar"
          style={{ width: R * 2, height: R * 2, borderRadius: '50%', position: 'relative', cursor: 'crosshair', touchAction: 'none',
            background: 'radial-gradient(circle, rgba(40,40,46,1) 0%, rgba(40,40,46,0) 70%), conic-gradient(from 90deg, #f44, #f4f, #44f, #4ff, #4f4, #ff4, #f44)' }}>
          <div style={{ position: 'absolute', left: px - 5, top: py - 5, width: 10, height: 10, borderRadius: '50%', border: '2px solid #fff', boxShadow: '0 0 3px #000' }} />
        </div>
        <input type="range" min={-0.5} max={0.5} step={0.005} value={lum} title="Parlaklık"
          style={{ writingMode: 'vertical-lr', direction: 'rtl', height: R * 2, width: 14 }}
          onChange={(e) => { const l = Number(e.target.value); onLive({ r: cr + l, g: cg + l, b: cb + l }); }}
          onPointerUp={onCommit} />
      </div>
      <span style={{ color: 'var(--text-2)' }}>{label}</span>
    </div>
  );
}

// ------------------------------------------------------------------ scopes

function Scopes() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [kind, setKind] = useState<'waveform' | 'vectorscope' | 'histogram'>('waveform');
  useEffect(() => {
    let alive = true;
    const W = 320, H = 180;
    const tick = () => {
      if (!alive) return;
      const src = player.canvas;
      const out = ref.current;
      if (src && out && src.width > 2) {
        const sw = 160, sh = Math.max(2, Math.round((160 * src.height) / src.width));
        const tmp = document.createElement('canvas'); tmp.width = sw; tmp.height = sh;
        const tc = tmp.getContext('2d', { willReadFrequently: true })!;
        tc.drawImage(src, 0, 0, sw, sh);
        let px: Uint8ClampedArray;
        try { px = tc.getImageData(0, 0, sw, sh).data; } catch { setTimeout(tick, 500); return; }
        const ctx = out.getContext('2d')!;
        out.width = W; out.height = H;
        ctx.fillStyle = '#0b0b0d'; ctx.fillRect(0, 0, W, H);
        const img = ctx.getImageData(0, 0, W, H);
        const d = img.data;
        const add = (x: number, y: number, r: number, g: number, b: number) => {
          if (x < 0 || y < 0 || x >= W || y >= H) return;
          const i = (Math.floor(y) * W + Math.floor(x)) * 4;
          d[i] = Math.min(255, d[i] + r); d[i + 1] = Math.min(255, d[i + 1] + g); d[i + 2] = Math.min(255, d[i + 2] + b); d[i + 3] = 255;
        };
        if (kind === 'waveform') {
          for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
            const i = (y * sw + x) * 4;
            const X = (x / sw) * W;
            add(X, H - 1 - (px[i] / 255) * (H - 1), 34, 0, 0);
            add(X, H - 1 - (px[i + 1] / 255) * (H - 1), 0, 34, 0);
            add(X, H - 1 - (px[i + 2] / 255) * (H - 1), 0, 0, 34);
          }
        } else if (kind === 'vectorscope') {
          for (let i = 0; i < px.length; i += 4) {
            const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
            const u = -0.1146 * r - 0.3854 * g + 0.5 * b, v = 0.5 * r - 0.4542 * g - 0.0458 * b;
            add(W / 2 + u * H * 0.9, H / 2 - v * H * 0.9, 60, 60, 60);
          }
        } else {
          const hist = [new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0)];
          for (let i = 0; i < px.length; i += 4) { hist[0][px[i]]++; hist[1][px[i + 1]]++; hist[2][px[i + 2]]++; }
          const mx = Math.max(1, ...hist.flat());
          for (let c = 0; c < 3; c++) for (let k = 0; k < 256; k++) {
            const h = Math.sqrt(hist[c][k] / mx) * (H - 4);
            for (let y = 0; y < h; y++) add((k / 255) * (W - 1), H - 1 - y, c === 0 ? 90 : 0, c === 1 ? 90 : 0, c === 2 ? 90 : 0);
          }
        }
        ctx.putImageData(img, 0, 0);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        if (kind === 'vectorscope') { ctx.beginPath(); ctx.arc(W / 2, H / 2, H * 0.42, 0, Math.PI * 2); ctx.stroke(); }
        else for (const q of [0.25, 0.5, 0.75]) { ctx.beginPath(); ctx.moveTo(0, H * q); ctx.lineTo(W, H * q); ctx.stroke(); }
      }
      setTimeout(tick, useStore.getState().playing ? 300 : 500);
    };
    tick();
    return () => { alive = false; };
  }, [kind]);
  return (
    <div style={{ padding: '4px 10px', display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {(['waveform', 'vectorscope', 'histogram'] as const).map((k) => (
          <button key={k} className={`btn small ${kind === k ? 'primary' : ''}`} onClick={() => setKind(k)}>{{ waveform: 'Dalga formu', vectorscope: 'Vektörskop', histogram: 'Histogram' }[k]}</button>
        ))}
      </div>
      <canvas ref={ref} style={{ width: '100%', aspectRatio: '16/9', borderRadius: 6, background: '#0b0b0d' }} />
    </div>
  );
}

void cancelPreview;
