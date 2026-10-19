// Text-based editing panel: read the transcript, click a word to jump there,
// select words and delete them (the video is cut with them), remove long pauses
// and filler words in one go, search the conversation.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CaptionWord } from '../core/captions';
import { framesToTimecode } from '../core/model';
import { FILLERS, fillerRanges, paragraphs, pauseRanges, removeRanges, search, selectionRange } from '../core/transcript';
import { LANGUAGES, MODELS, autoCaption, defaultSpeechTracks } from './Captions';
import { player } from './player';
import { activeSeq, edit, setPlayhead, setSeqField, toast, useStore } from './store';

export function TranscriptPanel() {
  const seq = useStore((s) => activeSeq(s));
  const playhead = useStore((s) => activeSeq(s).playhead);
  const jobs = useStore((s) => s.jobs);
  const sys = useStore((s) => s.sys);
  const tr = seq.transcript;
  const words = tr?.words ?? [];
  const busy = Object.values(jobs).some((j) => j.kind === 'transcribe' && !j.done);
  const [lang, setLang] = useState(seq.captions?.language ?? 'tr');
  const [model, setModel] = useState(sys?.lowSpec ? MODELS[0].id : MODELS[1].id);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [q, setQ] = useState('');
  const [hit, setHit] = useState(0);
  const [pauseMin, setPauseMin] = useState(0.8);
  const [pauseKeep, setPauseKeep] = useState(0.15);
  const [tool, setTool] = useState<'none' | 'pause' | 'filler'>('none');
  const dragging = useRef<number | null>(null);
  const body = useRef<HTMLDivElement>(null);

  const paras = useMemo(() => paragraphs(words, seq.fps), [words, seq.fps]);
  const hits = useMemo(() => search(words, q), [words, q]);
  const qLen = q.trim().split(/\s+/).filter(Boolean).length;
  const current = words.findIndex((w) => playhead >= w.start && playhead < w.end);
  const pauses = useMemo(() => pauseRanges(words, seq.fps, pauseMin, pauseKeep), [words, seq.fps, pauseMin, pauseKeep]);
  const fillers = useMemo(() => fillerRanges(words, tr?.language ?? 'tr'), [words, tr?.language]);
  const secs = (r: [number, number][]) => (r.reduce((a, [x, y]) => a + (y - x), 0) / seq.fps).toFixed(1);

  useEffect(() => { setSel(null); }, [words]);
  // keep the current word in view while playing
  useEffect(() => {
    if (current < 0 || !body.current || !useStore.getState().playing) return;
    const el = body.current.querySelector(`[data-w="${current}"]`) as HTMLElement | null;
    if (el) { const r = el.getBoundingClientRect(), b = body.current.getBoundingClientRect(); if (r.top < b.top || r.bottom > b.bottom) el.scrollIntoView({ block: 'center' }); }
  }, [current]);
  useEffect(() => {
    if (!hits.length || !body.current) return;
    const el = body.current.querySelector(`[data-w="${hits[hit % hits.length]}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center' });
  }, [hit, hits]);

  const cut = (ranges: [number, number][], label: string) => {
    if (!ranges.length) return;
    player.pause();
    let removed = 0;
    edit(label, (s) => { removed = removeRanges(s, ranges); });
    toast(`${(removed / seq.fps).toFixed(1)} sn çıkarıldı`, 'success');
    setTool('none');
  };
  const delSel = () => { if (sel) cut([selectionRange(words, sel[0], sel[1])], 'Metinden sil'); };

  if (!tr || !words.length) {
    const chosen = defaultSpeechTracks(seq);
    return (
      <div className="panel-body" style={{ padding: 12, display: 'grid', gap: 12, alignContent: 'start' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Metinle kurgu</div>
          <div style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>Konuşmayı yazıya dökün, sonra videoyu bir belge gibi düzenleyin: kelimeleri seçip silin, duraklamaları ve "ııı / eee" gibi dolgu seslerini tek tıkla temizleyin. Bu bilgisayarda, internetsiz çalışır.</div>
        </div>
        <div className="field"><label>Dil</label>
          <select value={lang} onChange={(e) => setLang(e.target.value)}>{LANGUAGES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label>Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>{MODELS.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.size}</option>)}</select></div>
        <button className="btn primary" disabled={busy || !chosen.length} onClick={() => void autoCaption({ model, language: lang, trackIds: chosen, captions: false })}>{busy ? 'Yazıya dökülüyor…' : 'Transkript oluştur'}</button>
        {seq.captions?.items.some((c) => c.words.length) && (
          <button className="btn" onClick={() => edit('Altyazıdan transkript', (s) => { s.transcript = { language: s.captions!.language === 'auto' ? 'tr' : s.captions!.language, words: s.captions!.items.flatMap((c) => c.words.map((w) => ({ ...w }))) }; })}>Mevcut altyazıdan al</button>
        )}
      </div>
    );
  }

  const inSel = (i: number) => sel && i >= Math.min(sel[0], sel[1]) && i <= Math.max(sel[0], sel[1]);
  const hitSet = new Set<number>();
  for (const h of hits) for (let k = 0; k < qLen; k++) hitSet.add(h + k);
  const fillerSet = new Set<number>();
  if (tool === 'filler') words.forEach((w, i) => { if (fillers.some(([a, b]) => w.start >= a && w.end <= b + 1)) fillerSet.add(i); });

  return (
    <div className="panel-body transcript" tabIndex={0} data-keys="local"
      onKeyDown={(e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); e.stopPropagation(); delSel(); }
        if (e.key === 'Escape') { e.stopPropagation(); setSel(null); }
      }}>
      <div className="tr-bar">
        <input className="search" placeholder="Konuşmada ara…" value={q} onChange={(e) => { setQ(e.target.value); setHit(0); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && hits.length) { const n = (hit + 1) % hits.length; setHit(n); setPlayhead(words[hits[n]].start); } }} />
        {q && <span className="pill">{hits.length ? `${(hit % hits.length) + 1}/${hits.length}` : '0'}</span>}
        <button className={`btn small ${tool === 'pause' ? 'on' : ''}`} onClick={() => setTool(tool === 'pause' ? 'none' : 'pause')}>Duraklamalar</button>
        <button className={`btn small ${tool === 'filler' ? 'on' : ''}`} onClick={() => setTool(tool === 'filler' ? 'none' : 'filler')}>Dolgu sesleri</button>
      </div>
      {tool === 'pause' && (
        <div className="tr-tool">
          <div className="mix-grid">
            <span>En az</span><span className="mix-row"><input type="range" min={0.3} max={3} step={0.1} value={pauseMin} onChange={(e) => setPauseMin(Number(e.target.value))} /><b>{pauseMin.toFixed(1)} sn</b></span>
            <span>Nefes payı</span><span className="mix-row"><input type="range" min={0} max={0.5} step={0.05} value={pauseKeep} onChange={(e) => setPauseKeep(Number(e.target.value))} /><b>{pauseKeep.toFixed(2)} sn</b></span>
          </div>
          <div className="tr-tool-foot"><span>{pauses.length} duraklama · {secs(pauses)} sn kısalır</span><button className="btn small primary" disabled={!pauses.length} onClick={() => cut(pauses, 'Duraklamaları kaldır')}>Kaldır</button></div>
        </div>
      )}
      {tool === 'filler' && (
        <div className="tr-tool">
          <div style={{ color: 'var(--text-2)' }}>Aranan: {(FILLERS[tr.language] ?? FILLERS.tr).slice(0, 10).join(', ')}… (metinde sarı)</div>
          <div className="tr-tool-foot"><span>{fillers.length} dolgu sesi · {secs(fillers)} sn</span><button className="btn small primary" disabled={!fillers.length} onClick={() => cut(fillers, 'Dolgu seslerini kaldır')}>Kaldır</button></div>
        </div>
      )}
      {sel && (
        <div className="tr-sel">
          <span>{Math.abs(sel[1] - sel[0]) + 1} kelime seçili</span>
          <button className="btn small primary" onClick={delSel} title="Delete">Sil (videodan da)</button>
          <button className="btn small" onClick={() => { const [a, b] = selectionRange(words, sel[0], sel[1]); setSeqField('inPoint', a); setSeqField('outPoint', b); }}>Giriş/çıkış işaretle</button>
          <button className="btn small ghost" onClick={() => setSel(null)}>✕</button>
        </div>
      )}
      <div className="tr-body" ref={body} onMouseUp={() => { dragging.current = null; }}>
        {paras.map((p, k) => (
          <div key={k} className="tr-para">
            <div className="tr-tc" onClick={() => setPlayhead(p.start)}>{framesToTimecode(p.start, seq.fps)}</div>
            <div className="tr-text">
              {p.words.map(({ w, i }) => (
                <span key={i} data-w={i} className={`tr-w ${i === current ? 'cur' : ''} ${inSel(i) ? 'sel' : ''} ${hitSet.has(i) ? 'hit' : ''} ${fillerSet.has(i) ? 'filler' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); (e.currentTarget.closest('.transcript') as HTMLElement | null)?.focus(); if (e.shiftKey && sel) setSel([sel[0], i]); else { dragging.current = i; setSel([i, i]); } }}
                  onMouseEnter={() => { if (dragging.current !== null) setSel([dragging.current, i]); }}
                  onClick={(e) => { if (!e.shiftKey && sel && sel[0] === sel[1]) { setPlayhead(w.start); } }}
                  title={framesToTimecode(w.start, seq.fps)}>{wordText(w)} </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const wordText = (w: CaptionWord) => w.text.trim();
