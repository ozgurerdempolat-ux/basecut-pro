import { useMemo, useRef, useState } from 'react';
import { AnimatableParam, Clip, LabelColor, MediaItem, evalParam, framesToTimecode, makeSequence } from '../core/model';
import { I } from './icons';
import { Tool, activeSeq, committedSeq, edit, editProject, importPaths, setPlayhead, useStore } from './store';

export const LABELS: Record<LabelColor, string> = {
  violet: '#8f6bd8', iris: '#5b78e5', caribbean: '#22b8a0', lavender: '#b796e8', cerulean: '#2f9ad6', forest: '#4c9a4c',
  rose: '#e56f9b', mango: '#f0a03c', purple: '#9b4fc9', blue: '#3c6fd6', teal: '#2aa198', magenta: '#d64fae', tan: '#c8a77a',
  green: '#4cc06a', brown: '#9a6a44', yellow: '#e5cc4c',
};

// -------------------------------------------------------------------- project panel

export function ProjectPanel() {
  const media = useStore((s) => s.project.media);
  const sequences = useStore((s) => s.project.sequences);
  const activeId = useStore((s) => s.project.activeSequenceId);
  const selected = useStore((s) => s.selectedMedia);
  const assets = useStore((s) => s.assets);
  const proxies = useStore((s) => s.proxies);
  const focused = useStore((s) => s.focus === 'project');
  const [q, setQ] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [thumb, setThumb] = useState(130);
  const [over, setOver] = useState(false);
  const [tab, setTab] = useState<'project' | 'fx'>('project');
  const items = useMemo(() => Object.values(media).filter((m) => m.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name)), [media, q]);

  const open = async () => {
    const paths = await window.kurgu.openFiles();
    if (paths.length) await importPaths(paths);
  };

  const select = (id: string, e: React.MouseEvent) => {
    useStore.setState((s) => ({
      focus: 'project',
      selectedMedia: e.shiftKey || e.metaKey || e.ctrlKey ? (s.selectedMedia.includes(id) ? s.selectedMedia.filter((x) => x !== id) : [...s.selectedMedia, id]) : [id],
    }));
  };

  const openInSource = (m: MediaItem) => useStore.setState({ sourceMediaId: m.id, focus: 'source' });

  return (
    <div className={`panel ${focused ? 'focused' : ''}`} onMouseDown={() => useStore.setState({ focus: 'project' })}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault(); setOver(false);
        const paths = [...e.dataTransfer.files].map((f) => (f as File & { path?: string }).path ?? '').filter(Boolean);
        if (paths.length) await importPaths(paths);
      }}>
      <div className="panel-tabs">
        <div className={`tab ${tab === 'project' ? 'on' : ''}`} onClick={() => setTab('project')}>Proje</div>
        <div className={`tab ${tab === 'fx' ? 'on' : ''}`} onClick={() => setTab('fx')}>Efekt Kontrolleri</div>
        <div className="grow" />
      </div>
      {tab === 'fx' ? <EffectControls /> : (
        <>
          <div className="proj-toolbar">
            <input className="search" placeholder="Ara…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <button className={`icon-btn ${view === 'grid' ? 'on' : ''}`} title="Simge görünümü" onClick={() => setView('grid')}>{I.grid}</button>
            <button className={`icon-btn ${view === 'list' ? 'on' : ''}`} title="Liste görünümü" onClick={() => setView('list')}>{I.list}</button>
            {view === 'grid' && <input type="range" min={80} max={240} value={thumb} onChange={(e) => setThumb(Number(e.target.value))} style={{ width: 60 }} title="Küçük resim boyutu" />}
            <button className="btn small primary" onClick={open}>{I.import} İçe aktar</button>
          </div>
          <div className="panel-body">
            {over && <div className="drop-hint">Bırakın — içe aktarılacak</div>}
            {items.length === 0 && Object.keys(sequences).length <= 1 && (
              <div className="empty">
                <div className="big">Henüz medya yok</div>
                <div>Dosyaları buraya sürükleyin veya içe aktarın.<br />Video, ses ve fotoğraf; MP4, MOV, MKV, HEVC, ProRes, WAV, MP3, PNG, JPG, HEIC…</div>
                <button className="btn primary" onClick={open}>{I.import} Medya içe aktar</button>
                <div style={{ fontSize: 11 }}><span className="kbd">Ctrl</span> + <span className="kbd">I</span></div>
              </div>
            )}
            {view === 'grid' ? (
              <div className="media-grid" style={{ ['--thumb' as string]: `${thumb}px` }}>
                {Object.values(sequences).map((s) => (
                  <div key={s.id} className={`media-card ${s.id === activeId ? 'sel' : ''}`} onDoubleClick={() => useStore.setState((st) => ({ project: { ...st.project, activeSequenceId: s.id }, selection: [] }))}>
                    <div className="thumb" style={{ background: 'linear-gradient(135deg, #2a2a33, #1a1a20)' }}>
                      <span className="badge">Sekans</span>
                      <span className="dur">{s.width}×{s.height}</span>
                    </div>
                    <div className="name"><span className="label-dot" style={{ background: 'var(--accent)' }} />{s.name}</div>
                  </div>
                ))}
                {items.map((m) => {
                  const a = assets[m.path];
                  const strip = a?.filmstrip;
                  const frames = a?.filmstripFrames ?? 1;
                  const bg: React.CSSProperties = m.kind === 'image'
                    ? { backgroundImage: `url("${window.kurgu.mediaUrl(proxies[m.path] ?? m.path)}")` }
                    : strip ? { backgroundImage: `url("${window.kurgu.mediaUrl(strip)}")`, backgroundSize: `${frames * 100}% 100%`, backgroundPosition: '0 0' } : {};
                  return (
                    <div key={m.id} className={`media-card ${selected.includes(m.id) ? 'sel' : ''}`} draggable
                      onDragStart={(e) => {
                        const ids = selected.includes(m.id) ? selected : [m.id];
                        e.dataTransfer.setData('application/x-kurgu-media', JSON.stringify({ ids }));
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onMouseDown={(e) => select(m.id, e)} onDoubleClick={() => openInSource(m)}
                      onMouseMove={(e) => {
                        if (!strip || m.kind !== 'video') return;
                        const r = e.currentTarget.getBoundingClientRect();
                        const i = Math.floor(((e.clientX - r.left) / r.width) * frames);
                        const el = e.currentTarget.querySelector('.thumb') as HTMLElement;
                        el.style.backgroundPosition = `${(i / Math.max(1, frames - 1)) * 100}% 0`;
                      }}
                      title={`${m.path}\n${m.width ? `${m.width}×${m.height} · ` : ''}${m.fps ? `${Math.round(m.fps * 100) / 100} fps · ` : ''}${m.codec}`}>
                      <div className="thumb" style={{ ...bg, backgroundRepeat: 'no-repeat', backgroundSize: bg.backgroundSize ?? 'cover' }}>
                        <span className="badge">{m.kind === 'video' ? 'Video' : m.kind === 'audio' ? 'Ses' : 'Görsel'}{proxies[m.path] ? ' · proxy' : ''}</span>
                        {m.kind !== 'image' && <span className="dur">{framesToTimecode(m.duration * (m.fps || 30), m.fps || 30)}</span>}
                        {m.kind === 'audio' && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--audio)' }}>{I.wave}</div>}
                        {!m.online && <div style={{ position: 'absolute', inset: 0, background: 'rgba(138,34,50,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>Çevrimdışı</div>}
                      </div>
                      <div className="name"><span className="label-dot" style={{ background: LABELS[m.label] }} />{m.name}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <table className="media-list">
                <thead><tr><th>Ad</th><th>Süre</th><th>Boyut</th><th>FPS</th><th>Kodek</th></tr></thead>
                <tbody>
                  {items.map((m) => (
                    <tr key={m.id} className={selected.includes(m.id) ? 'sel' : ''} draggable
                      onDragStart={(e) => e.dataTransfer.setData('application/x-kurgu-media', JSON.stringify({ ids: selected.includes(m.id) ? selected : [m.id] }))}
                      onMouseDown={(e) => select(m.id, e)} onDoubleClick={() => openInSource(m)}>
                      <td><span className="label-dot" style={{ background: LABELS[m.label], display: 'inline-block', marginRight: 6 }} />{m.name}</td>
                      <td>{m.kind === 'image' ? '—' : framesToTimecode(m.duration * (m.fps || 30), m.fps || 30)}</td>
                      <td>{m.width ? `${m.width}×${m.height}` : '—'}</td>
                      <td>{m.kind === 'video' ? Math.round(m.fps * 100) / 100 : '—'}</td>
                      <td>{m.codec}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function newSequenceFrom(preset: { name: string; width: number; height: number; fps: number }) {
  editProject('Yeni sekans', (p) => {
    const s = makeSequence(preset);
    p.sequences[s.id] = s;
    p.activeSequenceId = s.id;
  });
}

// -------------------------------------------------------------------- effect controls

export function EffectControls() {
  const seq = useStore((s) => activeSeq(s));
  const selection = useStore((s) => s.selection);
  const clip = selection.map((id) => seq.clips[id]).find((c) => c && c.stream === 'video') ?? selection.map((id) => seq.clips[id]).find(Boolean);
  if (!clip) return <div className="empty"><div className="big">Klip seçilmedi</div><div>Timeline'da bir klip seçin: konum, ölçek, döndürme, opaklık ve ses seviyesini buradan ayarlayın, anahtar kare ekleyin.</div></div>;
  const local = Math.max(0, Math.min(clip.duration - 1, seq.playhead - clip.start));
  return (
    <div className="panel-body fx-panel">
      <div style={{ padding: '4px 10px 8px', color: 'var(--text-2)' }}>
        <b style={{ color: 'var(--text)' }}>{clip.name}</b> · {framesToTimecode(clip.duration, seq.fps)} · Hız %{Math.round(clip.speed * 100)}
      </div>
      {clip.stream === 'video' && (
        <>
          <Group title="Hareket">
            <ParamRow clip={clip} k="posX" label="Konum X" local={local} step={1} unit="px" />
            <ParamRow clip={clip} k="posY" label="Konum Y" local={local} step={1} unit="px" />
            <ParamRow clip={clip} k="scale" label="Ölçek" local={local} step={0.5} unit="%" min={0} />
            <ParamRow clip={clip} k="rotation" label="Döndürme" local={local} step={0.5} unit="°" />
          </Group>
          <Group title="Opaklık">
            <ParamRow clip={clip} k="opacity" label="Opaklık" local={local} step={1} unit="%" min={0} max={100} />
          </Group>
        </>
      )}
      {clip.stream === 'audio' && (
        <Group title="Ses Seviyesi">
          <ParamRow clip={clip} k="volume" label="Seviye" local={local} step={0.1} unit="dB" min={-60} max={24} />
        </Group>
      )}
      <div style={{ padding: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn small" onClick={() => edit('Klibi kareye sığdır', (s) => { const c = s.clips[clip.id]; c.transform.scale.value = 100; c.transform.scale.keyframes = []; })}>Kareye sığdır</button>
        <button className="btn small" onClick={() => {
          const st = useStore.getState();
          const m = st.project.media[clip.mediaId];
          const sq = committedSeq(st);
          if (!m?.width) return;
          const fit = Math.min(sq.width / m.width, sq.height / m.height);
          const fill = Math.max(sq.width / m.width, sq.height / m.height);
          edit('Kareyi doldur', (s) => { s.clips[clip.id].transform.scale.value = Math.round((fill / fit) * 10000) / 100; });
        }}>Kareyi doldur</button>
        <button className="btn small" onClick={() => edit('Efektleri sıfırla', (s) => { const c = s.clips[clip.id]; for (const p of Object.values(c.transform)) { p.keyframes = []; } c.transform.posX.value = 0; c.transform.posY.value = 0; c.transform.scale.value = 100; c.transform.rotation.value = 0; c.transform.opacity.value = 100; })}>{I.reset} Sıfırla</button>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="fx-group">
      <div className="gh" onClick={() => setOpen(!open)}><span style={{ color: 'var(--text-3)' }}>{open ? '▾' : '▸'}</span><span className="pill" style={{ padding: '0 5px' }}>fx</span>{title}</div>
      {open && children}
    </div>
  );
}

function getParam(c: Clip, k: string): AnimatableParam {
  return k === 'volume' ? c.volumeDb : (c.transform as unknown as Record<string, AnimatableParam>)[k];
}

function ParamRow({ clip, k, label, local, step, unit, min, max }: { clip: Clip; k: string; label: string; local: number; step: number; unit: string; min?: number; max?: number }) {
  const p = getParam(clip, k);
  const value = evalParam(p, local);
  const animated = p.keyframes.length > 0;
  const kfHere = p.keyframes.find((x) => x.frame === local);
  const clamp = (v: number) => Math.max(min ?? -1e9, Math.min(max ?? 1e9, v));

  const setValue = (v: number, label2 = `${label} değiştir`) => edit(label2, (s) => {
    const pp = getParam(s.clips[clip.id], k);
    const nv = clamp(Math.round(v * 100) / 100);
    if (pp.keyframes.length) {
      const ex = pp.keyframes.find((x) => x.frame === local);
      if (ex) ex.value = nv;
      else { pp.keyframes.push({ frame: local, value: nv, ease: 'linear' }); pp.keyframes.sort((a, b) => a.frame - b.frame); }
    } else pp.value = nv;
  });

  const toggleAnim = () => edit(animated ? 'Animasyonu kapat' : 'Animasyonu aç', (s) => {
    const pp = getParam(s.clips[clip.id], k);
    if (pp.keyframes.length) { pp.value = evalParam(pp, local); pp.keyframes = []; }
    else pp.keyframes = [{ frame: local, value: pp.value, ease: 'linear' }];
  });

  const toggleKey = () => edit('Anahtar kare', (s) => {
    const pp = getParam(s.clips[clip.id], k);
    if (!pp.keyframes.length) { pp.keyframes = [{ frame: local, value: pp.value, ease: 'linear' }]; return; }
    const i = pp.keyframes.findIndex((x) => x.frame === local);
    if (i >= 0) pp.keyframes.splice(i, 1);
    else { pp.keyframes.push({ frame: local, value: evalParam(pp, local), ease: 'linear' }); pp.keyframes.sort((a, b) => a.frame - b.frame); }
  });

  const jump = (dir: -1 | 1) => {
    const ks = p.keyframes.map((x) => x.frame).filter((f) => (dir < 0 ? f < local : f > local));
    if (!ks.length) return;
    setPlayhead(clip.start + (dir < 0 ? Math.max(...ks) : Math.min(...ks)));
  };

  return (
    <div className="fx-row">
      <button className={`icon-btn stopwatch ${animated ? 'on' : ''}`} title="Animasyonu aç/kapat" onClick={toggleAnim}>{I.stopwatch}</button>
      <span className="lbl">{label}</span>
      <HotNumber value={value} step={step} unit={unit} onCommit={(v) => setValue(v)} />
      <span style={{ display: 'flex', gap: 0 }}>
        {animated && <>
          <button className="icon-btn" style={{ width: 14 }} title="Önceki anahtar kare" onClick={() => jump(-1)}>‹</button>
          <button className={`icon-btn ${kfHere ? 'on' : ''}`} style={{ width: 16 }} title="Anahtar kare ekle/sil" onClick={toggleKey}>◆</button>
          <button className="icon-btn" style={{ width: 14 }} title="Sonraki anahtar kare" onClick={() => jump(1)}>›</button>
        </>}
      </span>
    </div>
  );
}

/** a number you can drag left/right to change, or click to type, like pro apps */
export function HotNumber({ value, step, unit, onCommit }: { value: number; step: number; unit?: string; onCommit: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [txt, setTxt] = useState('');
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const [live, setLive] = useState<number | null>(null);
  if (editing) {
    return (
      <div className="hot"><input autoFocus value={txt} onChange={(e) => setTxt(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { const n = Number(txt.replace(',', '.')); if (Number.isFinite(n)) onCommit(n); setEditing(false); } if (e.key === 'Escape') setEditing(false); }}
        onBlur={() => { const n = Number(txt.replace(',', '.')); if (Number.isFinite(n)) onCommit(n); setEditing(false); }} /></div>
    );
  }
  const shown = live ?? value;
  return (
    <div className="hot" onMouseDown={(e) => {
      drag.current = { x: e.clientX, v: value, moved: false };
      const mv = (ev: MouseEvent) => {
        const d = drag.current!;
        const dx = ev.clientX - d.x;
        if (Math.abs(dx) > 2) d.moved = true;
        setLive(d.v + dx * step * (ev.shiftKey ? 10 : ev.ctrlKey ? 0.1 : 1));
      };
      const up = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
        const d = drag.current!;
        drag.current = null;
        setLive(null);
        if (d.moved) onCommit(d.v + (ev.clientX - d.x) * step * (ev.shiftKey ? 10 : ev.ctrlKey ? 0.1 : 1));
        else { setTxt(String(Math.round(value * 100) / 100)); setEditing(true); }
      };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    }}>{(Math.round(shown * 100) / 100).toLocaleString('tr-TR')}{unit ? ` ${unit}` : ''}</div>
  );
}

// -------------------------------------------------------------------- tools

const TOOLS: { id: Tool; icon: keyof typeof I; label: string; key: string }[] = [
  { id: 'select', icon: 'select', label: 'Seçim aracı', key: 'V' },
  { id: 'trackSelect', icon: 'trackSelect', label: 'İleri iz seçimi', key: 'A' },
  { id: 'ripple', icon: 'ripple', label: 'Dalgalı düzenleme (ripple)', key: 'B' },
  { id: 'roll', icon: 'roll', label: 'Kaydırarak düzenleme (rolling)', key: 'N' },
  { id: 'rate', icon: 'rate', label: 'Hız esnetme', key: 'R' },
  { id: 'razor', icon: 'razor', label: 'Jilet', key: 'C' },
  { id: 'slip', icon: 'slip', label: 'Slip', key: 'Y' },
  { id: 'slide', icon: 'slide', label: 'Slide', key: 'U' },
  { id: 'hand', icon: 'hand', label: 'El', key: 'H' },
  { id: 'zoom', icon: 'zoom', label: 'Yakınlaştırma', key: 'Z' },
];

export function Tools() {
  const tool = useStore((s) => s.tool);
  return (
    <div className="tools">
      {TOOLS.map((t, i) => (
        <span key={t.id} style={{ display: 'contents' }}>
          {(i === 2 || i === 5 || i === 8) && <div className="sep" />}
          <button className={`icon-btn ${tool === t.id ? 'on' : ''}`} title={`${t.label} (${t.key})`} onClick={() => useStore.setState({ tool: t.id })}>{I[t.icon]}</button>
        </span>
      ))}
    </div>
  );
}
