import { useEffect, useRef, useState } from 'react';
import { MediaItem, framesToTimecode, sequenceDuration } from '../core/model';
import * as ops from '../core/ops';
import { I } from './icons';
import { player } from './player';
import { committedSeq, edit, editProject, playbackPath, setPlayhead, setSeqField, useStore } from './store';
import { createTitle, updateTitle } from './titles';

// -------------------------------------------------------------------- program monitor

export function ProgramMonitor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seq = useStore((s) => committedSeq(s));
  const playing = useStore((s) => s.playing);
  const res = useStore((s) => s.playbackRes);
  const focused = useStore((s) => s.focus === 'program');
  const [safe, setSafe] = useState(false);
  const [level, setLevel] = useState(0);
  const [fpsShown, setFpsShown] = useState(0);
  const total = sequenceDuration(seq);

  useEffect(() => { if (canvasRef.current) player.attach(canvasRef.current); }, []);
  useEffect(() => {
    if (!playing) { setLevel(0); return; }
    const t = setInterval(() => { setLevel(player.levels()); setFpsShown(player.fpsMeter.value); }, 80);
    return () => clearInterval(t);
  }, [playing]);

  const scrubTo = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = ((e.clientX - r.left) / r.width) * Math.max(total, 1);
    setPlayhead(f);
  };

  return (
    <div className={`panel ${focused ? 'focused' : ''}`} onMouseDown={() => useStore.setState({ focus: 'program' })}>
      <div className="panel-tabs"><div className="tab on">Program: {seq.name}</div><div className="grow" />
        {playing && fpsShown > 0 && fpsShown < seq.fps * 0.8 && <span className="pill warn" title="Bu bilgisayar tam hızda oynatamıyor. Oynatma çözünürlüğünü düşürün veya proxy kullanın.">düşen kare</span>}
      </div>
      <div className="monitor">
        <div className="viewer" onDoubleClick={() => player.toggle()} style={{ cursor: useStore.getState().tool === 'type' ? 'text' : undefined }}
          onMouseDown={async (e) => {
            if (useStore.getState().tool !== 'type' || !canvasRef.current) return;
            // Type tool: click where the title should sit
            const r = canvasRef.current.getBoundingClientRect();
            const x = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
            const y = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
            const clipId = await createTitle('sade');
            const st = useStore.getState();
            const c = committedSeq(st).clips[clipId];
            if (c) await updateTitle(c.mediaId, { x, y, text: 'Metin' });
          }}>
          <canvas ref={canvasRef} style={{ aspectRatio: `${seq.width}/${seq.height}` }} />
          {safe && <SafeMargins w={seq.width} h={seq.height} />}
          {total === 0 && <div className="overlay-text">Proje panelinden klip sürükleyin veya içe aktarın</div>}
        </div>
        <div className="scrubber" onMouseDown={(e) => { scrubTo(e); const el = e.currentTarget; const mv = (ev: MouseEvent) => scrubTo({ clientX: ev.clientX, currentTarget: el } as unknown as React.MouseEvent<HTMLDivElement>); const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); }; window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up); }}>
          {seq.inPoint !== null && seq.outPoint !== null && total > 0 && (
            <div className="range" style={{ left: `${(seq.inPoint / total) * 100}%`, width: `${((seq.outPoint - seq.inPoint) / total) * 100}%` }} />
          )}
          <div className="head" style={{ left: `${total ? (seq.playhead / total) * 100 : 0}%` }} />
        </div>
        <div className="transport">
          <span className="tc">{framesToTimecode(seq.playhead, seq.fps)}</span>
          <div className="grow" />
          <button className="icon-btn" title="Giriş işaretle (I)" onClick={() => setSeqField('inPoint', seq.playhead)}>{I.markIn}</button>
          <button className="icon-btn" title="Çıkış işaretle (O)" onClick={() => setSeqField('outPoint', seq.playhead + 1)}>{I.markOut}</button>
          <button className="icon-btn" title="Girişe git (Shift+I)" onClick={() => seq.inPoint !== null && setPlayhead(seq.inPoint)}>{I.toIn}</button>
          <button className="icon-btn" title="1 kare geri (←)" onClick={() => setPlayhead(seq.playhead - 1)}>{I.stepBack}</button>
          <button className="icon-btn" title="Oynat / durdur (Boşluk)" onClick={() => player.toggle()} style={{ color: 'var(--text)' }}>{playing ? I.pause : I.play}</button>
          <button className="icon-btn" title="1 kare ileri (→)" onClick={() => setPlayhead(seq.playhead + 1)}>{I.stepFwd}</button>
          <button className="icon-btn" title="Çıkışa git (Shift+O)" onClick={() => seq.outPoint !== null && setPlayhead(seq.outPoint - 1)}>{I.toOut}</button>
          <button className="icon-btn" title="Kaldır (;)" onClick={() => seq.inPoint !== null && seq.outPoint !== null && edit('Kaldır', (s) => ops.lift(s, seq.inPoint!, seq.outPoint!))}>{I.lift}</button>
          <button className="icon-btn" title="Ayıkla (')" onClick={() => seq.inPoint !== null && seq.outPoint !== null && edit('Ayıkla', (s) => ops.extract(s, seq.inPoint!, seq.outPoint!))}>{I.extract}</button>
          <button className="icon-btn" title="Kareyi dışa aktar" onClick={() => window.dispatchEvent(new CustomEvent('kurgu-command', { detail: 'export-frame' }))}>{I.camera}</button>
          <div className="grow" />
          <button className={`icon-btn ${safe ? 'on' : ''}`} title="Güvenli kenar boşlukları" onClick={() => setSafe(!safe)}>{I.safe}</button>
          <select className="mini" value={res} title="Oynatma çözünürlüğü (zayıf bilgisayarlar için düşürün)" onChange={(e) => useStore.setState({ playbackRes: Number(e.target.value) as 1 | 0.5 | 0.25 })}>
            <option value={1}>Tam</option><option value={0.5}>1/2</option><option value={0.25}>1/4</option>
          </select>
          <div className="meter" title="Ses seviyesi"><div style={{ height: `${Math.min(100, level * 100)}%` }} /></div>
          <span className="tc dim" style={{ textAlign: 'right' }}>{framesToTimecode(total, seq.fps)}</span>
        </div>
      </div>
    </div>
  );
}

function SafeMargins({ w, h }: { w: number; h: number }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{ aspectRatio: `${w}/${h}`, maxWidth: '100%', maxHeight: '100%', width: '100%', position: 'relative' }}>
        <div className="safe-margins" style={{ inset: '5%' }} />
        <div className="safe-margins" style={{ inset: '10%' }} />
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- source monitor

export function SourceMonitor() {
  const mediaId = useStore((s) => s.sourceMediaId);
  const media = useStore((s) => (s.sourceMediaId ? s.project.media[s.sourceMediaId] : null));
  const proxies = useStore((s) => s.proxies);
  const focused = useStore((s) => s.focus === 'source');
  const videoRef = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const fps = media?.fps || 30;
  const path = media ? playbackPath(media) : null;
  void proxies;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const up = () => { setT(v.currentTime); useStore.setState({ sourceTime: v.currentTime }); };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener('timeupdate', up);
    v.addEventListener('seeked', up);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    let raf = 0;
    const loop = () => { if (!v.paused) setT(v.currentTime); raf = requestAnimationFrame(loop); };
    loop();
    return () => { cancelAnimationFrame(raf); v.removeEventListener('timeupdate', up); v.removeEventListener('seeked', up); v.removeEventListener('play', onPlay); v.removeEventListener('pause', onPause); };
  }, [mediaId]);

  // keyboard shortcuts routed here when the source monitor has focus
  useEffect(() => {
    const h = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      const v = videoRef.current;
      if (!v || !media) return;
      const step = 1 / fps;
      switch (cmd) {
        case 'toggle': v.paused ? void v.play() : v.pause(); break;
        case 'step-back': v.currentTime = Math.max(0, v.currentTime - step); break;
        case 'step-fwd': v.currentTime = v.currentTime + step; break;
        case 'step-back-5': v.currentTime = Math.max(0, v.currentTime - 5 * step); break;
        case 'step-fwd-5': v.currentTime = v.currentTime + 5 * step; break;
        case 'mark-in': markIn(); break;
        case 'mark-out': markOut(); break;
        case 'shuttle-left': v.playbackRate = 1; v.currentTime = Math.max(0, v.currentTime - 1); break;
        case 'shuttle-right': if (v.paused) void v.play(); else v.playbackRate = Math.min(8, v.playbackRate * 2); break;
        case 'shuttle-stop': v.pause(); v.playbackRate = 1; break;
        case 'home': v.currentTime = 0; break;
        case 'end': v.currentTime = Number.isFinite(media.duration) ? media.duration : 0; break;
        case 'go-in': if (media.markIn !== null) v.currentTime = media.markIn; break;
        case 'go-out': if (media.markOut !== null) v.currentTime = media.markOut; break;
      }
    };
    window.addEventListener('kurgu-source', h);
    return () => window.removeEventListener('kurgu-source', h);
  });

  const markIn = () => media && editProject('Kaynak girişi', (p) => { p.media[media.id].markIn = videoRef.current?.currentTime ?? t; });
  const markOut = () => media && editProject('Kaynak çıkışı', (p) => { p.media[media.id].markOut = videoRef.current?.currentTime ?? t; });

  const dur = media ? (Number.isFinite(media.duration) ? media.duration : 5) : 0;
  const inT = media?.markIn ?? 0;
  const outT = media?.markOut ?? dur;

  const scrub = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const v = videoRef.current;
    if (v && dur) v.currentTime = Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur));
  };

  return (
    <div className={`panel ${focused ? 'focused' : ''}`} onMouseDown={() => useStore.setState({ focus: 'source' })}>
      <div className="panel-tabs"><div className="tab on">Kaynak{media ? `: ${media.name}` : ''}</div></div>
      <div className="monitor">
        <div className="viewer" draggable={!!media} onDragStart={(e) => {
          if (!media) return;
          e.dataTransfer.setData('application/x-kurgu-media', JSON.stringify({ ids: [media.id], in: inT, out: outT }));
          e.dataTransfer.effectAllowed = 'copy';
        }} onDoubleClick={() => { const v = videoRef.current; if (v) v.paused ? void v.play() : v.pause(); }}>
          {media && path && media.kind !== 'image' && <video ref={videoRef} src={window.kurgu.mediaUrl(path)} preload="auto" />}
          {media && path && media.kind === 'image' && <img src={window.kurgu.mediaUrl(path)} style={{ maxWidth: '100%', maxHeight: '100%' }} />}
          {media && !path && <div className="overlay-text">Proxy hazırlanıyor… (bu format doğrudan önizlenemiyor)</div>}
          {!media && <div className="overlay-text">Proje panelinde bir klibe çift tıklayın</div>}
        </div>
        <div className="scrubber" onMouseDown={(e) => {
          const el = e.currentTarget;
          scrub(e.clientX, el);
          const mv = (ev: MouseEvent) => scrub(ev.clientX, el);
          const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
          window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
        }}>
          {media && (media.markIn !== null || media.markOut !== null) && dur > 0 && (
            <div className="range" style={{ left: `${(inT / dur) * 100}%`, width: `${((outT - inT) / dur) * 100}%` }} />
          )}
          <div className="head" style={{ left: `${dur ? (t / dur) * 100 : 0}%` }} />
        </div>
        <div className="transport">
          <span className="tc">{framesToTimecode(t * fps, fps)}</span>
          <div className="grow" />
          <button className="icon-btn" title="Giriş (I)" onClick={markIn} disabled={!media}>{I.markIn}</button>
          <button className="icon-btn" title="Çıkış (O)" onClick={markOut} disabled={!media}>{I.markOut}</button>
          <button className="icon-btn" title="1 kare geri" onClick={() => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, v.currentTime - 1 / fps); }}>{I.stepBack}</button>
          <button className="icon-btn" title="Oynat" style={{ color: 'var(--text)' }} onClick={() => { const v = videoRef.current; if (v) v.paused ? void v.play() : v.pause(); }}>{playing ? I.pause : I.play}</button>
          <button className="icon-btn" title="1 kare ileri" onClick={() => { const v = videoRef.current; if (v) v.currentTime += 1 / fps; }}>{I.stepFwd}</button>
          <button className="icon-btn" title="Ekle (,)" onClick={() => sourceEdit('insert')} disabled={!media}>{I.insert}</button>
          <button className="icon-btn" title="Üzerine yaz (.)" onClick={() => sourceEdit('overwrite')} disabled={!media}>{I.overwrite}</button>
          <div className="grow" />
          <span className="tc dim">{media ? framesToTimecode((outT - inT) * fps, fps) : '--:--:--:--'}</span>
        </div>
      </div>
    </div>
  );
}

/** , and . : bring the source range into the sequence at the playhead (or sequence In) */
export function sourceEdit(kind: 'insert' | 'overwrite') {
  const st = useStore.getState();
  const m: MediaItem | undefined = st.sourceMediaId ? st.project.media[st.sourceMediaId] : undefined;
  if (!m) return;
  const seq = committedSeq(st);
  const dur = Number.isFinite(m.duration) ? m.duration : 5;
  const srcIn = m.markIn ?? 0;
  let srcOut = m.markOut ?? dur;
  const at = seq.inPoint ?? seq.playhead;
  // four-point fit: if both sequence in and out are set, trim the source to fit
  if (seq.inPoint !== null && seq.outPoint !== null) srcOut = Math.min(srcOut, srcIn + (seq.outPoint - seq.inPoint) / seq.fps);
  const ok = edit(kind === 'insert' ? 'Ekle' : 'Üzerine yaz', (s) => {
    const t = ops.targetTracks(s);
    const created = (kind === 'insert' ? ops.insertEdit : ops.overwriteEdit)(s, { media: m, srcIn, srcOut }, at, t.video, t.audio);
    s.playhead = at + s.clips[created[0]].duration;
  });
  if (ok) player.invalidate();
}
