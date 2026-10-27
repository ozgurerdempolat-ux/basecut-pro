// Start screen: recent projects, new / open / import, update notice.
import { useEffect, useState } from 'react';
import { I } from './icons';
import { droppedPaths, importPaths, newProject, openProject, useStore } from './store';

type Recent = { path: string; name: string; openedAt: number; sequences: number; media: number };

export function Home() {
  const home = useStore((s) => s.home);
  const empty = useStore((s) => Object.keys(s.project.media).length === 0 && Object.values(s.project.sequences).every((q) => !Object.keys(q.clips).length));
  const sys = useStore((s) => s.sys);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [update, setUpdate] = useState<{ latest: string; url: string; newer: boolean } | null>(null);
  const [over, setOver] = useState(false);
  useEffect(() => { if (home) { void window.kurgu.recentProjects().then(setRecent); void window.kurgu.checkUpdate().then((u) => u && setUpdate(u)); } }, [home]);
  if (!home || !empty) return null;
  const close = () => useStore.setState({ home: false });
  const ago = (t: number) => { const d = (Date.now() - t) / 1000; return d < 3600 ? `${Math.max(1, Math.round(d / 60))} dk önce` : d < 86400 ? `${Math.round(d / 3600)} sa önce` : `${Math.round(d / 86400)} gün önce`; };
  return (
    <div className={`home ${over ? 'over' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
      onDrop={async (e) => { e.preventDefault(); setOver(false); const paths = droppedPaths(e.dataTransfer); if (paths.length) { close(); await importPaths(paths, { createSequence: true }); } }}>
      <div className="home-card">
        <div className="home-head">
          <div className="home-logo">{I.play}</div>
          <div><div className="home-title">BaseCut <span>PRO</span></div><div className="home-sub">Ücretsiz, hafif, profesyonel video kurgu {sys?.version ? `· ${sys.version}` : ''}</div></div>
        </div>
        {update?.newer && (
          <div className="home-update">Yeni sürüm hazır: <b>{update.latest}</b> <button className="btn small primary" onClick={() => void window.kurgu.openExternal(update.url)}>İndir</button></div>
        )}
        <div className="home-grid">
          <div className="home-actions">
            <button className="btn primary big" onClick={() => { newProject(); close(); }}>{I.plus} Yeni proje</button>
            <button className="btn big" onClick={() => void openProject()}>Proje aç…</button>
            <button className="btn big" onClick={async () => { const p = await window.kurgu.openFiles(); if (p.length) { close(); await importPaths(p, { createSequence: true }); } }}>{I.import} Video içe aktar</button>
            <div className="home-drop">ya da dosyaları bu pencereye sürükleyin</div>
          </div>
          <div className="home-recent">
            <div className="home-h">Son projeler</div>
            {recent.length === 0 && <div className="home-none">Henüz proje yok. Kaydettiğiniz projeler burada görünür.</div>}
            {recent.map((r) => (
              <div key={r.path} className="home-item" onClick={() => void openProject(r.path)} title={r.path}>
                <div className="home-item-name">{r.name}</div>
                <div className="home-item-meta">{ago(r.openedAt)} · {r.sequences} sekans · {r.media} medya</div>
                <div className="home-item-path">{r.path}</div>
                <button className="icon-btn" title="Listeden kaldır" onClick={(e) => { e.stopPropagation(); void window.kurgu.forgetRecent(r.path).then(() => setRecent(recent.filter((x) => x.path !== r.path))); }}>✕</button>
              </div>
            ))}
          </div>
        </div>
        <button className="home-skip" onClick={close}>Boş projeyle devam et →</button>
      </div>
    </div>
  );
}
