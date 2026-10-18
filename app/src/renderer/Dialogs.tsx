import { useState } from 'react';
import { framesToTimecode, makeSequence } from '../core/model';
import * as ops from '../core/ops';
import { committedSeq, edit, editProject, loadProject, useStore } from './store';
import type { Project } from '../core/model';

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
  ['Ctrl+R', 'Hız / süre'], ['Ctrl+L', 'Bağla / bağlantıyı kaldır'], ['Shift+E', 'Klibi etkinleştir / devre dışı'],
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
