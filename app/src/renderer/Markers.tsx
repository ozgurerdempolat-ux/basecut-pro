// Markers panel: every marker of the sequence with colour, name, comment and
// duration; jump, edit, filter by colour, and copy as YouTube chapters.
import { useState } from 'react';
import { Marker, framesToTimecode } from '../core/model';
import { activeSeq, edit, setPlayhead, toast, useStore } from './store';
import { youtubeChapters } from '../core/markers';

export const MARKER_COLORS: Record<Marker['color'], string> = {
  green: '#4cc06a', red: '#e5534b', purple: '#9b4fc9', orange: '#f0a03c', yellow: '#e5cc4c', white: '#e8e8e8', blue: '#3c8fd6', cyan: '#2ac6c6',
};
const NAMES: Record<Marker['color'], string> = { green: 'Yeşil', red: 'Kırmızı', purple: 'Mor', orange: 'Turuncu', yellow: 'Sarı', white: 'Beyaz', blue: 'Mavi', cyan: 'Camgöbeği' };

export function MarkersPanel() {
  const seq = useStore((s) => activeSeq(s));
  const playhead = seq.playhead;
  const [filter, setFilter] = useState<Marker['color'] | null>(null);
  const list = [...seq.markers].sort((a, b) => a.frame - b.frame).filter((m) => !filter || m.color === filter);
  const set = (id: string, label: string, fn: (m: Marker) => void) => edit(label, (s) => { const m = s.markers.find((x) => x.id === id); if (m) fn(m); });
  if (!seq.markers.length) {
    return <div className="empty"><div className="big">İşaret yok</div><div>Oynatma kafasında <span className="kbd">M</span> ile işaret ekleyin. Buradan adlandırıp renk verebilir, YouTube bölümleri olarak kopyalayabilirsiniz.</div></div>;
  }
  return (
    <div className="panel-body markers">
      <div className="mk-bar">
        <span className={`mk-dot all ${!filter ? 'on' : ''}`} onClick={() => setFilter(null)} title="Tümü">∗</span>
        {(Object.keys(MARKER_COLORS) as Marker['color'][]).map((c) => <span key={c} className={`mk-dot ${filter === c ? 'on' : ''}`} style={{ background: MARKER_COLORS[c] }} title={NAMES[c]} onClick={() => setFilter(filter === c ? null : c)} />)}
        <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => { void navigator.clipboard.writeText(youtubeChapters(seq.markers, seq.fps)); toast('YouTube bölümleri panoya kopyalandı — açıklamaya yapıştırın', 'success'); }}>YouTube bölümleri</button>
      </div>
      {list.map((m) => {
        const cur = playhead >= m.frame && playhead < m.frame + Math.max(1, m.duration);
        return (
          <div key={m.id} className={`mk-row ${cur ? 'cur' : ''}`}>
            <span className="mk-color" style={{ background: MARKER_COLORS[m.color] }} title="Rengi değiştir"
              onClick={() => { const cs = Object.keys(MARKER_COLORS) as Marker['color'][]; set(m.id, 'İşaret rengi', (x) => { x.color = cs[(cs.indexOf(x.color) + 1) % cs.length]; }); }} />
            <span className="mk-tc" onClick={() => setPlayhead(m.frame)}>{framesToTimecode(m.frame, seq.fps)}</span>
            <Field className="mk-name" value={m.name} placeholder="Ad" onCommit={(v) => set(m.id, 'İşaret adı', (x) => { x.name = v; })} />
            <input className="mk-dur" value={m.duration ? (m.duration / seq.fps).toFixed(1) : ''} placeholder="süre" title="Süre (sn)"
              onChange={(e) => { const n = Number(e.target.value.replace(',', '.')); if (Number.isFinite(n)) set(m.id, 'İşaret süresi', (x) => { x.duration = Math.max(0, Math.round(n * seq.fps)); }); }} onKeyDown={(e) => e.stopPropagation()} />
            <button className="icon-btn" title="Sil" onClick={() => edit('İşareti sil', (s) => { s.markers = s.markers.filter((x) => x.id !== m.id); })}>✕</button>
            <Field className="mk-comment" value={m.comment} placeholder="Not…" multiline onCommit={(v) => set(m.id, 'İşaret notu', (x) => { x.comment = v; })} />
          </div>
        );
      })}
    </div>
  );
}

/** text field that writes one undo step when you leave it (or press Enter) */
function Field({ value, onCommit, className, placeholder, multiline }: { value: string; onCommit: (v: string) => void; className: string; placeholder: string; multiline?: boolean }) {
  const [v, setV] = useState<string | null>(null);
  const done = () => { if (v !== null && v !== value) onCommit(v); setV(null); };
  const common = {
    className, placeholder, value: v ?? value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: done,
    onKeyDown: (e: React.KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); (e.target as HTMLElement).blur(); } if (e.key === 'Escape') { setV(null); (e.target as HTMLElement).blur(); } },
  };
  return multiline ? <textarea rows={1} {...common} /> : <input {...common} />;
}
