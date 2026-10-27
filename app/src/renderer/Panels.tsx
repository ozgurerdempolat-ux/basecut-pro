import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatableParam, BLEND_MODES, BlendMode, Clip, KEY_EASES, KeyEase, LabelColor, MediaItem, evalParam, framesToTimecode, makeSequence } from '../core/model';
import { MenuItem, openMenu } from './ContextMenu';
import { I } from './icons';
import { CaptionsPanel } from './Captions';
import { ColorPanel } from './ColorPanel';
import { AudioEffectStack, EffectStack, EffectsLibrary, TransitionControls } from './Effects';
import { MixerPanel } from './Mixer';
import { TranscriptPanel } from './Transcript';
import { MarkersPanel } from './Markers';
import { MaskControls } from './MaskUI';
import { SyntheticKind, createSynthetic } from './synthetic';
import { mediaMenu } from './menus';
import { createTitle, updateTitle } from './titles';
import { TITLE_FONTS, TITLE_PRESETS, TitleData } from '../core/title';
import { Tool, activeSeq, droppedPaths, commitPreview, committedSeq, edit, editProject, importPaths, previewEdit, setPlayhead, useStore } from './store';

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
  const tab = useStore((s) => s.leftTab);
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // keep the active tab in view (scrollIntoView would also scroll the panel vertically)
    const bar = tabsRef.current, el = bar?.querySelector<HTMLElement>('.tab.on');
    if (!bar || !el) return;
    if (el.offsetLeft < bar.scrollLeft) bar.scrollLeft = el.offsetLeft - 6;
    else if (el.offsetLeft + el.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = el.offsetLeft + el.offsetWidth - bar.clientWidth + 6;
  }, [tab]);
  const setTab = (t: 'project' | 'fx' | 'captions' | 'color' | 'effects' | 'mixer' | 'text' | 'markers') => useStore.setState({ leftTab: t });
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
        const paths = droppedPaths(e.dataTransfer);
        if (paths.length) await importPaths(paths);
      }}>
      <div className="panel-tabs" ref={tabsRef} onWheel={(e) => { if (tabsRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) tabsRef.current.scrollLeft += e.deltaY; }}>
        <div className={`tab ${tab === 'project' ? 'on' : ''}`} onClick={() => setTab('project')}>Proje</div>
        <div className={`tab ${tab === 'effects' ? 'on' : ''}`} onClick={() => setTab('effects')}>Efektler</div>
        <div className={`tab ${tab === 'fx' ? 'on' : ''}`} onClick={() => setTab('fx')}>Efekt Kontrolleri</div>
        <div className={`tab ${tab === 'color' ? 'on' : ''}`} onClick={() => setTab('color')}>Renk</div>
        <div className={`tab ${tab === 'captions' ? 'on' : ''}`} onClick={() => setTab('captions')}>Altyazı</div>
        <div className={`tab ${tab === 'text' ? 'on' : ''}`} onClick={() => setTab('text')}>Metin</div>
        <div className={`tab ${tab === 'mixer' ? 'on' : ''}`} onClick={() => setTab('mixer')}>Mikser</div>
        <div className={`tab ${tab === 'markers' ? 'on' : ''}`} onClick={() => setTab('markers')}>İşaretler</div>
        <div className="grow" />
      </div>
      {tab === 'markers' ? <MarkersPanel /> : tab === 'text' ? <TranscriptPanel /> : tab === 'mixer' ? <MixerPanel /> : tab === 'effects' ? <EffectsLibrary /> : tab === 'color' ? <ColorPanel /> : tab === 'captions' ? <CaptionsPanel /> : tab === 'fx' ? <EffectControls /> : (
        <>
          <div className="proj-toolbar">
            <input className="search" placeholder="Ara…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <button className={`icon-btn ${view === 'grid' ? 'on' : ''}`} title="Simge görünümü" onClick={() => setView('grid')}>{I.grid}</button>
            <button className={`icon-btn ${view === 'list' ? 'on' : ''}`} title="Liste görünümü" onClick={() => setView('list')}>{I.list}</button>
            {view === 'grid' && <input type="range" min={80} max={240} value={thumb} onChange={(e) => setThumb(Number(e.target.value))} style={{ width: 60 }} title="Küçük resim boyutu" />}
            <select className="mini" value="" title="Yeni başlık" onChange={(e) => { if (e.target.value) void createTitle(e.target.value); e.target.value = ''; }}>
              <option value="">+ Başlık</option>
              {TITLE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="mini" value="" title="Yeni öğe" onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v === 'matte') { const c = window.prompt('Renk (ör. #ff6a3d)', '#ff6a3d'); const n = c ? parseInt(c.replace('#', ''), 16) : NaN; if (Number.isFinite(n)) void createSynthetic('matte', n); } else if (v) void createSynthetic(v as SyntheticKind); }}>
              <option value="">+ Yeni öğe</option>
              <option value="adjustment">Ayar katmanı</option>
              <option value="matte">Renk katmanı…</option>
              <option value="black">Siyah video</option>
              <option value="transparent">Şeffaf video</option>
            </select>
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
                      onMouseDown={(e) => { if (e.button === 0) select(m.id, e); }} onContextMenu={(e) => mediaMenu(e, m, () => openInSource(m))} onDoubleClick={() => openInSource(m)}
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
                      onMouseDown={(e) => { if (e.button === 0) select(m.id, e); }} onContextMenu={(e) => mediaMenu(e, m, () => openInSource(m))} onDoubleClick={() => openInSource(m)}>
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
  // the audio half of a linked selection is shown below the video controls (as in Premiere)
  const aclip = clip?.stream === 'audio' ? clip : selection.map((id) => seq.clips[id]).find((c) => c && c.stream === 'audio');
  if (!clip) return <div className="empty"><div className="big">Klip seçilmedi</div><div>Timeline'da bir klip seçin: konum, ölçek, döndürme, opaklık ve ses seviyesini buradan ayarlayın, anahtar kare ekleyin.</div></div>;
  const local = Math.max(0, Math.min(clip.duration - 1, seq.playhead - clip.start));
  const media = useStore.getState().project.media[clip.mediaId];
  return (
    <div className="panel-body fx-panel">
      {media?.title && <TitleEditor key={media.id + media.title.text} mediaId={media.id} data={media.title} />}
      <TransitionControls clip={clip} seq={seq} />
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
          {clip.speed > 0 && media?.kind === 'video' && !media.synthetic && (
            <Group title="Zaman yeniden eşleme (hız rampası)">
              <ParamRow clip={clip} k="remap" label="Hız" local={local} step={1} unit="%" min={5} max={2000} />
              <div className="ramp-presets">
                {RAMP_PRESETS.map((r) => <button key={r.id} className="btn small" title={r.desc} onClick={() => edit(`Hız rampası: ${r.name}`, (s) => { const c = s.clips[clip.id]; c.remap = { value: 100, keyframes: r.keys.map(([t, v, e]) => ({ frame: Math.round(t * (c.duration - 1)), value: v, ease: e })) }; })}>{r.name}</button>)}
                {clip.remap && <button className="btn small ghost" onClick={() => edit('Hız rampasını kaldır', (s) => { delete s.clips[clip.id].remap; })}>Kaldır</button>}
              </div>
            </Group>
          )}
          <Group title="Opaklık">
            <ParamRow clip={clip} k="opacity" label="Opaklık" local={local} step={1} unit="%" min={0} max={100} />
            <div className="fx-row"><span /><span className="lbl">Karışım modu</span>
              <select className="mini" value={clip.blend ?? 'normal'} onChange={(e) => edit('Karışım modu', (s) => { const v = e.target.value as BlendMode; if (v === 'normal') delete s.clips[clip.id].blend; else s.clips[clip.id].blend = v; })}>
                {BLEND_MODES.map((b) => <option key={b.id} value={b.id}>{b.group ? `${b.name}` : b.name}</option>)}
              </select><span /></div>
            <MaskControls clip={clip} />
          </Group>
        </>
      )}
      <EffectStack clip={clip} />
      {clip.stream === 'video' && !(clip.effects ?? []).length && (
        <div style={{ padding: '6px 10px', color: 'var(--text-3)' }}>Efekt eklemek için <a href="#" onClick={(e) => { e.preventDefault(); useStore.setState({ leftTab: 'effects' }); }} style={{ color: 'var(--accent)' }}>Efektler</a> sekmesinden klibe sürükleyin.</div>
      )}
      {aclip && (
        <>
          {aclip !== clip && <div className="fx-sep">Ses · {aclip.name}</div>}
          {aclip !== clip && <TransitionControls clip={aclip} seq={seq} />}
          <Group title="Ses Seviyesi">
            <ParamRow clip={aclip} k="volume" label="Seviye" local={Math.max(0, Math.min(aclip.duration - 1, seq.playhead - aclip.start))} step={0.1} unit="dB" min={-60} max={24} />
          </Group>
          <AudioEffectStack clip={aclip} />
          {!(aclip.audioFx ?? []).length && (
            <div style={{ padding: '6px 10px', color: 'var(--text-3)' }}>Gürültü azaltma, konuşmayı netleştirme, EQ… <a href="#" onClick={(e) => { e.preventDefault(); useStore.setState({ leftTab: 'effects' }); }} style={{ color: 'var(--accent)' }}>Efektler › Ses efektleri</a>'nden ses klibine sürükleyin.</div>
          )}
        </>
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

function TitleEditor({ mediaId, data }: { mediaId: string; data: TitleData }) {
  const [text, setText] = useState(data.text);
  const set = (p: Partial<TitleData>) => void updateTitle(mediaId, p);
  const row = (label: string, el: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr', alignItems: 'center', gap: 6, padding: '3px 10px' }}><span className="lbl" style={{ color: 'var(--text-2)' }}>{label}</span>{el}</div>
  );
  return (
    <Group title="Metin">
      <div style={{ padding: '4px 10px' }}>
        <textarea value={text} rows={Math.min(5, Math.max(2, text.split('\n').length))} onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== data.text && set({ text })} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur(); }}
          style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--line-2)', borderRadius: 6, padding: 6, color: 'var(--text)', font: '13px var(--font)', resize: 'vertical' }} />
      </div>
      {row('Yazı tipi', <select className="mini" value={data.font} onChange={(e) => set({ font: e.target.value })}>{TITLE_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}</select>)}
      {row('Kalınlık', <select className="mini" value={data.weight} onChange={(e) => set({ weight: Number(e.target.value) as TitleData['weight'] })}>{[400, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{({ 400: 'Normal', 600: 'Yarı kalın', 700: 'Kalın', 800: 'Ekstra kalın', 900: 'Siyah' } as Record<number, string>)[w]}</option>)}</select>)}
      {row('Boyut', <HotNumber value={data.size} step={0.05} unit="%" onCommit={(v) => set({ size: Math.max(0.5, Math.min(40, v)) })} />)}
      {row('Renk', <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="color" value={data.color} onChange={(e) => set({ color: e.target.value })} />
        <label className="check"><input type="checkbox" checked={data.uppercase} onChange={(e) => set({ uppercase: e.target.checked })} /> BÜYÜK</label></span>)}
      {row('Hizalama', <span style={{ display: 'flex', gap: 2 }}>{(['left', 'center', 'right'] as const).map((a) => <button key={a} className={`btn small ${data.align === a ? 'primary' : ''}`} onClick={() => set({ align: a })}>{({ left: 'Sol', center: 'Orta', right: 'Sağ' })[a]}</button>)}</span>)}
      {row('Konum X / Y', <span style={{ display: 'flex', gap: 6 }}><HotNumber value={data.x} step={0.2} unit="%" onCommit={(v) => set({ x: v })} /><HotNumber value={data.y} step={0.2} unit="%" onCommit={(v) => set({ y: v })} /></span>)}
      {row('Kontur', <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="color" value={data.stroke} onChange={(e) => set({ stroke: e.target.value })} /><HotNumber value={data.strokeWidth} step={0.5} unit="%" onCommit={(v) => set({ strokeWidth: Math.max(0, Math.min(40, v)) })} /></span>)}
      {row('Arka plan', <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><label className="check"><input type="checkbox" checked={data.box} onChange={(e) => set({ box: e.target.checked })} /> Kutu</label>
        {data.box && <><input type="color" value={data.boxColor} onChange={(e) => set({ boxColor: e.target.value })} /><HotNumber value={Math.round(data.boxOpacity * 100)} step={1} unit="%" onCommit={(v) => set({ boxOpacity: Math.max(0, Math.min(100, v)) / 100 })} /></>}</span>)}
      {row('Gölge', <label className="check"><input type="checkbox" checked={data.shadow} onChange={(e) => set({ shadow: e.target.checked })} /> Yumuşak gölge</label>)}
    </Group>
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

const RAMP_PRESETS: { id: string; name: string; desc: string; keys: [number, number, KeyEase][] }[] = [
  { id: 'up', name: 'Hızlan', desc: 'Normal hızdan 4 kata yumuşakça çıkar', keys: [[0, 100, 'linear'], [0.35, 100, 'ease'], [0.7, 400, 'linear']] },
  { id: 'slow', name: 'Yavaş çekime geç', desc: 'Önemli anda %25 hıza iner', keys: [[0, 100, 'linear'], [0.4, 100, 'ease'], [0.55, 25, 'linear']] },
  { id: 'fsf', name: 'Hızlı–yavaş–hızlı', desc: 'Sosyal medyanın klasik hız rampası', keys: [[0, 300, 'linear'], [0.3, 300, 'ease'], [0.45, 30, 'linear'], [0.6, 30, 'ease'], [0.75, 300, 'linear']] },
  { id: 'hit', name: 'Darbe (vuruşta yavaşla)', desc: 'Hızlı gelir, ortada bir an yavaşlar', keys: [[0, 250, 'linear'], [0.42, 250, 'fast'], [0.5, 20, 'linear'], [0.58, 20, 'ease'], [0.7, 250, 'linear']] },
];
const REMAP_DEFAULT: AnimatableParam = Object.freeze({ value: 100, keyframes: [] }) as AnimatableParam;
function getParam(c: Clip, k: string): AnimatableParam {
  if (k === 'remap') {
    if (c.remap) return c.remap;
    if (Object.isFrozen(c)) return REMAP_DEFAULT; // reading committed state
    c.remap = { value: 100, keyframes: [] }; // inside an edit draft
    return c.remap;
  }
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
    <>
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
    {animated && <KeyLane clip={clip} k={k} local={local} />}
    </>
  );
}

/** keyframes of one property along the clip: drag to retime, right-click for interpolation */
function KeyLane({ clip, k, local }: { clip: Clip; k: string; local: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const p = getParam(clip, k);
  const D = Math.max(1, clip.duration - 1);
  const frameAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(D, Math.round(((clientX - r.left) / r.width) * D)));
  };
  const setEase = (frames: number[], ease: KeyEase) => edit('Ara değer', (s) => { for (const kf of getParam(s.clips[clip.id], k).keyframes) if (frames.includes(kf.frame)) kf.ease = ease; });
  const keyMenu = (e: React.MouseEvent, f: number) => {
    const kf = p.keyframes.find((x) => x.frame === f)!;
    openMenu(e, [
      ...KEY_EASES.map((x): MenuItem => ({ label: x.name, checked: kf.ease === x.id, action: () => setEase([f], x.id) })),
      { sep: true },
      { label: 'Tüm anahtar karelere uygula', submenu: KEY_EASES.map((x): MenuItem => ({ label: x.name, action: () => setEase(p.keyframes.map((y) => y.frame), x.id) })) },
      { sep: true },
      { label: 'Anahtar kareye git', action: () => setPlayhead(clip.start + f) },
      { label: 'Sil', danger: true, action: () => edit('Anahtar kareyi sil', (s) => { const pp = getParam(s.clips[clip.id], k); const i = pp.keyframes.findIndex((x) => x.frame === f); if (i >= 0) { if (pp.keyframes.length === 1) pp.value = pp.keyframes[0].value; pp.keyframes.splice(i, 1); } }) },
    ]);
  };
  const down = (e: React.MouseEvent, f: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const x0 = e.clientX;
    let moved = false, last = f;
    const mv = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      let nf = frameAt(ev.clientX);
      if (p.keyframes.some((x) => x.frame === nf && x.frame !== f)) nf = last; // never land on another key
      last = nf;
      previewEdit((s) => { const pp = getParam(s.clips[clip.id], k); const kf = pp.keyframes.find((x) => x.frame === f); if (kf) kf.frame = nf; pp.keyframes.sort((a, b) => a.frame - b.frame); });
    };
    const up = () => {
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
      if (moved) { commitPreview('Anahtar kareyi taşı'); setPlayhead(clip.start + last); } else setPlayhead(clip.start + f);
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  };
  return (
    <div className="key-lane" ref={ref} onMouseDown={(e) => { if (e.button === 0) setPlayhead(clip.start + frameAt(e.clientX)); }}>
      <div className="key-ph" style={{ left: `${(local / D) * 100}%` }} />
      {p.keyframes.map((kf, i) => {
        const next = p.keyframes[i + 1];
        return (
          <span key={kf.frame}>
            {next && <span className={`key-seg e-${kf.ease}`} style={{ left: `${(kf.frame / D) * 100}%`, width: `${((next.frame - kf.frame) / D) * 100}%` }} />}
            <span className={`key-dot e-${kf.ease} ${kf.frame === local ? 'on' : ''}`} style={{ left: `${(kf.frame / D) * 100}%` }}
              title={`${KEY_EASES.find((x) => x.id === kf.ease)?.name} · ${Math.round(kf.value * 100) / 100}\nSürükle: taşı · Sağ tık: ara değer`}
              onMouseDown={(e) => down(e, kf.frame)} onContextMenu={(e) => keyMenu(e, kf.frame)} />
          </span>
        );
      })}
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
  { id: 'type', icon: 'type', label: 'Yazı aracı (program monitörüne tıklayın)', key: 'T' },
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
