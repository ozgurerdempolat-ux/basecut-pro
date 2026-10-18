// Audio Track Mixer (faders, pan, mute/solo, live meters), automatic ducking of
// music under speech, and voice-over recording from the microphone.
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_DUCK, duckKeyframes, speechRegions, trackLevels } from '../core/ducking';
import { Track, clipEnd, framesToTimecode } from '../core/model';
import * as ops from '../core/ops';
import { player } from './player';
import { activeSeq, cancelPreview, commitPreview, committedSeq, edit, importPaths, previewEdit, toast, useStore } from './store';

const dbToPos = (db: number) => (db <= -60 ? 0 : db >= 12 ? 1 : db <= 0 ? Math.pow((db + 60) / 60, 2) * 0.8 : 0.8 + (db / 12) * 0.2);
const posToDb = (p: number) => (p <= 0 ? -60 : p <= 0.8 ? Math.sqrt(p / 0.8) * 60 - 60 : ((p - 0.8) / 0.2) * 12);
const fmtDb = (db: number) => (db <= -60 ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);

/** vertical meter drawn every animation frame from the player's analysers */
function Meter({ level }: { level: () => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0, peak = 0, hold = 0;
    const tick = () => {
      const c = ref.current;
      if (c) {
        const g = c.getContext('2d')!;
        const v = Math.min(1, level());
        const db = v > 0 ? 20 * Math.log10(v) : -90;
        const h = c.height, w = c.width;
        const y = Math.max(0, Math.min(1, (db + 60) / 60));
        if (y >= peak) { peak = y; hold = 40; } else if (hold > 0) hold--; else peak = Math.max(0, peak - 0.01);
        g.clearRect(0, 0, w, h);
        g.fillStyle = '#0b0c0f'; g.fillRect(0, 0, w, h);
        g.fillStyle = 'rgba(255,255,255,0.08)'; for (const m of [0, -6, -12, -24, -48]) g.fillRect(0, Math.round(h * (1 - (m + 60) / 60)), w, 1);
        const grad = g.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, '#2fbf71'); grad.addColorStop(0.75, '#d8c94a'); grad.addColorStop(0.92, '#ff6a3d'); grad.addColorStop(1, '#ff2d2d');
        g.fillStyle = grad; g.fillRect(0, h * (1 - y), w, h * y);
        g.fillStyle = peak > 0.98 ? '#ff2d2d' : '#e8e8e8'; g.fillRect(0, h * (1 - peak), w, 2);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [level]);
  return <canvas ref={ref} width={8} height={150} className="mix-meter" />;
}

function DbInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input className="mix-db" value={text ?? fmtDb(value)} title="dB yazıp Enter"
      onFocus={(e) => { setText(fmtDb(value)); e.target.select(); }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => setText(null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { setText(null); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Enter') {
          const v = Number((text ?? '').replace('−∞', '-60').replace('−', '-').replace(',', '.'));
          if (Number.isFinite(v)) onCommit(v);
          setText(null); (e.target as HTMLInputElement).blur();
        }
      }} />
  );
}

function Strip({ track }: { track: Track }) {
  const set = (label: string, fn: (t: Track) => void) => edit(label, (s) => { const t = s.tracks.find((x) => x.id === track.id); if (t) fn(t); });
  const drag = (fn: (t: Track) => void) => previewEdit((s) => { const t = s.tracks.find((x) => x.id === track.id); if (t) fn(t); });
  const pan = track.pan ?? 0;
  return (
    <div className="mix-strip" data-track={track.name}>
      <div className="mix-name" title={track.name}>{track.name}</div>
      <div className="mix-pan">
        <input type="range" min={-100} max={100} step={1} value={pan} title={`Pan: ${pan === 0 ? 'orta' : pan < 0 ? `sol ${-pan}` : `sağ ${pan}`} (çift tık: orta)`}
          onChange={(e) => drag((t) => { t.pan = Number(e.target.value); })}
          onPointerUp={() => commitPreview('Pan')} onDoubleClick={() => { cancelPreview(); set('Pan ortala', (t) => { t.pan = 0; }); }} />
        <span>{pan === 0 ? 'O' : pan < 0 ? `L${-pan}` : `R${pan}`}</span>
      </div>
      <div className="mix-btns">
        <button className={`mix-b ${track.muted ? 'on mute' : ''}`} title="Sessiz (M)" onClick={() => set('Sessiz', (t) => { t.muted = !t.muted; })}>M</button>
        <button className={`mix-b ${track.solo ? 'on solo' : ''}`} title="Solo (S)" onClick={() => set('Solo', (t) => { t.solo = !t.solo; })}>S</button>
      </div>
      <div className="mix-fader">
        <input type="range" className="vfader" min={0} max={1} step={0.001} value={dbToPos(track.volumeDb)}
          onChange={(e) => drag((t) => { t.volumeDb = Math.round(posToDb(Number(e.target.value)) * 10) / 10; })}
          onPointerUp={() => commitPreview('Kanal seviyesi')}
          onDoubleClick={() => { cancelPreview(); set('Seviyeyi sıfırla', (t) => { t.volumeDb = 0; }); }} title="Çift tık: 0 dB" />
        <Meter level={() => player.trackLevel(track.id)} />
      </div>
      <DbInput value={track.volumeDb} onCommit={(v) => set('Kanal seviyesi', (t) => { t.volumeDb = Math.max(-60, Math.min(12, v)); })} />
    </div>
  );
}

// ------------------------------------------------------------------ ducking

export function autoDuck(musicTrack: string, speechTracks: string[], amountDb: number, sensitivity: number): number {
  const st = useStore.getState();
  const seq = committedSeq(st);
  const peaksOf = (mediaId: string) => {
    const m = st.project.media[mediaId];
    const a = m ? st.assets[m.path] : undefined;
    return a?.peaks ? { peaks: a.peaks, pps: a.peaksPerSecond ?? 50 } : null;
  };
  const levels = trackLevels(seq, speechTracks, peaksOf);
  const opts = { ...DEFAULT_DUCK, amountDb, threshold: 0.02 + (1 - sensitivity / 100) * 0.12 };
  const regions = speechRegions(levels, seq.fps, opts);
  let n = 0;
  edit('Otomatik ses kısma (ducking)', (s) => {
    for (const c of Object.values(s.clips)) {
      if (c.trackId !== musicTrack || c.stream !== 'audio') continue;
      const k = duckKeyframes(c, regions, s.fps, opts);
      c.volumeDb.keyframes = k;
      if (k.length) n++;
    }
  });
  return regions.length ? n : -1;
}

function DuckCard() {
  const seq = useStore((s) => activeSeq(s));
  const auds = seq.tracks.filter((t) => t.kind === 'audio');
  const [music, setMusic] = useState<string>(auds[auds.length > 1 ? 1 : 0]?.id ?? '');
  const [speech, setSpeech] = useState<string[] | null>(null);
  const [amount, setAmount] = useState(-14);
  const [sens, setSens] = useState(60);
  const speechIds = speech ?? auds.filter((t) => t.id !== music).slice(0, 1).map((t) => t.id);
  return (
    <div className="mix-card">
      <div className="mix-card-h">Müziği konuşmanın altında otomatik kıs</div>
      <div className="mix-grid">
        <span>Müzik</span>
        <select className="mini" value={music} onChange={(e) => setMusic(e.target.value)}>{auds.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <span>Konuşma</span>
        <span className="mix-checks">{auds.filter((t) => t.id !== music).map((t) => (
          <label key={t.id} className="check"><input type="checkbox" checked={speechIds.includes(t.id)} onChange={(e) => setSpeech(e.target.checked ? [...speechIds, t.id] : speechIds.filter((x) => x !== t.id))} /> {t.name}</label>
        ))}</span>
        <span>Kısma</span>
        <span className="mix-row"><input type="range" min={-30} max={-3} step={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} /><b>{amount} dB</b></span>
        <span>Hassasiyet</span>
        <span className="mix-row"><input type="range" min={0} max={100} step={1} value={sens} onChange={(e) => setSens(Number(e.target.value))} /><b>%{sens}</b></span>
      </div>
      <div className="mix-actions">
        <button className="btn small primary" disabled={!music || !speechIds.length} onClick={() => {
          const n = autoDuck(music, speechIds, amount, sens);
          if (n < 0) toast('Konuşma kanallarında ses bulunamadı', 'error');
          else toast(n ? `${n} müzik klibine kısma anahtar kareleri eklendi` : 'Müzik kanalında klip yok', n ? 'success' : 'error');
        }}>Uygula</button>
        <button className="btn small" onClick={() => edit('Ses kısmayı kaldır', (s) => { for (const c of Object.values(s.clips)) if (c.trackId === music && c.stream === 'audio') c.volumeDb.keyframes = []; })}>Kaldır</button>
      </div>
      <div className="mix-hint">Anahtar kareler müzik klibinin ses seviyesine yazılır; Efekt Kontrolleri'nden tek tek düzeltebilirsiniz.</div>
    </div>
  );
}

// ------------------------------------------------------------------ voice-over

function VoiceOverCard() {
  const seq = useStore((s) => activeSeq(s));
  const auds = seq.tracks.filter((t) => t.kind === 'audio');
  const [target, setTarget] = useState<string>('');
  const [state, setState] = useState<'idle' | 'count' | 'rec' | 'save'>('idle');
  const [count, setCount] = useState(3);
  const [muteMonitor, setMuteMonitor] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<{ mr: MediaRecorder; chunks: Blob[]; stream: MediaStream; start: number; t0: number } | null>(null);
  const trackId = target || auds.find((t) => !Object.values(seq.clips).some((c) => c.trackId === t.id && clipEnd(c) > seq.playhead && c.start < seq.playhead + seq.fps * 10))?.id || auds[auds.length - 1]?.id || '';

  useEffect(() => {
    if (state !== 'rec') return;
    const id = setInterval(() => setElapsed((performance.now() - (rec.current?.t0 ?? performance.now())) / 1000), 200);
    return () => clearInterval(id);
  }, [state]);

  const start = async () => {
    if (!(await window.kurgu.micAccess())) { toast('Mikrofon izni verilmedi (Sistem Ayarları › Gizlilik › Mikrofon)', 'error'); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } }); }
    catch { toast('Mikrofon bulunamadı veya kullanılamıyor', 'error'); return; }
    setState('count');
    for (let i = 3; i > 0; i--) { setCount(i); await new Promise((r) => setTimeout(r, 700)); }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const startFrame = committedSeq().playhead;
    rec.current = { mr, chunks, stream, start: startFrame, t0: performance.now() };
    mr.start(250);
    player.setMonitorMuted(muteMonitor);
    player.play(1);
    setElapsed(0);
    setState('rec');
  };

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    player.pause();
    player.setMonitorMuted(false);
    setState('save');
    await new Promise<void>((res) => { r.mr.onstop = () => res(); r.mr.stop(); });
    r.stream.getTracks().forEach((t) => t.stop());
    rec.current = null;
    try {
      const buf = new Uint8Array(await new Blob(r.chunks, { type: r.mr.mimeType }).arrayBuffer());
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const path = await window.kurgu.saveRecording(`seslendirme-${stamp}`, buf);
      const [m] = await importPaths([path]);
      if (!m) throw new Error('içe aktarılamadı');
      edit('Seslendirme kaydı', (s) => { ops.overwriteEdit(s, { media: m, srcIn: 0, srcOut: m.duration }, r.start, null, trackId); });
      toast(`Seslendirme ${framesToTimecode(r.start, committedSeq().fps)} noktasına eklendi`, 'success');
    } catch (e) {
      toast(`Kayıt kaydedilemedi: ${(e as Error).message}`, 'error');
    }
    setState('idle');
  };

  return (
    <div className="mix-card">
      <div className="mix-card-h">Seslendirme kaydı (dış ses)</div>
      <div className="mix-grid">
        <span>Kanal</span>
        <select className="mini" value={trackId} onChange={(e) => setTarget(e.target.value)} disabled={state !== 'idle'}>{auds.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <span />
        <label className="check"><input type="checkbox" checked={muteMonitor} onChange={(e) => setMuteMonitor(e.target.checked)} disabled={state !== 'idle'} /> Kayıtta hoparlörü kapat (yankı olmasın)</label>
      </div>
      <div className="mix-actions">
        {state === 'idle' && <button className="btn small rec" onClick={() => void start()}><span className="rec-dot" /> Kaydı başlat</button>}
        {state === 'count' && <button className="btn small rec" disabled>{count}…</button>}
        {state === 'rec' && <button className="btn small rec on" onClick={() => void stop()}><span className="rec-dot blink" /> Durdur · {elapsed.toFixed(1)} sn</button>}
        {state === 'save' && <button className="btn small" disabled>Kaydediliyor…</button>}
      </div>
      <div className="mix-hint">Kayıt oynatma kafasından başlar ve seçilen kanala yerleşir. Dosyalar Belgeler › BaseCut Pro › Seslendirmeler klasörüne kaydedilir.</div>
    </div>
  );
}

export function MixerPanel() {
  const seq = useStore((s) => activeSeq(s));
  const auds = seq.tracks.filter((t) => t.kind === 'audio');
  return (
    <div className="panel-body mixer">
      <div className="mix-strips">
        {auds.map((t) => <Strip key={t.id} track={t} />)}
        <div className="mix-strip master">
          <div className="mix-name">Ana</div>
          <div className="mix-pan" />
          <div className="mix-btns" />
          <div className="mix-fader"><Meter level={() => player.levels()} /><Meter level={() => player.levels()} /></div>
          <div className="mix-db static">Ana çıkış</div>
        </div>
      </div>
      <DuckCard />
      <VoiceOverCard />
    </div>
  );
}
