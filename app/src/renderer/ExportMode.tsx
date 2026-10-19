import { needsStabilize } from '../core/stabilize';
import { useEffect, useMemo, useState } from 'react';
import { clipEnd, framesToTimecode, sequenceDuration } from '../core/model';
import { EXPORT_PRESETS, ExportSettings, defaultExport } from '../core/render-graph';
import { I } from './icons';
import { ProgramMonitor } from './Monitors';
import { committedSeq, toast, useStore } from './store';
import { prepareBurn } from './Captions';
import { toSRT, fitted } from '../core/captions';

interface Issue { level: 'ok' | 'warn' | 'err'; text: string; fix?: { label: string; run: () => void } }

/** Preflight: catch problems BEFORE a long render, not after (a top user request) */
function preflight(settings: ExportSettings): Issue[] {
  const st = useStore.getState();
  const seq = committedSeq(st);
  const issues: Issue[] = [];
  const total = sequenceDuration(seq);
  if (!total) issues.push({ level: 'err', text: 'Sekans boş: dışa aktarılacak bir şey yok.' });
  if (settings.range === 'inout' && (seq.inPoint === null || seq.outPoint === null)) {
    issues.push({ level: 'err', text: 'Aralık "Giriş–Çıkış" seçili ama sekansta giriş/çıkış işaretli değil.', fix: { label: 'Tümünü dışa aktar', run: () => setSettingsGlobal({ range: 'all' }) } });
  }
  const used = new Set(Object.values(seq.clips).map((c) => c.mediaId));
  const offline = [...used].map((id) => st.project.media[id]).filter((m) => m && !m.online);
  if (offline.length) issues.push({ level: 'err', text: `${offline.length} medya çevrimdışı: ${offline.map((m) => m.name).join(', ')}. Bu klipler siyah çıkar.` });
  // gaps
  const vids = Object.values(seq.clips).filter((c) => c.stream === 'video' && c.enabled).sort((a, b) => a.start - b.start);
  let covered = 0;
  let gaps = 0;
  for (const c of vids) { if (c.start > covered + 1) gaps++; covered = Math.max(covered, clipEnd(c)); }
  const unstab = Object.values(seq.clips).filter((c) => needsStabilize(c, st.project.media[c.mediaId], seq.fps));
  if (unstab.length) issues.push({ level: 'err', text: `Warp Stabilizer ${unstab.length} klipte hâlâ analiz ediyor. Bitince dışa aktarın (zaman çizelgesinde ilerlemeyi görebilirsiniz) — aksi halde titrek çıkar.` });
  if (gaps) issues.push({ level: 'warn', text: `${gaps} yerde video yok (siyah boşluk).` });
  // mismatched frame rates
  const mismatched = [...used].map((id) => st.project.media[id]).filter((m) => m && m.kind === 'video' && Math.abs(m.fps - seq.fps) > 0.05);
  if (mismatched.length) issues.push({ level: 'warn', text: `${mismatched.length} klibin kare hızı sekanstan farklı (${[...new Set(mismatched.map((m) => Math.round(m.fps * 100) / 100))].join(', ')} fps). Hareket hafif takılabilir.` });
  const W = settings.width ?? seq.width, H = settings.height ?? seq.height;
  if ((W % 2 || H % 2) && settings.videoCodec !== 'none') issues.push({ level: 'warn', text: `${W}×${H} tek sayı içeriyor; çift sayıya yuvarlanacak.` });
  if (settings.videoCodec === 'h264' && W * H > 4096 * 2304 && settings.hardware !== 'none') issues.push({ level: 'warn', text: 'Bazı donanım kodlayıcılar 4K üstünü desteklemez.' });
  if (W / H !== seq.width / seq.height && settings.videoCodec !== 'none') issues.push({ level: 'warn', text: `Çıkış en-boy oranı sekanstan farklı; görüntü siyah bantlarla sığdırılacak. Dikey video için sekansı 9:16 oluşturun veya Otomatik Yeniden Kadrajla'yı kullanın.` });
  const speedy = Object.values(seq.clips).filter((c) => c.speed < 0).length;
  if (speedy) issues.push({ level: 'warn', text: `${speedy} ters oynatılan klip var; render daha fazla bellek kullanır.` });
  if (!issues.length) issues.push({ level: 'ok', text: 'Her şey hazır görünüyor.' });
  return issues;
}

let setSettingsGlobal: (p: Partial<ExportSettings>) => void = () => {};

export function ExportMode() {
  const seq = useStore((s) => committedSeq(s));
  const sys = useStore((s) => s.sys);
  const jobs = useStore((s) => s.jobs);
  const [presetId, setPresetId] = useState('match');
  const [name, setName] = useState(seq.name);
  const [settings, setSettings] = useState<ExportSettings>(() => ({ ...defaultExport(''), ...EXPORT_PRESETS[0].apply }));
  const hasCaptions = !!(seq.captions?.enabled && seq.captions.items.length);
  const [burn, setBurn] = useState(true);
  const [sidecar, setSidecar] = useState(false);
  setSettingsGlobal = (p) => setSettings((s) => ({ ...s, ...p }));

  useEffect(() => setName(seq.name), [seq.name]);

  const choose = (id: string) => {
    setPresetId(id);
    const p = EXPORT_PRESETS.find((x) => x.id === id)!;
    setSettings({ ...defaultExport(''), hardware: settings.hardware, range: settings.range, ...p.apply });
  };

  const ext = settings.container;
  const total = settings.range === 'inout' && seq.inPoint !== null && seq.outPoint !== null ? seq.outPoint - seq.inPoint : sequenceDuration(seq);
  const secs = total / seq.fps;
  const W = settings.width ?? seq.width, H = settings.height ?? seq.height;
  const estMb = useMemo(() => {
    let vk = settings.videoBitrateKbps;
    if (settings.rateControl === 'quality' && settings.videoCodec !== 'none') {
      // rough: bits per pixel for the chosen quality
      const bpp = settings.videoCodec === 'prores' ? 3.2 : Math.max(0.02, 0.14 * Math.pow(0.88, settings.quality - 18)) * (settings.videoCodec === 'hevc' ? 0.6 : 1);
      vk = (W * H * (settings.fps ?? seq.fps) * bpp) / 1000;
    }
    if (settings.videoCodec === 'none') vk = 0;
    const ak = settings.audioCodec === 'pcm' ? 1536 : settings.audioCodec === 'none' ? 0 : settings.audioBitrateKbps;
    return ((vk + ak) * secs) / 8 / 1024;
  }, [settings, secs, W, H, seq.fps]);

  const issues = preflight(settings);
  const blocking = issues.some((i) => i.level === 'err');
  const hw = sys?.hwEncoders ?? [];
  const hwOptions: { id: ExportSettings['hardware']; label: string }[] = [{ id: 'none', label: 'Yazılım (en uyumlu)' }];
  if (hw.some((x) => x.includes('nvenc'))) hwOptions.push({ id: 'nvenc', label: 'NVIDIA (NVENC)' });
  if (hw.some((x) => x.includes('qsv'))) hwOptions.push({ id: 'qsv', label: 'Intel (Quick Sync)' });
  if (hw.some((x) => x.includes('amf'))) hwOptions.push({ id: 'amf', label: 'AMD (AMF)' });
  if (hw.some((x) => x.includes('videotoolbox'))) hwOptions.push({ id: 'videotoolbox', label: 'Apple (VideoToolbox)' });

  const run = async () => {
    const out = await window.kurgu.chooseExportPath(name || 'video', ext);
    if (!out) return;
    const st = useStore.getState();
    const s2: ExportSettings = { ...settings, output: out };
    const rangeStart = settings.range === 'inout' ? seq.inPoint ?? 0 : 0;
    if (hasCaptions && burn && settings.videoCodec !== 'none') {
      const b = await prepareBurn(seq, rangeStart);
      if (b) { s2.burnSubtitles = b.ass; s2.subtitlesFontsDir = b.fonts; }
    }
    if (hasCaptions && sidecar) {
      const shifted = seq.captions!.items.map((c) => ({ ...c, start: c.start - rangeStart, end: c.end - rangeStart })).filter((c) => c.end > 0);
      const srtPath = out.replace(/\.[^.\\/]+$/, '.srt');
      await window.kurgu.saveText(srtPath.split(/[\\/]/).pop()!.replace(/\.srt$/, ''), 'srt', toSRT(shifted, seq.fps, fitted(seq.captions!.style, seq.width, seq.height)));
    }
    await window.kurgu.exportSequence({ project: st.project, sequenceId: seq.id, settings: s2, useProxies: false });
    toast('Dışa aktarma başladı — düzenlemeye devam edebilirsiniz', 'info');
  };

  const active = Object.values(jobs).filter((j) => j.kind === 'export');

  return (
    <div className="export-mode">
      <div className="export-side">
        <div>
          <h3>Dosya adı</h3>
          <input className="search" style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <div>
          <h3>Hazır ayar</h3>
          <div className="preset-list">
            {EXPORT_PRESETS.map((p) => (
              <button key={p.id} className={`preset ${presetId === p.id ? 'on' : ''}`} onClick={() => choose(p.id)}>{p.name}</button>
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <h3>Ayarlar</h3>
          <div className="field"><label>Aralık</label>
            <select value={settings.range} onChange={(e) => setSettings({ ...settings, range: e.target.value as 'all' | 'inout' })}>
              <option value="all">Tüm sekans</option><option value="inout">Giriş – Çıkış</option>
            </select></div>
          {settings.videoCodec !== 'none' && (
            <>
              <div className="field"><label>Çözünürlük</label>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="number" value={W} style={{ width: 80 }} onChange={(e) => setSettings({ ...settings, width: Number(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} />×
                  <input type="number" value={H} style={{ width: 80 }} onChange={(e) => setSettings({ ...settings, height: Number(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} />
                </span></div>
              <div className="field"><label>Kare hızı</label>
                <select value={settings.fps ?? seq.fps} onChange={(e) => setSettings({ ...settings, fps: Number(e.target.value) })}>
                  {[...new Set([seq.fps, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60])].map((f) => <option key={f} value={f}>{f}{f === seq.fps ? ' (sekans)' : ''}</option>)}
                </select></div>
              {['h264', 'hevc', 'vp9'].includes(settings.videoCodec) && (
                <>
                  <div className="field"><label>Bit hızı modu</label>
                    <select value={settings.rateControl} onChange={(e) => setSettings({ ...settings, rateControl: e.target.value as 'quality' | 'bitrate' })}>
                      <option value="quality">Sabit kalite</option><option value="bitrate">Hedef bit hızı</option>
                    </select></div>
                  {settings.rateControl === 'quality' ? (
                    <div className="field"><label>Kalite ({settings.quality})</label><input type="range" min={14} max={34} value={settings.quality} style={{ direction: 'rtl' }} onChange={(e) => setSettings({ ...settings, quality: Number(e.target.value) })} /></div>
                  ) : (
                    <div className="field"><label>Video bit hızı (Mbps)</label><input type="number" value={settings.videoBitrateKbps / 1000} onChange={(e) => setSettings({ ...settings, videoBitrateKbps: Number(e.target.value) * 1000 })} onKeyDown={(e) => e.stopPropagation()} /></div>
                  )}
                  <div className="field"><label>Kodlayıcı</label>
                    <select value={settings.hardware} onChange={(e) => setSettings({ ...settings, hardware: e.target.value as ExportSettings['hardware'] })}>
                      {hwOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select></div>
                  {settings.hardware === 'none' && (
                    <div className="field"><label>Hız / sıkıştırma</label>
                      <select value={settings.preset} onChange={(e) => setSettings({ ...settings, preset: e.target.value as ExportSettings['preset'] })}>
                        <option value="ultrafast">En hızlı</option><option value="veryfast">Hızlı</option><option value="medium">Dengeli</option><option value="slow">Küçük dosya (yavaş)</option>
                      </select></div>
                  )}
                </>
              )}
            </>
          )}
          {settings.audioCodec !== 'none' && settings.audioCodec !== 'pcm' && (
            <div className="field"><label>Ses bit hızı</label>
              <select value={settings.audioBitrateKbps} onChange={(e) => setSettings({ ...settings, audioBitrateKbps: Number(e.target.value) })}>
                {[96, 128, 192, 256, 320].map((b) => <option key={b} value={b}>{b} kbps</option>)}
              </select></div>
          )}
          {settings.audioCodec !== 'none' && (
            <div className="field"><label>Ses yüksekliği</label>
              <select value={settings.loudnessTarget ?? ''} onChange={(e) => setSettings({ ...settings, loudnessTarget: e.target.value === '' ? undefined : Number(e.target.value) })}>
                <option value="">Değiştirme</option><option value={-14}>Sosyal medya / YouTube (−14 LUFS)</option><option value={-16}>Podcast (−16 LUFS)</option><option value={-23}>Yayın EBU R128 (−23 LUFS)</option>
              </select></div>
          )}
        </div>
        {hasCaptions && (
          <div style={{ display: 'grid', gap: 6 }}>
            <h3>Altyazı</h3>
            <label className="check"><input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} /> Altyazıyı videoya göm ({seq.captions!.items.length} satır)</label>
            <label className="check"><input type="checkbox" checked={sidecar} onChange={(e) => setSidecar(e.target.checked)} /> Ayrıca .srt dosyası kaydet</label>
          </div>
        )}
        <div>
          <h3>Ön kontrol</h3>
          <div className="preflight">
            {issues.map((i, k) => (
              <div key={k} className={`item ${i.level}`}>
                <span style={{ color: i.level === 'ok' ? 'var(--ok)' : i.level === 'warn' ? 'var(--sel)' : 'var(--err)' }}>{i.level === 'ok' ? I.check : I.warn}</span>
                <span style={{ flex: 1 }}>{i.text}</span>
                {i.fix && <button className="btn small" onClick={i.fix.run}>{i.fix.label}</button>}
              </div>
            ))}
          </div>
        </div>
        <button className="btn primary big" disabled={blocking} onClick={run}>{I.exportI} Dışa aktar</button>
        {active.map((j) => (
          <div key={j.jobId} className="preflight"><div className={`item ${j.error ? 'err' : j.done ? 'ok' : 'warn'}`} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{j.label}</span><b>{Math.round(j.progress * 100)}%</b></div>
            <div className="job"><div className="bar" style={{ width: '100%' }}><div style={{ width: `${j.progress * 100}%` }} /></div></div>
            {j.error && <span style={{ color: 'var(--err)' }}>{j.error}</span>}
            <div style={{ display: 'flex', gap: 6 }}>
              {!j.done && <button className="btn small" onClick={() => window.kurgu.cancelJob(j.jobId)}>İptal</button>}
              {j.done && j.output && !j.error && <button className="btn small" onClick={() => window.kurgu.revealInFolder(j.output!)}>Klasörde göster</button>}
            </div>
          </div></div>
        ))}
      </div>
      <div className="export-preview">
        <ProgramMonitor />
        <div className="summary">
          <div><b>{settings.container.toUpperCase()} · {settings.videoCodec === 'none' ? 'sadece ses' : settings.videoCodec.toUpperCase()}</b><span>Biçim</span></div>
          <div><b>{settings.videoCodec === 'none' ? '—' : `${W}×${H}`}</b><span>Çözünürlük</span></div>
          <div><b>{framesToTimecode(total, seq.fps)}</b><span>Süre</span></div>
          <div><b>~{estMb < 1 ? `${Math.round(estMb * 1024)} KB` : estMb > 1024 ? `${(estMb / 1024).toFixed(1)} GB` : `${Math.round(estMb)} MB`}</b><span>Tahmini boyut</span></div>
        </div>
      </div>
    </div>
  );
}
