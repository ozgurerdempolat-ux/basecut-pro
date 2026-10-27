// Graphics editor (Effect Controls when a graphic clip is selected): layers,
// text styling, shapes, fills/gradients, multiple strokes and shadows, saved
// text styles, user templates, system fonts with favourites, in/out animations.
import { useEffect, useMemo, useRef, useState } from 'react';
import { GLayer, GRAPHIC_TEMPLATES, GraphicData, ShapeLayer, Shadow, Stroke, TEXT_ANIMS, TextLayer, asGraphic, layerId, shapeLayer, textLayer } from '../core/graphic';
import { Clip, KeyEase, MediaItem, Sequence } from '../core/model';
import type { TitleData } from '../core/title';
import { BUNDLED_FONTS } from './fonts';
import { HotNumber } from './Panels';
import { committedSeq, edit, toast, useStore } from './store';
import { createTitle, updateGraphic } from './titles';

// ------------------------------------------------------------------ local storage helpers

const ls = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } },
};
const FAV_KEY = 'basecut.fonts.fav', STYLE_KEY = 'basecut.textStyles', TPL_KEY = 'basecut.graphicTemplates';

type TextStyle = Pick<TextLayer, 'font' | 'weight' | 'italic' | 'size' | 'tracking' | 'leading' | 'uppercase' | 'underline' | 'fill' | 'strokes' | 'shadows' | 'box'>;
const styleOf = (l: TextLayer): TextStyle => JSON.parse(JSON.stringify({ font: l.font, weight: l.weight, italic: l.italic, size: l.size, tracking: l.tracking, leading: l.leading, uppercase: l.uppercase, underline: l.underline, fill: l.fill, strokes: l.strokes, shadows: l.shadows, box: l.box }));

export const userTemplates = () => ls.get<{ id: string; name: string; data: GraphicData }[]>(TPL_KEY, []);

// ------------------------------------------------------------------ system fonts

let systemFonts: string[] | null = null;
async function loadSystemFonts(): Promise<string[]> {
  if (systemFonts) return systemFonts;
  try {
    const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
    const list = q ? await q() : [];
    systemFonts = [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b, 'tr'));
  } catch { systemFonts = []; }
  return systemFonts;
}

function FontPicker({ value, onChange }: { value: string; onChange: (f: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sys, setSys] = useState<string[]>(systemFonts ?? []);
  const [fav, setFav] = useState<string[]>(() => ls.get(FAV_KEY, []));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    void loadSystemFonts().then(setSys);
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const toggleFav = (f: string) => { const n = fav.includes(f) ? fav.filter((x) => x !== f) : [...fav, f]; setFav(n); ls.set(FAV_KEY, n); };
  const ql = q.trim().toLocaleLowerCase('tr-TR');
  const match = (f: string) => !ql || f.toLocaleLowerCase('tr-TR').includes(ql);
  const bundled = BUNDLED_FONTS.map((f) => f.family);
  const groups: [string, string[]][] = [
    ['Favoriler', fav.filter(match)],
    ['Uygulamayla gelen', bundled.filter(match)],
    ['Bilgisayardaki yazı tipleri', sys.filter((f) => !bundled.includes(f)).filter(match).slice(0, 400)],
  ];
  return (
    <div className="font-picker" ref={ref}>
      <button className="font-current" style={{ fontFamily: `"${value}"` }} onClick={() => setOpen(!open)}>{value} <span>▾</span></button>
      {open && (
        <div className="font-pop">
          <input autoFocus className="search" placeholder="Yazı tipi ara…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setOpen(false); }} />
          <div className="font-list">
            {groups.map(([g, list]) => list.length > 0 && (
              <div key={g}>
                <div className="font-g">{g}</div>
                {list.map((f) => (
                  <div key={g + f} className={`font-item ${f === value ? 'on' : ''}`} onClick={() => { onChange(f); setOpen(false); }}>
                    <span style={{ fontFamily: `"${f}"` }}>{f}</span>
                    <button className={`fav ${fav.includes(f) ? 'on' : ''}`} title="Favorilere ekle" onClick={(e) => { e.stopPropagation(); toggleFav(f); }}>★</button>
                  </div>
                ))}
              </div>
            ))}
            {sys.length === 0 && <div className="font-g" style={{ textTransform: 'none' }}>Bilgisayardaki yazı tipleri yükleniyor ya da erişim yok.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ small controls

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="g-row"><span className="lbl">{label}</span><span className="g-ctl">{children}</span></div>
);
const Color = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  // the native picker fires on every move; commit on change end only (one undo step, one render)
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input type="color" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onChange(v)} onMouseUp={() => v !== value && onChange(v)} />;
};

// ------------------------------------------------------------------ animations (clip keyframes)

export function applyTextAnim(clipId: string, inId: string, outId: string, sec: number) {
  edit('Metin animasyonu', (s) => {
    const c = s.clips[clipId];
    if (!c) return;
    const n = Math.max(2, Math.min(Math.round(sec * s.fps), Math.floor(c.duration / 2)));
    const end = c.duration - 1;
    const t = c.transform;
    for (const p of [t.opacity, t.posX, t.posY, t.scale]) p.keyframes = [];
    t.opacity.value = 100; t.posX.value = t.posX.value || 0; t.posY.value = t.posY.value || 0; t.scale.value = t.scale.value || 100;
    const base = { op: 100, x: t.posX.value, y: t.posY.value, sc: t.scale.value };
    const off = (id: string) => ({ op: 0, x: base.x + (id === 'left' ? -s.width * 0.25 : 0), y: base.y + (id === 'up' ? s.height * 0.12 : id === 'down' ? -s.height * 0.12 : 0), sc: id === 'pop' ? base.sc * 0.4 : id === 'zoom' ? base.sc * 1.6 : base.sc });
    const keys: { f: number; v: { op: number; x: number; y: number; sc: number }; e: KeyEase }[] = [];
    if (inId !== 'none') { keys.push({ f: 0, v: off(inId), e: inId === 'pop' ? 'fast' : 'in' }, { f: n, v: base, e: 'linear' }); }
    if (outId !== 'none') { keys.push({ f: end - n, v: base, e: 'out' }, { f: end, v: off(outId), e: 'linear' }); }
    if (!keys.length) return;
    const put = (p: typeof t.opacity, pick: (v: (typeof keys)[0]['v']) => number) => {
      const vals = keys.map((k) => pick(k.v));
      if (vals.every((v) => v === vals[0])) return;
      p.keyframes = keys.map((k) => ({ frame: k.f, value: pick(k.v), ease: k.e }));
    };
    put(t.opacity, (v) => v.op); put(t.posX, (v) => v.x); put(t.posY, (v) => v.y); put(t.scale, (v) => v.sc);
  });
}

// ------------------------------------------------------------------ the editor

export function GraphicsEditor({ clip, media }: { clip: Clip; media: MediaItem }) {
  const g = useMemo(() => asGraphic(media.title as TitleData | GraphicData), [media.title]);
  const sel = useStore((s) => s.selLayer);
  const layer = g.layers.find((l) => l.id === sel) ?? g.layers[g.layers.length - 1];
  const [tpl, setTpl] = useState(userTemplates());
  const [styles, setStyles] = useState(() => ls.get<{ name: string; style: TextStyle }[]>(STYLE_KEY, []));
  const [anim, setAnim] = useState({ in: 'none', out: 'none', sec: 0.4 });
  const up = (label: string, fn: (gg: GraphicData) => void) => void updateGraphic(media.id, fn, label);
  const upL = (label: string, fn: (l: GLayer) => void) => { if (layer) up(label, (gg) => { const l = gg.layers.find((x) => x.id === layer.id); if (l) fn(l); }); };

  const add = (l: GLayer) => { up(`${l.name} ekle`, (gg) => { gg.layers.push(l); }); useStore.setState({ selLayer: l.id }); };
  const move = (id: string, d: -1 | 1) => up('Katman sırası', (gg) => { const i = gg.layers.findIndex((x) => x.id === id); const j = i + d; if (i < 0 || j < 0 || j >= gg.layers.length) return; [gg.layers[i], gg.layers[j]] = [gg.layers[j], gg.layers[i]]; });

  return (
    <div className="fx-group graphics">
      <div className="gh"><span className="pill" style={{ padding: '0 5px' }}>T</span>Grafik</div>
      {/* templates */}
      <div className="g-bar">
        <select className="mini" value="" title="Şablon uygula (bu grafiği değiştirir)" onChange={(e) => {
          const v = e.target.value; e.target.value = '';
          const t = GRAPHIC_TEMPLATES.find((x) => x.id === v)?.make() ?? tpl.find((x) => x.id === v)?.data;
          if (t) { const fresh: GraphicData = JSON.parse(JSON.stringify(t)); for (const l of fresh.layers) l.id = layerId(); up('Şablon uygula', (gg) => { gg.layers = fresh.layers; }); useStore.setState({ selLayer: fresh.layers.find((l) => l.kind === 'text')?.id ?? null }); }
        }}>
          <option value="">Şablon…</option>
          {[...new Set(GRAPHIC_TEMPLATES.map((t) => t.group))].map((grp) => <optgroup key={grp} label={grp}>{GRAPHIC_TEMPLATES.filter((t) => t.group === grp).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>)}
          {tpl.length > 0 && <optgroup label="Benim şablonlarım">{tpl.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>}
        </select>
        <button className="btn small" title="Bu grafiği şablon olarak kaydet" onClick={() => {
          const name = window.prompt('Şablon adı', 'Yeni şablon');
          if (!name) return;
          const list = [...userTemplates().filter((x) => x.name !== name), { id: `u_${Date.now().toString(36)}`, name, data: JSON.parse(JSON.stringify(g)) as GraphicData }];
          ls.set(TPL_KEY, list); setTpl(list); toast(`"${name}" şablonu kaydedildi`, 'success');
        }}>Şablon kaydet</button>
      </div>
      {/* layers */}
      <div className="g-add">
        <span>Ekle:</span>
        <button className="btn small" onClick={() => add(textLayer({ y: 50 + (g.layers.length % 4) * 6 }))}>T Metin</button>
        <button className="btn small" title="Dikdörtgen" onClick={() => add(shapeLayer('rect'))}>▭</button>
        <button className="btn small" title="Elips" onClick={() => add(shapeLayer('ellipse'))}>◯</button>
        <button className="btn small" title="Çokgen" onClick={() => add(shapeLayer('polygon'))}>⬡</button>
        <button className="btn small" title="Çizgi" onClick={() => add(shapeLayer('line'))}>╱</button>
      </div>
      <div className="g-layers">
        {[...g.layers].reverse().map((l) => (
          <div key={l.id} className={`g-layer ${layer?.id === l.id ? 'on' : ''} ${l.hidden ? 'hidden' : ''}`} onClick={() => useStore.setState({ selLayer: l.id })}>
            <button className="icon-btn" title="Göster/gizle" onClick={(e) => { e.stopPropagation(); up('Katman görünürlüğü', (gg) => { const x = gg.layers.find((y) => y.id === l.id); if (x) x.hidden = !x.hidden; }); }}>{l.hidden ? '◌' : '●'}</button>
            <span className="g-ic">{l.kind === 'text' ? 'T' : l.kind === 'rect' ? '▭' : l.kind === 'ellipse' ? '◯' : l.kind === 'polygon' ? '⬡' : '╱'}</span>
            <span className="g-name">{l.kind === 'text' ? (l as TextLayer).text.split('\n')[0] || l.name : l.name}</span>
            <button className="icon-btn" title="Öne getir" onClick={(e) => { e.stopPropagation(); move(l.id, 1); }}>↑</button>
            <button className="icon-btn" title="Arkaya gönder" onClick={(e) => { e.stopPropagation(); move(l.id, -1); }}>↓</button>
            <button className="icon-btn" title="Çoğalt" onClick={(e) => { e.stopPropagation(); const c = JSON.parse(JSON.stringify(l)) as GLayer; c.id = layerId(); c.x += 2; c.y += 2; add(c); }}>⧉</button>
            <button className="icon-btn" title="Sil" disabled={g.layers.length <= 1} onClick={(e) => { e.stopPropagation(); up('Katmanı sil', (gg) => { gg.layers = gg.layers.filter((x) => x.id !== l.id); }); }}>✕</button>
          </div>
        ))}
      </div>
      {layer && <LayerProps key={layer.id} layer={layer} upL={upL} styles={styles} setStyles={setStyles} />}
      {/* animation */}
      <div className="g-sub">Animasyon (giriş / çıkış)</div>
      <Row label="Giriş"><select className="mini" value={anim.in} onChange={(e) => setAnim({ ...anim, in: e.target.value })}>{TEXT_ANIMS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Row>
      <Row label="Çıkış"><select className="mini" value={anim.out} onChange={(e) => setAnim({ ...anim, out: e.target.value })}>{TEXT_ANIMS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Row>
      <Row label="Süre"><HotNumber value={anim.sec} step={0.02} unit="sn" onCommit={(v) => setAnim({ ...anim, sec: Math.max(0.05, Math.min(5, v)) })} /><button className="btn small primary" onClick={() => applyTextAnim(clip.id, anim.in, anim.out, anim.sec)}>Uygula</button></Row>
    </div>
  );
}

function LayerProps({ layer, upL, styles, setStyles }: { layer: GLayer; upL: (label: string, fn: (l: GLayer) => void) => void; styles: { name: string; style: TextStyle }[]; setStyles: (s: { name: string; style: TextStyle }[]) => void }) {
  const isText = layer.kind === 'text';
  const t = layer as TextLayer, s = layer as ShapeLayer;
  const [text, setText] = useState(isText ? t.text : '');
  return (
    <div className="g-props">
      {isText && (
        <>
          <div style={{ padding: '4px 10px' }}>
            <textarea className="g-text" value={text} rows={Math.min(5, Math.max(2, text.split('\n').length))} onChange={(e) => setText(e.target.value)}
              onBlur={() => text !== t.text && upL('Metni düzenle', (l) => { (l as TextLayer).text = text; })} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur(); }} />
          </div>
          <Row label="Yazı tipi"><FontPicker value={t.font} onChange={(f) => upL('Yazı tipi', (l) => { (l as TextLayer).font = f; })} /></Row>
          <Row label="Kalınlık">
            <select className="mini" value={t.weight} onChange={(e) => upL('Kalınlık', (l) => { (l as TextLayer).weight = Number(e.target.value); })}>
              {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{({ 100: 'İnce', 200: 'Ekstra hafif', 300: 'Hafif', 400: 'Normal', 500: 'Orta', 600: 'Yarı kalın', 700: 'Kalın', 800: 'Ekstra kalın', 900: 'Siyah' } as Record<number, string>)[w]}</option>)}
            </select>
            <button className={`btn small ${t.italic ? 'primary' : ''}`} style={{ fontStyle: 'italic' }} onClick={() => upL('İtalik', (l) => { (l as TextLayer).italic = !t.italic; })}>I</button>
            <button className={`btn small ${t.underline ? 'primary' : ''}`} style={{ textDecoration: 'underline' }} onClick={() => upL('Altı çizili', (l) => { (l as TextLayer).underline = !t.underline; })}>U</button>
            <button className={`btn small ${t.uppercase ? 'primary' : ''}`} onClick={() => upL('Büyük harf', (l) => { (l as TextLayer).uppercase = !t.uppercase; })}>AA</button>
          </Row>
          <Row label="Boyut"><HotNumber value={t.size} step={1} unit="px" onCommit={(v) => upL('Yazı boyutu', (l) => { (l as TextLayer).size = Math.max(4, Math.min(800, v)); })} /></Row>
          <Row label="Harf / satır"><HotNumber value={t.tracking} step={0.5} unit="px" onCommit={(v) => upL('Harf aralığı', (l) => { (l as TextLayer).tracking = v; })} /><HotNumber value={t.leading} step={0.01} unit="×" onCommit={(v) => upL('Satır aralığı', (l) => { (l as TextLayer).leading = Math.max(0.5, Math.min(4, v)); })} /></Row>
          <Row label="Hizalama">{(['left', 'center', 'right'] as const).map((a) => <button key={a} className={`btn small ${t.align === a ? 'primary' : ''}`} onClick={() => upL('Hizalama', (l) => { (l as TextLayer).align = a; })}>{({ left: 'Sol', center: 'Orta', right: 'Sağ' })[a]}</button>)}</Row>
          <Row label="Satır kaydır"><HotNumber value={t.wrap} step={0.5} unit="%" onCommit={(v) => upL('Satır kaydırma', (l) => { (l as TextLayer).wrap = Math.max(0, Math.min(100, v)); })} /><span className="g-hint">0 = kapalı</span></Row>
        </>
      )}
      {!isText && (
        <>
          <Row label={s.kind === 'line' ? 'Uzunluk' : 'Genişlik / yük.'}><HotNumber value={s.w} step={2} unit="px" onCommit={(v) => upL('Boyut', (l) => { (l as ShapeLayer).w = Math.max(1, v); })} />{s.kind !== 'line' && <HotNumber value={s.h} step={2} unit="px" onCommit={(v) => upL('Boyut', (l) => { (l as ShapeLayer).h = Math.max(1, v); })} />}</Row>
          {s.kind === 'rect' && <Row label="Köşe"><HotNumber value={s.radius} step={1} unit="px" onCommit={(v) => upL('Köşe yarıçapı', (l) => { (l as ShapeLayer).radius = Math.max(0, v); })} /></Row>}
          {s.kind === 'polygon' && <Row label="Kenar sayısı"><HotNumber value={s.sides} step={1} unit="" onCommit={(v) => upL('Kenar sayısı', (l) => { (l as ShapeLayer).sides = Math.max(3, Math.min(24, Math.round(v))); })} /></Row>}
        </>
      )}
      <Row label="Konum X / Y"><HotNumber value={layer.x} step={0.2} unit="%" onCommit={(v) => upL('Konum', (l) => { l.x = v; })} /><HotNumber value={layer.y} step={0.2} unit="%" onCommit={(v) => upL('Konum', (l) => { l.y = v; })} /></Row>
      <Row label="Döndür / Opak."><HotNumber value={layer.rotation} step={0.5} unit="°" onCommit={(v) => upL('Döndürme', (l) => { l.rotation = v; })} /><HotNumber value={layer.opacity} step={1} unit="%" onCommit={(v) => upL('Opaklık', (l) => { l.opacity = Math.max(0, Math.min(100, v)); })} /></Row>
      {/* fill */}
      {layer.kind !== 'line' && (
        <Row label="Dolgu">
          <label className="check"><input type="checkbox" checked={!!layer.fill} onChange={(e) => upL('Dolgu', (l) => { l.fill = e.target.checked ? { color: '#ffffff', opacity: 1, gradient: null } : null; })} /></label>
          {layer.fill && <>
            <Color value={layer.fill.color} onChange={(v) => upL('Dolgu rengi', (l) => { if (l.fill) l.fill.color = v; })} />
            <label className="check" title="Renk geçişi (gradyan)"><input type="checkbox" checked={!!layer.fill.gradient} onChange={(e) => upL('Gradyan', (l) => { if (l.fill) l.fill.gradient = e.target.checked ? { to: '#ff6a3d', angle: 90 } : null; })} /> Geçiş</label>
            {layer.fill.gradient && <><Color value={layer.fill.gradient.to} onChange={(v) => upL('Gradyan rengi', (l) => { if (l.fill?.gradient) l.fill.gradient.to = v; })} /><HotNumber value={layer.fill.gradient.angle} step={1} unit="°" onCommit={(v) => upL('Gradyan açısı', (l) => { if (l.fill?.gradient) l.fill.gradient.angle = v; })} /></>}
            <HotNumber value={Math.round(layer.fill.opacity * 100)} step={1} unit="%" onCommit={(v) => upL('Dolgu opaklığı', (l) => { if (l.fill) l.fill.opacity = Math.max(0, Math.min(100, v)) / 100; })} />
          </>}
        </Row>
      )}
      {/* strokes */}
      <div className="g-sub">Konturlar <button className="icon-btn" title="Kontur ekle" onClick={() => upL('Kontur ekle', (l) => { l.strokes.push({ color: l.strokes.length ? '#ffffff' : '#000000', width: 8 + l.strokes.length * 10, opacity: 1 }); })}>＋</button></div>
      {layer.strokes.map((st: Stroke, i) => (
        <Row key={i} label={`Kontur ${i + 1}`}>
          <Color value={st.color} onChange={(v) => upL('Kontur rengi', (l) => { l.strokes[i].color = v; })} />
          <HotNumber value={st.width} step={0.5} unit="px" onCommit={(v) => upL('Kontur kalınlığı', (l) => { l.strokes[i].width = Math.max(0, v); })} />
          <HotNumber value={Math.round(st.opacity * 100)} step={1} unit="%" onCommit={(v) => upL('Kontur opaklığı', (l) => { l.strokes[i].opacity = Math.max(0, Math.min(100, v)) / 100; })} />
          <button className="icon-btn" onClick={() => upL('Konturu kaldır', (l) => { l.strokes.splice(i, 1); })}>✕</button>
        </Row>
      ))}
      {/* shadows */}
      <div className="g-sub">Gölgeler <button className="icon-btn" title="Gölge ekle" onClick={() => upL('Gölge ekle', (l) => { l.shadows.push({ color: '#000000', opacity: 0.5, blur: 14, dx: 0, dy: 6 }); })}>＋</button></div>
      {layer.shadows.map((sh: Shadow, i) => (
        <div key={i}>
          <Row label={`Gölge ${i + 1}`}>
            <Color value={sh.color} onChange={(v) => upL('Gölge rengi', (l) => { l.shadows[i].color = v; })} />
            <HotNumber value={Math.round(sh.opacity * 100)} step={1} unit="%" onCommit={(v) => upL('Gölge opaklığı', (l) => { l.shadows[i].opacity = Math.max(0, Math.min(100, v)) / 100; })} />
            <button className="icon-btn" onClick={() => upL('Gölgeyi kaldır', (l) => { l.shadows.splice(i, 1); })}>✕</button>
          </Row>
          <Row label="  yumuşak / X / Y">
            <HotNumber value={sh.blur} step={0.5} unit="" onCommit={(v) => upL('Gölge yumuşaklığı', (l) => { l.shadows[i].blur = Math.max(0, v); })} />
            <HotNumber value={sh.dx} step={0.5} unit="" onCommit={(v) => upL('Gölge X', (l) => { l.shadows[i].dx = v; })} />
            <HotNumber value={sh.dy} step={0.5} unit="" onCommit={(v) => upL('Gölge Y', (l) => { l.shadows[i].dy = v; })} />
          </Row>
        </div>
      ))}
      {isText && (
        <>
          <Row label="Arka plan kutusu">
            <label className="check"><input type="checkbox" checked={!!t.box} onChange={(e) => upL('Arka plan kutusu', (l) => { (l as TextLayer).box = e.target.checked ? { color: '#000000', opacity: 0.6, padding: 28, radius: 16 } : null; })} /></label>
            {t.box && <>
              <Color value={t.box.color} onChange={(v) => upL('Kutu rengi', (l) => { const b = (l as TextLayer).box; if (b) b.color = v; })} />
              <HotNumber value={Math.round(t.box.opacity * 100)} step={1} unit="%" onCommit={(v) => upL('Kutu opaklığı', (l) => { const b = (l as TextLayer).box; if (b) b.opacity = Math.max(0, Math.min(100, v)) / 100; })} />
              <HotNumber value={t.box.padding} step={1} unit="" onCommit={(v) => upL('Kutu boşluğu', (l) => { const b = (l as TextLayer).box; if (b) b.padding = Math.max(0, v); })} />
              <HotNumber value={t.box.radius} step={1} unit="" onCommit={(v) => upL('Kutu köşesi', (l) => { const b = (l as TextLayer).box; if (b) b.radius = Math.max(0, v); })} />
            </>}
          </Row>
          <div className="g-sub">Metin stilleri</div>
          <Row label="Stil">
            <select className="mini" value="" onChange={(e) => { const st = styles.find((x) => x.name === e.target.value); e.target.value = ''; if (st) upL(`Stil: ${st.name}`, (l) => { Object.assign(l, JSON.parse(JSON.stringify(st.style))); }); }}>
              <option value="">Stil uygula…</option>
              {styles.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
            <button className="btn small" onClick={() => {
              const name = window.prompt('Stil adı', `Stil ${styles.length + 1}`);
              if (!name) return;
              const list = [...styles.filter((x) => x.name !== name), { name, style: styleOf(t) }];
              ls.set(STYLE_KEY, list); setStyles(list); toast(`"${name}" stili kaydedildi`, 'success');
            }}>Kaydet</button>
          </Row>
        </>
      )}
    </div>
  );
}

/** quick "new graphic" helper used by the project panel menu */
export function newGraphicFromTemplate(id: string) {
  const u = userTemplates().find((t) => t.id === id);
  if (u) { const d: GraphicData = JSON.parse(JSON.stringify(u.data)); for (const l of d.layers) l.id = layerId(); return createTitle('big', undefined, d); }
  return createTitle(id);
}

export function isGraphicClip(c: Clip | undefined, seq: Sequence, media: Record<string, MediaItem>): boolean { void seq; return !!c && !!media[c.mediaId]?.title; }
void committedSeq;
