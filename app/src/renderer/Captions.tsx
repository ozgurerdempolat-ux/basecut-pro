import { useMemo, useState } from 'react';
import {
  Caption, CaptionStyle, CaptionWord, PRESET_NAMES, captionAt, distributeWords, emptyCaptions, fitted, groupWords,
  parseSubtitles, presetStyle, toASS, toSRT, toVTT, wrapWords, activeWordIndex,
} from '../core/captions';
import { Sequence, framesToTimecode } from '../core/model';
import { I } from './icons';
import { activeSeq, committedSeq, edit, setPlayhead, toast, useStore } from './store';

export const LANGUAGES: [string, string][] = [
  ['tr', 'Türkçe'], ['en', 'İngilizce'], ['de', 'Almanca'], ['fr', 'Fransızca'], ['es', 'İspanyolca'], ['it', 'İtalyanca'],
  ['ar', 'Arapça'], ['ru', 'Rusça'], ['az', 'Azerbaycanca'], ['ku', 'Kürtçe'], ['fa', 'Farsça'], ['nl', 'Felemenkçe'],
  ['pt', 'Portekizce'], ['ja', 'Japonca'], ['ko', 'Korece'], ['zh', 'Çince'], ['auto', 'Otomatik algıla'],
];

export const MODELS: { id: string; name: string; size: string; note: string }[] = [
  { id: 'onnx-community/whisper-base_timestamped', name: 'Hızlı', size: '~150 MB', note: 'Zayıf bilgisayarlar için' },
  { id: 'onnx-community/whisper-small_timestamped', name: 'Dengeli', size: '~500 MB', note: 'Önerilen — Türkçede iyi' },
  { id: 'onnx-community/whisper-large-v3-turbo_timestamped', name: 'En iyi', size: '~1 GB', note: 'Güçlü bilgisayar, en doğru sonuç' },
];

// ------------------------------------------------------------------ automatic captions

let worker: Worker | null = null;

function parseWav(buf: ArrayBuffer): Float32Array {
  const v = new DataView(buf);
  let p = 12;
  let fmtBits = 16;
  while (p < v.byteLength - 8) {
    const id = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    const size = v.getUint32(p + 4, true);
    if (id === 'fmt ') fmtBits = v.getUint16(p + 22, true);
    if (id === 'data') {
      const start = p + 8;
      const end = Math.min(v.byteLength, start + size);
      if (fmtBits !== 16) throw new Error('Beklenmeyen ses biçimi');
      const n = Math.floor((end - start) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(start + i * 2, true) / 32768;
      return out;
    }
    p += 8 + size + (size % 2);
  }
  throw new Error('WAV verisi bulunamadı');
}

function setJob(id: string, label: string, progress: number, done = false, error?: string) {
  useStore.setState((s) => ({ jobs: { ...s.jobs, [id]: { jobId: id, kind: 'transcribe', label, progress, done, error } } }));
  if (done) setTimeout(() => useStore.setState((s) => { const n = { ...s.jobs }; delete n[id]; return { jobs: n }; }), 3000);
}

export async function autoCaption(opts: { model: string; language: string; trackIds: string[] }) {
  const st = useStore.getState();
  const seq = committedSeq(st);
  if (!opts.trackIds.length) { toast('Altyazı için en az bir ses izi seçin', 'error'); return; }
  const jobId = `asr-${Date.now()}`;
  setJob(jobId, 'Altyazı: ses hazırlanıyor', 0.02);
  try {
    const wavPath = await window.kurgu.speechAudio({ project: st.project, sequenceId: seq.id, trackIds: opts.trackIds });
    const buf = await (await fetch(window.kurgu.mediaUrl(wavPath))).arrayBuffer();
    const audio = parseWav(buf);
    const device: 'webgpu' | 'wasm' = 'gpu' in navigator ? 'webgpu' : 'wasm';
    if (!worker) worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' });
    setJob(jobId, 'Altyazı: model yükleniyor', 0.05);
    const words = await new Promise<{ text: string; start: number; end: number }[]>((resolve, reject) => {
      worker!.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'download') setJob(jobId, `Altyazı modeli indiriliyor (ilk kez) ${m.total ? `${Math.round(m.loaded / 1e6)}/${Math.round(m.total / 1e6)} MB` : ''}`, m.total ? 0.05 + 0.25 * (m.loaded / m.total) : 0.1);
        if (m.type === 'ready') setJob(jobId, `Konuşma tanınıyor (${m.device === 'webgpu' ? 'GPU' : 'işlemci'})`, 0.3);
        if (m.type === 'info') toast(m.text);
        if (m.type === 'progress') setJob(jobId, 'Konuşma tanınıyor', 0.3 + 0.7 * m.value);
        if (m.type === 'done') resolve(m.words);
        if (m.type === 'error') reject(new Error(m.message));
      };
      worker!.onerror = (e) => reject(new Error(e.message || 'Tanıma motoru başlatılamadı'));
      worker!.postMessage({ type: 'run', audio, model: opts.model, language: opts.language, device }, [audio.buffer]);
    });
    if (!words.length) { setJob(jobId, 'Altyazı', 1, true, 'Konuşma bulunamadı'); toast('Seçili izlerde konuşma bulunamadı', 'error'); return; }
    const fps = seq.fps;
    const frameWords: CaptionWord[] = words.map((w) => ({ text: w.text, start: Math.round(w.start * fps), end: Math.max(Math.round(w.end * fps), Math.round(w.start * fps) + 1) }));
    edit('Otomatik altyazı', (s) => {
      const track = s.captions ?? emptyCaptions(opts.language === 'auto' ? 'tr' : opts.language);
      track.language = opts.language;
      track.items = groupWords(frameWords, fitted(track.style, s.width, s.height), fps);
      track.enabled = true;
      s.captions = track;
    });
    setJob(jobId, 'Altyazı hazır', 1, true);
    toast(`${words.length} kelime tanındı, altyazı oluşturuldu`, 'success');
  } catch (e) {
    const msg = (e as Error).message;
    const net = /fetch|network|Failed to|ENOTFOUND|NetworkError|404|403/i.test(msg);
    setJob(jobId, 'Altyazı', 0, true, msg);
    toast(net ? 'Altyazı modeli indirilemedi. İlk kullanımda internet bağlantısı gerekir; sonrasında çevrimdışı çalışır.' : `Altyazı oluşturulamadı: ${msg}`, 'error');
  }
}

/** default tracks for recognition: the ones holding camera/voice audio, not music files */
export function defaultSpeechTracks(seq: Sequence): string[] {
  const media = useStore.getState().project.media;
  const ids = seq.tracks.filter((t) => t.kind === 'audio' && Object.values(seq.clips).some((c) => c.trackId === t.id && media[c.mediaId]?.kind === 'video'));
  if (ids.length) return ids.map((t) => t.id);
  return seq.tracks.filter((t) => t.kind === 'audio' && Object.values(seq.clips).some((c) => c.trackId === t.id)).map((t) => t.id);
}

/** write the ASS file the export burns in */
export async function prepareBurn(seq: Sequence, rangeStart: number): Promise<{ ass: string; fonts: string } | null> {
  const cap = seq.captions;
  if (!cap || !cap.enabled || !cap.items.length) return null;
  const ass = toASS(cap.items, cap.style, seq.width, seq.height, seq.fps, rangeStart);
  const path = await window.kurgu.writeTemp(`captions-${seq.id}.ass`, ass);
  return { ass: path, fonts: await window.kurgu.fontsDir() };
}

// ------------------------------------------------------------------ preview drawing

export function drawCaptions(ctx: CanvasRenderingContext2D, seq: Sequence, frame: number, W: number, H: number) {
  const cap = seq.captions;
  if (!cap || !cap.enabled || !cap.items.length) return;
  const c = captionAt(cap.items, frame);
  if (!c) return;
  const style = fitted(cap.style, seq.width, seq.height);
  const size = (style.size / 100) * H;
  const lines = wrapWords(c, style.maxChars, style.maxLines);
  const active = activeWordIndex(c, frame);
  const up = (t: string) => (style.uppercase ? t.toLocaleUpperCase('tr-TR') : t);
  ctx.save();
  ctx.font = `${style.bold ? 700 : 400} ${size}px Montserrat, system-ui, sans-serif`; // same weights libass picks for the export
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const lineH = size * 1.18;
  const blockH = lines.length * lineH;
  const margin = (style.margin / 100) * H;
  let y0 = style.position === 'bottom' ? H - margin - blockH : style.position === 'top' ? margin : (H - blockH) / 2;
  // pop / word entrance scale
  const age = frame - c.start;
  let scale = 1;
  if (style.animation === 'word') scale = age < 3 ? 0.7 + age * 0.14 : age < 6 ? 1.12 - (age - 3) * 0.04 : 1;
  if (style.animation === 'pop') scale = age < 4 ? 0.92 + age * 0.02 : 1;
  ctx.globalAlpha = style.animation === 'pop' && age < 3 ? 0.4 + age * 0.2 : 1;
  ctx.translate(W / 2, y0 + blockH / 2);
  ctx.scale(scale, scale);
  ctx.translate(-W / 2, -(y0 + blockH / 2));
  let wi = 0;
  for (const words of lines) {
    const texts = words.map((w) => up(w.text));
    const space = ctx.measureText(' ').width;
    const widths = texts.map((t) => ctx.measureText(t).width);
    const lineW = widths.reduce((a, b) => a + b, 0) + space * (texts.length - 1);
    let x = (W - lineW) / 2;
    const y = y0 + lineH / 2;
    if (style.box) {
      const pad = size * 0.28;
      ctx.fillStyle = hexA(style.boxColor, style.boxOpacity);
      roundRect(ctx, x - pad, y - lineH / 2 - pad * 0.3, lineW + pad * 2, lineH + pad * 0.6, size * 0.18);
    }
    texts.forEach((t, k) => {
      const isActive = wi === active;
      let color = style.color;
      if ((style.animation === 'highlight' && isActive) || (style.animation === 'karaoke' && wi <= active)) color = style.highlight;
      if (!style.box && style.outlineWidth > 0) {
        ctx.strokeStyle = style.outline;
        ctx.lineWidth = (style.outlineWidth / 100) * size * 2;
        ctx.strokeText(t, x, y);
      }
      if (style.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowOffsetY = (style.shadow / 1080) * H; }
      ctx.fillStyle = color;
      if (style.animation === 'highlight' && isActive) {
        ctx.save();
        ctx.translate(x + widths[k] / 2, y);
        ctx.scale(1.08, 1.08);
        ctx.fillText(t, -widths[k] / 2, 0);
        ctx.restore();
      } else ctx.fillText(t, x, y);
      ctx.shadowColor = 'transparent';
      x += widths[k] + space;
      wi++;
    });
    y0 += lineH;
  }
  ctx.restore();
}

function hexA(hex: string, a: number) {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

// ------------------------------------------------------------------ panel

export function CaptionsPanel() {
  const seq = useStore((s) => activeSeq(s));
  const jobs = useStore((s) => s.jobs);
  const sys = useStore((s) => s.sys);
  const cap = seq.captions;
  const busy = Object.values(jobs).some((j) => j.kind === 'transcribe' && !j.done);
  const [lang, setLang] = useState(cap?.language ?? 'tr');
  const [model, setModel] = useState(sys?.lowSpec ? MODELS[0].id : MODELS[1].id);
  const audioTracks = seq.tracks.filter((t) => t.kind === 'audio');
  const [tracks, setTracks] = useState<string[] | null>(null);
  const chosen = tracks ?? defaultSpeechTracks(seq);

  const importSubs = async () => {
    const r = await window.kurgu.openText(['srt', 'vtt']);
    if (!r) return;
    const items = parseSubtitles(r.content, seq.fps);
    if (!items.length) { toast('Dosyada altyazı bulunamadı', 'error'); return; }
    edit('Altyazı içe aktar', (s) => { const t = s.captions ?? emptyCaptions(lang); t.items = items; t.enabled = true; t.style = presetStyle('klasik'); s.captions = t; });
    toast(`${items.length} altyazı içe aktarıldı`, 'success');
  };

  if (!cap || !cap.items.length) {
    return (
      <div className="panel-body" style={{ padding: 12, display: 'grid', gap: 12, alignContent: 'start' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Otomatik altyazı</div>
          <div style={{ color: 'var(--text-2)' }}>Konuşmalar bu bilgisayarda yazıya dökülür: ücretsiz, internetsiz, kelime zamanlamalı. Model ilk kullanımda bir kez indirilir.</div>
        </div>
        <div className="field"><label>Dil</label>
          <select value={lang} onChange={(e) => setLang(e.target.value)}>{LANGUAGES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div style={{ display: 'grid', gap: 6 }}>
          {MODELS.map((m) => (
            <button key={m.id} className={`preset ${model === m.id ? 'on' : ''}`} onClick={() => setModel(m.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{m.name}</b><span style={{ color: 'var(--text-3)' }}>{m.size}</span></div>
              <div style={{ color: 'var(--text-3)' }}>{m.note}</div>
            </button>
          ))}
        </div>
        <div>
          <div style={{ color: 'var(--text-2)', marginBottom: 4 }}>Dinlenecek ses izleri</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {audioTracks.map((t) => (
              <label key={t.id} className="check"><input type="checkbox" checked={chosen.includes(t.id)} onChange={(e) => setTracks(e.target.checked ? [...chosen, t.id] : chosen.filter((x) => x !== t.id))} /> {t.name}</label>
            ))}
          </div>
          <div style={{ color: 'var(--text-3)', marginTop: 4 }}>Müzik izlerini kapalı tutmak tanımayı iyileştirir.</div>
        </div>
        <button className="btn primary" style={{ justifyContent: 'center', padding: 9 }} disabled={busy || !Object.keys(seq.clips).length} onClick={() => autoCaption({ model, language: lang, trackIds: chosen })}>
          {busy ? 'Altyazı oluşturuluyor…' : 'Altyazı oluştur'}
        </button>
        <button className="btn" style={{ justifyContent: 'center' }} onClick={importSubs}>{I.import} SRT / VTT içe aktar</button>
      </div>
    );
  }

  return <CaptionEditor seq={seq} />;
}

function CaptionEditor({ seq }: { seq: Sequence }) {
  const cap = seq.captions!;
  const style = cap.style;
  const playhead = useStore((s) => committedSeq(s).playhead);
  const current = useMemo(() => captionAt(cap.items, playhead), [cap.items, playhead]);
  const setStyle = (patch: Partial<CaptionStyle>, regroup = false) => edit('Altyazı stili', (s) => {
    if (!s.captions) return;
    s.captions.style = { ...s.captions.style, ...patch };
    if (regroup) {
      const words = s.captions.items.flatMap((c) => (c.words.length ? c.words : distributeWords(c.text, c.start, c.end)));
      s.captions.items = groupWords(words, fitted(s.captions.style, s.width, s.height), s.fps);
    }
  });
  const updateText = (c: Caption, text: string) => edit('Altyazı metni', (s) => {
    const it = s.captions!.items.find((x) => x.id === c.id);
    if (!it || it.text === text) return;
    const newWords = text.split(/\s+/).filter(Boolean);
    // keep word timings when only spelling changed; otherwise re-spread
    it.words = newWords.length === it.words.length ? it.words.map((w, i) => ({ ...w, text: newWords[i] })) : distributeWords(text, it.start, it.end);
    it.text = text;
  });

  return (
    <div className="panel-body" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 10, display: 'grid', gap: 8, borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label className="check"><input type="checkbox" checked={cap.enabled} onChange={(e) => edit('Altyazıyı göster', (s) => { s.captions!.enabled = e.target.checked; })} /> Göster ve videoya göm</label>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={async () => { const p = await window.kurgu.saveText(seq.name, 'srt', toSRT(cap.items, seq.fps, fitted(style, seq.width, seq.height))); if (p) toast('SRT kaydedildi', 'success'); }}>SRT</button>
          <button className="btn small" onClick={async () => { const p = await window.kurgu.saveText(seq.name, 'vtt', toVTT(cap.items, seq.fps, fitted(style, seq.width, seq.height))); if (p) toast('VTT kaydedildi', 'success'); }}>VTT</button>
          <button className="btn small" title="Altyazıları sil" onClick={() => { if (window.confirm('Tüm altyazılar silinsin mi?')) edit('Altyazıları sil', (s) => { delete s.captions; }); }}>{I.close}</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {Object.entries(PRESET_NAMES).map(([id, name]) => (
            <button key={id} className={`preset ${style.preset === id ? 'on' : ''}`} style={{ padding: '6px 8px' }}
              onClick={() => edit('Altyazı stili', (s) => {
                const keep = { color: s.captions!.style.color, highlight: s.captions!.style.highlight };
                s.captions!.style = { ...presetStyle(id), ...(id === s.captions!.style.preset ? keep : {}) };
                const words = s.captions!.items.flatMap((c) => (c.words.length ? c.words : distributeWords(c.text, c.start, c.end)));
                s.captions!.items = groupWords(words, fitted(s.captions!.style, s.width, s.height), s.fps);
              })}>{name}</button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: 6, alignItems: 'center' }}>
          <span style={{ color: 'var(--text-2)' }}>Yazı</span><input type="color" value={style.color} onChange={(e) => setStyle({ color: e.target.value })} />
          <span style={{ color: 'var(--text-2)' }}>Vurgu</span><input type="color" value={style.highlight} onChange={(e) => setStyle({ highlight: e.target.value })} />
          <span style={{ color: 'var(--text-2)' }}>Boyut</span><input type="range" min={2.5} max={12} step={0.1} value={style.size} onChange={(e) => setStyle({ size: Number(e.target.value) }, true)} />
          <span style={{ color: 'var(--text-2)' }}>Konum</span>
          <select className="mini" value={style.position} onChange={(e) => setStyle({ position: e.target.value as CaptionStyle['position'], margin: e.target.value === 'middle' ? 0 : style.margin || 8 })}>
            <option value="top">Üst</option><option value="middle">Orta</option><option value="bottom">Alt</option>
          </select>
          <span style={{ color: 'var(--text-2)' }}>Kenar</span><input type="range" min={0} max={40} step={0.5} value={style.margin} onChange={(e) => setStyle({ margin: Number(e.target.value) })} />
          <span />
          <span style={{ display: 'flex', gap: 10 }}>
            <label className="check"><input type="checkbox" checked={style.uppercase} onChange={(e) => setStyle({ uppercase: e.target.checked }, true)} /> BÜYÜK</label>
            <label className="check"><input type="checkbox" checked={style.box} onChange={(e) => setStyle({ box: e.target.checked })} /> Kutu</label>
          </span>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {cap.items.map((c) => (
          <div key={c.id} onMouseDown={() => setPlayhead(c.start)}
            style={{ display: 'grid', gridTemplateColumns: '78px 1fr 22px', gap: 6, padding: '5px 10px', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.04)', background: current?.id === c.id ? 'var(--accent-dim)' : undefined }}>
            <span style={{ font: '11px var(--mono)', color: 'var(--text-3)' }}>{framesToTimecode(c.start, seq.fps)}</span>
            <input defaultValue={c.text} key={c.text} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              onBlur={(e) => updateText(c, e.target.value.trim())}
              style={{ background: 'transparent', border: '1px solid transparent', borderRadius: 4, padding: '3px 5px', outline: 'none' }}
              onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }} />
            <button className="icon-btn" title="Sil" onClick={(e) => { e.stopPropagation(); edit('Altyazı sil', (s) => { s.captions!.items = s.captions!.items.filter((x) => x.id !== c.id); }); }}>{I.close}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
