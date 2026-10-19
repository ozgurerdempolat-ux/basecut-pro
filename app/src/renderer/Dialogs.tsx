import { useState } from 'react';
import { framesToTimecode, makeSequence } from '../core/model';
import * as ops from '../core/ops';
import { committedSeq, edit, editProject, loadProject, useStore } from './store';
import type { Clip, Project } from '../core/model';
import { REFRAME_PRESETS } from '../core/reframe';
import { reframeSequence } from './reframe';
import { createMulticam } from './multicam';

export function Modal({ title, children, onClose, footer }: { title: string; children: React.ReactNode; onClose: () => void; footer?: React.ReactNode }) {
  return (
    <div className="modal-bg" onMouseDown={onClose} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="body">{children}</div>
        {footer && <div className="foot">{footer}</div>}
      </div>
    </div>
  );
}

const close = () => useStore.setState({ dialog: null });

export function Dialogs() {
  const d = useStore((s) => s.dialog);
  if (!d) return null;
  if (d.kind === 'speed') return <SpeedDialog />;
  if (d.kind === 'sequence') return <SequenceDialog />;
  if (d.kind === 'shortcuts') return <ShortcutsDialog />;
  if (d.kind === 'about') return <AboutDialog />;
  if (d.kind === 'reframe') return <ReframeDialog />;
  if (d.kind === 'multicam') return <MulticamDialog />;
  if (d.kind === 'attributes') return <AttributesDialog mode={d.data === 'remove' ? 'remove' : 'paste'} />;
  if (d.kind === 'recovery') return <RecoveryDialog data={d.data as { project: Project; savedAt: number }} />;
  return null;
}

function SpeedDialog() {
  const seq = committedSeq();
  const st = useStore.getState();
  const clip = st.selection.map((id) => seq.clips[id]).find(Boolean);
  const [pct, setPct] = useState(clip ? Math.round(Math.abs(clip.speed) * 10000) / 100 : 100);
  const [reverse, setReverse] = useState(clip ? clip.speed < 0 : false);
  const [ripple, setRipple] = useState(true);
  if (!clip) return <Modal title="Hız / Süre" onClose={close} footer={<button className="btn" onClick={close}>Tamam</button>}>Önce timeline'da bir klip seçin.</Modal>;
  const srcSpan = (clip.duration / seq.fps) * Math.abs(clip.speed);
  const newDur = Math.max(1, Math.round((srcSpan / (pct / 100)) * seq.fps));
  const apply = () => {
    edit('Hız/Süre', (s) => ops.setSpeed(s, clip.id, (pct / 100) * (reverse ? -1 : 1), ripple));
    close();
  };
  return (
    <Modal title="Klip Hızı / Süresi" onClose={close} footer={<><button className="btn" onClick={close}>İptal</button><button className="btn primary" onClick={apply}>Uygula</button></>}>
      <div className="field"><label>Hız (%)</label><input type="number" autoFocus value={pct} min={1} max={10000} onChange={(e) => setPct(Math.max(1, Number(e.target.value)))} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') apply(); }} /></div>
      <div className="field"><label>Süre</label><span style={{ fontFamily: 'var(--mono)' }}>{framesToTimecode(newDur, seq.fps)}</span></div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[25, 50, 75, 100, 150, 200, 400].map((p) => <button key={p} className="btn small" onClick={() => setPct(p)}>%{p}</button>)}
      </div>
      <label className="check"><input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} /> Ters oynat</label>
      <label className="check"><input type="checkbox" checked={ripple} onChange={(e) => setRipple(e.target.checked)} /> Sonraki klipleri kaydır (ripple)</label>
      <div style={{ color: 'var(--text-3)' }}>Ses perdesi korunur.</div>
    </Modal>
  );
}

const SEQ_PRESETS = [
  { group: 'Yatay', name: '1080p Full HD', width: 1920, height: 1080 },
  { group: 'Yatay', name: '4K UHD', width: 3840, height: 2160 },
  { group: 'Yatay', name: '720p HD', width: 1280, height: 720 },
  { group: 'Sosyal', name: 'Dikey 9:16 (Reels, TikTok, Shorts)', width: 1080, height: 1920 },
  { group: 'Sosyal', name: 'Kare 1:1', width: 1080, height: 1080 },
  { group: 'Sosyal', name: 'Dikey 4:5 (Instagram akış)', width: 1080, height: 1350 },
  { group: 'Sinema', name: 'DCI 2K', width: 2048, height: 1080 },
  { group: 'Sinema', name: 'DCI 4K', width: 4096, height: 2160 },
];

function SequenceDialog() {
  const count = useStore((s) => Object.keys(s.project.sequences).length);
  const [name, setName] = useState(`Sekans ${String(count + 1).padStart(2, '0')}`);
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [fps, setFps] = useState(30);
  const create = () => {
    editProject('Yeni sekans', (p) => {
      const s = makeSequence({ name, width: w, height: h, fps });
      p.sequences[s.id] = s;
      p.activeSequenceId = s.id;
    });
    useStore.setState({ selection: [] });
    close();
  };
  return (
    <Modal title="Yeni Sekans" onClose={close} footer={<><button className="btn" onClick={close}>İptal</button><button className="btn primary" onClick={create}>Oluştur</button></>}>
      <div className="field"><label>Ad</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
        {SEQ_PRESETS.map((p) => (
          <button key={p.name} className={`preset ${w === p.width && h === p.height ? 'on' : ''}`} onClick={() => { setW(p.width); setH(p.height); }}>
            <div style={{ fontWeight: 600 }}>{p.name}</div><div style={{ color: 'var(--text-3)' }}>{p.width}×{p.height} · {p.group}</div>
          </button>
        ))}
      </div>
      <div className="field"><label>Çerçeve boyutu</label><span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="number" value={w} style={{ width: 90 }} onChange={(e) => setW(Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()} />×
        <input type="number" value={h} style={{ width: 90 }} onChange={(e) => setH(Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()} /></span></div>
      <div className="field"><label>Kare hızı</label>
        <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
          {[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
        </select></div>
    </Modal>
  );
}

export const SHORTCUTS: [string, string][] = [
  ['Boşluk', 'Oynat / durdur'], ['J / K / L', 'Geri / dur / ileri (tekrar basınca hızlanır)'],
  ['← / →', '1 kare geri / ileri'], ['Shift + ← / →', '5 kare geri / ileri'],
  ['↑ / ↓', 'Önceki / sonraki kesim noktası'], ['Home / End', 'Başa / sona'],
  ['I / O', 'Giriş / çıkış işaretle'], ['Shift + I / O', 'Girişe / çıkışa git'], ['Ctrl+Shift+X', 'Giriş ve çıkışı temizle'],
  [', / .', 'Kaynağı ekle / üzerine yaz'], ['; / \'', 'Kaldır / ayıkla'],
  ['V', 'Seçim aracı'], ['A', 'İleri iz seçimi'], ['B', 'Dalgalı düzenleme (ripple)'], ['N', 'Kaydırarak düzenleme (rolling)'],
  ['R', 'Hız esnetme'], ['C', 'Jilet'], ['Y', 'Slip'], ['U', 'Slide'], ['H', 'El'], ['Z', 'Yakınlaştırma'],
  ['Ctrl+K', 'Oynatma kafasında kes'], ['Ctrl+Shift+K', 'Tüm izlerde kes'],
  ['Q / W', 'Önceki / sonraki kesimi oynatma kafasına dalgalı kırp'],
  ['Delete', 'Sil'], ['Shift+Delete', 'Dalgalı sil'], ['Alt + ← / →', 'Klibi 1 kare it'],
  ['Ctrl+D', 'Çapraz geçiş ekle'], ['Ctrl+R', 'Hız / süre'], ['Ctrl+L', 'Bağla / bağlantıyı kaldır'], ['Shift+E', 'Klibi etkinleştir / devre dışı'],
  ['M', 'Marker ekle'], ['Shift+M', 'Sonraki markere git'], ['S', 'Yapıştırma (snap) aç/kapat'],
  ['= / -', 'Timeline yakınlaştır / uzaklaştır'], ['\\', 'Sekansı sığdır'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Geri al / yinele'], ['Ctrl+C / X / V', 'Kopyala / kes / yapıştır'],
  ['Ctrl+S', 'Kaydet'], ['Ctrl+I', 'İçe aktar'], ['Ctrl+M', 'Dışa aktar'], ['Ctrl+N', 'Yeni sekans'],
  ['Ctrl + sürükle', 'Ekleyerek taşı (ripple insert)'], ['Alt + sürükle', 'Bağlı klipten bağımsız taşı/kırp'], ['Ctrl + kenar sürükle', 'Dalgalı kırp'],
  ['Alt + tekerlek', 'Timeline yakınlaştır'],
];

function ShortcutsDialog() {
  return (
    <Modal title="Klavye Kısayolları" onClose={close} footer={<button className="btn primary" onClick={close}>Kapat</button>}>
      <div style={{ color: 'var(--text-3)' }}>Profesyonel kurgu yazılımlarında alışık olduğunuz kısayollar.</div>
      <div className="shortcut-grid">
        {SHORTCUTS.map(([k, v]) => <div key={k}><span>{v}</span><span className="kbd">{k}</span></div>)}
      </div>
    </Modal>
  );
}

function AboutDialog() {
  return (
    <Modal title="BaseCut Pro hakkında" onClose={close} footer={<button className="btn primary" onClick={close}>Kapat</button>}>
      <div><b>BaseCut Pro</b> 0.1 — ücretsiz, hafif, profesyonel video kurgu. Özgür yazılım (GPL-3.0).</div>
      <div style={{ color: 'var(--text-2)' }}>The Base Social tarafından geliştirilmektedir. Video işleme FFmpeg (LGPL/GPL) ile yapılır.</div>
    </Modal>
  );
}

function RecoveryDialog({ data }: { data: { project: Project; savedAt: number } }) {
  const when = new Date(data.savedAt).toLocaleString('tr-TR');
  return (
    <Modal title="Kaydedilmemiş çalışma bulundu" onClose={close}
      footer={<>
        <button className="btn" onClick={() => { void window.kurgu.clearRecovery(); close(); }}>Yoksay</button>
        <button className="btn primary" onClick={() => { loadProject(data.project, null); useStore.setState({ dirty: true }); close(); }}>Geri yükle</button>
      </>}>
      <div>BaseCut Pro son oturumda düzgün kapanmadı. <b>{data.project.name}</b> projesinin {when} tarihli hali her düzenlemede diske yazılmıştı.</div>
      <div style={{ color: 'var(--text-2)' }}>Kaldığınız yerden, son yaptığınız düzenlemeye kadar devam edebilirsiniz.</div>
    </Modal>
  );
}

// ------------------------------------------------------------------ paste / remove attributes

const ATTRS = [
  { id: 'motion', label: 'Hareket (konum, ölçek, döndürme)' },
  { id: 'opacity', label: 'Opaklık' },
  { id: 'effects', label: 'Video efektleri' },
  { id: 'color', label: 'Renk düzeltme' },
  { id: 'volume', label: 'Ses seviyesi' },
  { id: 'audioFx', label: 'Ses efektleri' },
  { id: 'speed', label: 'Hız' },
] as const;
type AttrId = (typeof ATTRS)[number]['id'];

export function applyAttributes(mode: 'paste' | 'remove', on: Set<AttrId>, scaleKeys: boolean) {
  const st = useStore.getState();
  const src = mode === 'paste' ? st.clipboard?.[0] : null;
  if (mode === 'paste' && !src) return;
  const ids = st.selection;
  const json = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  edit(mode === 'paste' ? 'Özellikleri yapıştır' : 'Özellikleri kaldır', (s) => {
    for (const id of ids) {
      const c = s.clips[id];
      if (!c) continue;
      const k = src && scaleKeys && src.duration > 0 ? c.duration / src.duration : 1;
      const scaled = (p: Clip['transform']['posX']) => { const q = json(p); for (const kf of q.keyframes) kf.frame = Math.round(kf.frame * k); return q; };
      if (on.has('motion') && c.stream === 'video') {
        for (const key of ['posX', 'posY', 'scale', 'rotation'] as const) {
          if (src) c.transform[key] = scaled(src.transform[key]);
          else c.transform[key] = { value: key === 'scale' ? 100 : 0, keyframes: [] };
        }
      }
      if (on.has('opacity') && c.stream === 'video') c.transform.opacity = src ? scaled(src.transform.opacity) : { value: 100, keyframes: [] };
      if (on.has('opacity') && c.stream === 'video') { if (src?.blend) c.blend = src.blend; else delete c.blend; }
      if (on.has('opacity') && c.stream === 'video') { if (src?.masks?.length) { c.masks = json(src.masks); delete c.maskImage; } else if (!src) { delete c.masks; delete c.maskImage; } }
      if (on.has('effects') && c.stream === 'video') { if (src?.effects?.length) c.effects = json(src.effects).map((e) => ({ ...e, id: `fx_${Math.random().toString(36).slice(2, 9)}` })); else if (!src) delete c.effects; }
      if (on.has('color') && c.stream === 'video') { if (src?.color) c.color = json(src.color); else if (!src) delete c.color; }
      if (on.has('volume') && c.stream === 'audio') c.volumeDb = src ? scaled(src.volumeDb) : { value: 0, keyframes: [] };
      if (on.has('audioFx') && c.stream === 'audio') { if (src?.audioFx?.length) c.audioFx = json(src.audioFx).map((e) => ({ ...e, id: `afx_${Math.random().toString(36).slice(2, 9)}` })); else if (!src) delete c.audioFx; }
      if (on.has('speed') && src && Math.abs(src.speed) > 0) c.speed = src.speed;
    }
  });
}

function AttributesDialog({ mode }: { mode: 'paste' | 'remove' }) {
  const [on, setOn] = useState<Set<AttrId>>(new Set(['motion', 'opacity', 'effects', 'color', 'volume', 'audioFx']));
  const [scaleKeys, setScaleKeys] = useState(true);
  const st = useStore.getState();
  const n = st.selection.length;
  const src = st.clipboard?.[0];
  const go = () => { applyAttributes(mode, on, scaleKeys); close(); };
  return (
    <Modal title={mode === 'paste' ? 'Özellikleri Yapıştır' : 'Özellikleri Kaldır'} onClose={close}
      footer={<><button className="btn" onClick={close}>Vazgeç</button><button className="btn primary" disabled={!n || !on.size} onClick={go}>{mode === 'paste' ? 'Yapıştır' : 'Kaldır'}</button></>}>
      <div style={{ marginBottom: 8, color: 'var(--text-2)' }}>
        {mode === 'paste' ? <>Kaynak: <b>{src?.name ?? '—'}</b> → {n} seçili klip</> : <>{n} seçili klipten kaldırılacaklar:</>}
      </div>
      {ATTRS.map((a) => (
        <label key={a.id} className="check" style={{ display: 'flex', margin: '5px 0' }}>
          <input type="checkbox" checked={on.has(a.id)} onChange={(e) => { const x = new Set(on); if (e.target.checked) x.add(a.id); else x.delete(a.id); setOn(x); }} /> {a.label}
        </label>
      ))}
      {mode === 'paste' && <label className="check" style={{ display: 'flex', marginTop: 10, color: 'var(--text-2)' }}><input type="checkbox" checked={scaleKeys} onChange={(e) => setScaleKeys(e.target.checked)} /> Anahtar kare zamanlamasını klip süresine göre ölçekle</label>}
    </Modal>
  );
}

// ------------------------------------------------------------------ auto reframe

function ReframeDialog() {
  const [preset, setPreset] = useState('9:16');
  const [speed, setSpeed] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const seq = committedSeq();
  const go = async () => {
    setBusy(true);
    try { await reframeSequence(preset, speed); close(); } finally { setBusy(false); }
  };
  return (
    <Modal title="Otomatik Yeniden Kadrajla" onClose={() => !busy && close()}
      footer={<><button className="btn" disabled={busy} onClick={close}>Vazgeç</button><button className="btn primary" disabled={busy} onClick={() => void go()}>{busy ? 'Analiz ediliyor…' : 'Yeni sekans oluştur'}</button></>}>
      <div style={{ color: 'var(--text-2)', marginBottom: 10, lineHeight: 1.5 }}>
        "{seq.name}" sekansının yeni en-boy oranında bir kopyası oluşturulur. Her çekimde konu (insanlar, hareket, detay) bulunur ve kadraj onu yumuşakça takip eder. Orijinal sekans değişmez.
      </div>
      {REFRAME_PRESETS.map((p) => (
        <label key={p.id} className="check" style={{ display: 'flex', margin: '6px 0' }}>
          <input type="radio" name="rf" checked={preset === p.id} onChange={() => setPreset(p.id)} /> {p.name}
        </label>
      ))}
      <div className="field" style={{ marginTop: 10 }}><label>Hareket takibi</label>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          <option value={0.15}>Yavaş (röportaj, konuşma)</option>
          <option value={0.5}>Varsayılan</option>
          <option value={0.9}>Hızlı (spor, aksiyon)</option>
        </select></div>
    </Modal>
  );
}

// ------------------------------------------------------------------ multicam

function MulticamDialog() {
  const st = useStore.getState();
  const items = st.selectedMedia.map((id) => st.project.media[id]).filter(Boolean);
  const [sync, setSync] = useState<'audio' | 'in' | 'start'>('audio');
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await createMulticam(items.map((m) => m.id), sync); close(); } finally { setBusy(false); } };
  return (
    <Modal title="Çoklu Kamera Kaynak Sekansı" onClose={() => !busy && close()}
      footer={<><button className="btn" disabled={busy} onClick={close}>Vazgeç</button><button className="btn primary" disabled={busy || items.length < 2} onClick={() => void go()}>{busy ? 'Senkronlanıyor…' : 'Oluştur'}</button></>}>
      <div style={{ marginBottom: 8, color: 'var(--text-2)' }}>{items.length} kamera: {items.map((m) => m.name).join(', ')}</div>
      {([['audio', 'Ses dalga formuna göre (önerilen) — kameralar aynı anda farklı zamanlarda başlatıldıysa'], ['in', 'Giriş noktalarına göre — her kaynakta aynı anı Giriş (I) ile işaretlediyseniz'], ['start', 'Başlangıçlarına göre — hepsi aynı anda kaydetmeye başladıysa']] as const).map(([id, label]) => (
        <label key={id} className="check" style={{ display: 'flex', margin: '6px 0', alignItems: 'flex-start' }}>
          <input type="radio" name="mcs" checked={sync === id} onChange={() => setSync(id)} /> {label}
        </label>
      ))}
      <div style={{ marginTop: 10, color: 'var(--text-3)', lineHeight: 1.5 }}>Sonra oynatırken 1–9 tuşlarıyla kameralar arasında kesme yaparsınız. Program monitöründeki ızgara görünümüne tıklayarak da seçebilirsiniz.</div>
    </Modal>
  );
}
