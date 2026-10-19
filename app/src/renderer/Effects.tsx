import { useMemo, useState } from 'react';
import { ClipEffect, EFFECTS, EFFECT_BY_ID, FxParamDef, TRANSITIONS, TRANSITION_BY_ID, defaultParams } from '../core/fx';
import { AUDIO_EFFECTS, AUDIO_FX_BY_ID, AUDIO_TRANSITIONS, AudioEffect, AudioFxParam, defaultAudioParams } from '../core/audiofx';
import { Clip, Sequence, clipEnd, framesToTimecode, newId } from '../core/model';
import { I } from './icons';
import { stabilizedSource } from '../core/stabilize';
import { retryStabilize, stabStatus } from './stabilizer';
import { HotNumber } from './Panels';
import { activeSeq, committedSeq, edit, toast, useStore } from './store';

export const FX_MIME = 'application/x-kurgu-fx';
export type FxDrag = { kind: 'effect' | 'transition' | 'afx' | 'atrans'; id: string };
export type Side = 'in' | 'out';

const transName = (type: string) => TRANSITION_BY_ID[type]?.name ?? AUDIO_TRANSITIONS.find((t) => t.id === type)?.name ?? type;

export const DEFAULT_TRANSITION = { type: 'cross', seconds: 1 };
export const DEFAULT_AUDIO_TRANSITION = { type: 'constant-power', seconds: 1 };

// ------------------------------------------------------------------ actions

export function addEffect(clipIds: string[], type: string) {
  const def = EFFECT_BY_ID[type];
  if (!def) return;
  let n = 0;
  edit(`Efekt: ${def.name}`, (s) => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c || c.stream !== 'video') continue;
      const list = c.effects ?? (c.effects = []);
      // one background fill per clip is enough
      if ((def.kind === 'blurfill' || def.kind === 'stabilize') && list.some((e) => e.type === type)) continue;
      list.push({ id: newId('fx'), type, enabled: true, params: defaultParams(type) });
      n++;
    }
  });
  if (!n) toast('Efekt eklemek için timeline\'da bir video klibi seçin', 'error');
  else { useStore.setState({ leftTab: 'fx' }); toast(`${def.name} eklendi`, 'success'); }
}

const neighbourAfter = (seq: Sequence, c: Clip) => Object.values(seq.clips).find((x) => x.trackId === c.trackId && x.stream === c.stream && x.id !== c.id && x.start === clipEnd(c)) ?? null;
const neighbourBefore = (seq: Sequence, c: Clip) => Object.values(seq.clips).find((x) => x.trackId === c.trackId && x.stream === c.stream && x.id !== c.id && clipEnd(x) === c.start) ?? null;

/**
 * Put a transition at the head ('in') or tail ('out') of a clip. A tail that
 * touches another clip is that clip's cut, so it is stored as the neighbour's
 * head transition (one transition per cut). A tail with nothing after it is a
 * fade/dissolve out — e.g. the film's closing dissolve to black.
 */
export function addTransition(clipId: string, type: string, frames?: number, side: Side = 'in') {
  let target: { id: string; side: Side } | null = null;
  edit(`Geçiş: ${transName(type)}`, (s) => {
    let c = s.clips[clipId];
    if (!c) return;
    let sd = side;
    if (sd === 'out') { const n = neighbourAfter(s, c); if (n) { c = s.clips[n.id]; sd = 'in'; } }
    const secs = c.stream === 'audio' ? DEFAULT_AUDIO_TRANSITION.seconds : DEFAULT_TRANSITION.seconds;
    const d = frames ?? Math.round(s.fps * secs);
    const spec = { type, duration: Math.max(2, Math.min(d, c.duration * 2)) };
    if (sd === 'in') c.transIn = spec; else c.transOut = spec;
    target = { id: c.id, side: sd };
  });
  if (target) {
    const t = target as { id: string; side: Side };
    useStore.setState({ selection: [t.id], selTransition: `${t.id}:${t.side}`, leftTab: 'fx' });
  }
}

export function removeTransition(key: string) {
  const i = key.lastIndexOf(':');
  const id = i > 0 ? key.slice(0, i) : key;
  const side = key.slice(i + 1) === 'out' ? 'out' : 'in';
  edit('Geçişi kaldır', (s) => { const c = s.clips[id]; if (!c) return; if (side === 'out') delete c.transOut; else delete c.transIn; });
}

/** every place a transition can go on the given tracks: each clip head, and each free tail */
function editPointsFor(seq: Sequence, stream: 'video' | 'audio', trackIds: string[]): { clip: Clip; side: Side; at: number }[] {
  const out: { clip: Clip; side: Side; at: number }[] = [];
  for (const c of Object.values(seq.clips)) {
    if (c.stream !== stream || !trackIds.includes(c.trackId)) continue;
    out.push({ clip: c, side: 'in', at: c.start });
    if (!neighbourAfter(seq, c)) out.push({ clip: c, side: 'out', at: clipEnd(c) });
  }
  return out;
}

function applyDefaultAt(stream: 'video' | 'audio') {
  const st = useStore.getState();
  const seq = committedSeq(st);
  const type = stream === 'video' ? DEFAULT_TRANSITION.type : DEFAULT_AUDIO_TRANSITION.type;
  const sel = st.selection.map((id) => seq.clips[id]).filter((c): c is Clip => !!c && c.stream === stream);
  if (sel.length) {
    // like Premiere: selected clips get the default transition at both ends
    for (const c of sel) {
      addTransition(c.id, type, undefined, 'in');
      addTransition(c.id, type, undefined, 'out');
    }
    useStore.setState({ selection: sel.map((c) => c.id) });
    return;
  }
  const kindTracks = seq.tracks.filter((t) => t.kind === stream);
  const targeted = kindTracks.filter((t) => t.targeted);
  const tracks = (targeted.length ? targeted : kindTracks).map((t) => t.id);
  let best: { clip: Clip; side: Side; at: number } | null = null;
  for (const p of editPointsFor(seq, stream, tracks)) if (!best || Math.abs(p.at - seq.playhead) < Math.abs(best.at - seq.playhead)) best = p;
  if (!best) { toast('Geçiş eklenecek kesim bulunamadı', 'error'); return; }
  addTransition(best.clip.id, type, undefined, best.side);
}

/** Ctrl+D: video transition at the edit point nearest the playhead (cut, clip head or clip end) — or both ends of the selected clips */
export function applyDefaultTransition() { applyDefaultAt('video'); }
/** Ctrl+Shift+D: audio crossfade / fade the same way */
export function applyDefaultAudioTransition() { applyDefaultAt('audio'); }

// ------------------------------------------------------------------ audio effects

export function addAudioEffect(clipIds: string[], type: string) {
  const def = AUDIO_FX_BY_ID[type];
  if (!def) return;
  let n = 0;
  edit(`Ses efekti: ${def.name}`, (s) => {
    for (const id of clipIds) {
      const c = s.clips[id];
      if (!c || c.stream !== 'audio') continue;
      (c.audioFx ?? (c.audioFx = [])).push({ id: newId('afx'), type, enabled: true, params: defaultAudioParams(type) });
      n++;
    }
  });
  if (!n) toast('Ses efekti eklemek için timeline\'da bir ses klibi seçin', 'error');
  else { useStore.setState({ leftTab: 'fx' }); toast(`${def.name} eklendi`, 'success'); }
}

// ------------------------------------------------------------------ library panel

export function EffectsLibrary() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ trans: true, fx: true, atrans: true, afx: true });
  const query = q.trim().toLocaleLowerCase('tr-TR');
  const trans = TRANSITIONS.filter((t) => !query || t.name.toLocaleLowerCase('tr-TR').includes(query));
  const fx = EFFECTS.filter((e) => !query || e.name.toLocaleLowerCase('tr-TR').includes(query) || e.category.toLocaleLowerCase('tr-TR').includes(query));
  const has = (s: string) => !query || s.toLocaleLowerCase('tr-TR').includes(query);
  const atrans = AUDIO_TRANSITIONS.filter((t) => has(t.name) || has('ses geçiş crossfade'));
  const afx = AUDIO_EFFECTS.filter((e) => has(e.name) || has(e.category) || has('ses'));
  const aGroups = useMemo(() => {
    const m = new Map<string, typeof afx>();
    for (const e of afx) { if (!m.has(e.category)) m.set(e.category, []); m.get(e.category)!.push(e); }
    return [...m.entries()];
  }, [afx]);
  const groups = useMemo(() => {
    const m = new Map<string, typeof fx>();
    for (const e of fx) { if (!m.has(e.category)) m.set(e.category, []); m.get(e.category)!.push(e); }
    return [...m.entries()];
  }, [fx]);
  const tGroups = useMemo(() => {
    const m = new Map<string, typeof trans>();
    for (const t of trans) { if (!m.has(t.group)) m.set(t.group, []); m.get(t.group)!.push(t); }
    return [...m.entries()].sort((x, y) => (y[0].startsWith('Impact') ? 1 : 0) - (x[0].startsWith('Impact') ? 1 : 0));
  }, [trans]);

  const item = (kind: FxDrag['kind'], id: string, name: string, desc?: string) => (
    <div key={id} className="fx-item" draggable title={`${desc ? `${desc}\n` : ''}Timeline'a sürükleyin veya çift tıklayın`}
      onDragStart={(e) => { e.dataTransfer.setData(FX_MIME, JSON.stringify({ kind, id } satisfies FxDrag)); e.dataTransfer.effectAllowed = 'copy'; }}
      onDoubleClick={() => {
        const st = useStore.getState();
        const seq = committedSeq(st);
        const stream = kind === 'effect' || kind === 'transition' ? 'video' : 'audio';
        const sel = st.selection.filter((x) => seq.clips[x]?.stream === stream);
        if (kind === 'effect') addEffect(sel, id);
        else if (kind === 'afx') addAudioEffect(sel, id);
        else {
          const D = kind === 'transition' ? DEFAULT_TRANSITION : DEFAULT_AUDIO_TRANSITION;
          const prev = D.type; D.type = id;
          try { applyDefaultAt(stream); } finally { D.type = prev; }
        }
      }}>
      <span className={`fx-badge ${kind === 'afx' ? 'effect audio' : kind === 'atrans' ? 'transition audio' : kind}`}>{kind === 'effect' || kind === 'afx' ? 'fx' : '⇄'}</span>{name}
    </div>
  );

  return (
    <div className="panel-body">
      <div className="proj-toolbar"><input className="search" placeholder="Efekt veya geçiş ara…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
      <div className="fx-group">
        <div className="gh" onClick={() => setOpen({ ...open, trans: !open.trans })}><span style={{ color: 'var(--text-3)' }}>{open.trans ? '▾' : '▸'}</span>Video geçişleri <span className="pill">{trans.length}</span></div>
        {open.trans && tGroups.map(([g, list]) => (
          <div key={g}><div className="fx-cat">{g}</div>{list.map((t) => item('transition', t.id, t.name, t.desc))}</div>
        ))}
      </div>
      <div className="fx-group">
        <div className="gh" onClick={() => setOpen({ ...open, fx: !open.fx })}><span style={{ color: 'var(--text-3)' }}>{open.fx ? '▾' : '▸'}</span>Video efektleri <span className="pill">{fx.length}</span></div>
        {open.fx && groups.map(([g, list]) => (
          <div key={g}><div className="fx-cat">{g}</div>{list.map((e) => item('effect', e.id, e.name, e.desc))}</div>
        ))}
      </div>
      <div className="fx-group">
        <div className="gh" onClick={() => setOpen({ ...open, atrans: !open.atrans })}><span style={{ color: 'var(--text-3)' }}>{open.atrans ? '▾' : '▸'}</span>Ses geçişleri <span className="pill">{atrans.length}</span></div>
        {open.atrans && <div><div className="fx-cat">Çapraz geçiş</div>{atrans.map((t) => item('atrans', t.id, t.name))}</div>}
      </div>
      <div className="fx-group">
        <div className="gh" onClick={() => setOpen({ ...open, afx: !open.afx })}><span style={{ color: 'var(--text-3)' }}>{open.afx ? '▾' : '▸'}</span>Ses efektleri <span className="pill">{afx.length}</span></div>
        {open.afx && aGroups.map(([g, list]) => (
          <div key={g}><div className="fx-cat">{g}</div>{list.map((e) => item('afx', e.id, e.name, e.desc))}</div>
        ))}
      </div>
      <div style={{ padding: 10, color: 'var(--text-3)', lineHeight: 1.5 }}>
        İpucu: Geçişi iki klibin birleştiği yere, bir klibin <b>başına</b> ya da <b>sonuna</b> bırakın — sona bırakılan geçiş kapanış olur (ör. siyaha film geçişi).
        {' '}<span className="kbd">Ctrl+D</span> oynatma kafasına en yakın noktaya video geçişi, <span className="kbd">Ctrl+Shift+D</span> ses geçişi ekler; klip seçiliyse iki ucuna birden.
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ effect controls sections

export function TransitionControls({ clip, seq }: { clip: Clip; seq: Sequence }) {
  const sel = useStore((st) => st.selTransition);
  return (
    <>
      <TransitionSideControls clip={clip} seq={seq} side="in" selected={sel === `${clip.id}:in`} />
      <TransitionSideControls clip={clip} seq={seq} side="out" selected={sel === `${clip.id}:out`} />
    </>
  );
}

function TransitionSideControls({ clip, seq, side, selected }: { clip: Clip; seq: Sequence; side: Side; selected: boolean }) {
  const tr = side === 'in' ? clip.transIn : clip.transOut;
  const audio = clip.stream === 'audio';
  const list = audio ? AUDIO_TRANSITIONS.map((t) => ({ id: t.id, name: t.name })) : TRANSITIONS.map((t) => ({ id: t.id, name: t.name }));
  if (!tr) {
    // offer the tail fade only where there is nothing after the clip (otherwise it is the next clip's head)
    if (side === 'out' && neighbourAfter(seq, clip)) return null;
    if (side === 'in') return null;
    return (
      <div style={{ padding: '4px 10px' }}>
        <button className="btn small" onClick={() => addTransition(clip.id, audio ? DEFAULT_AUDIO_TRANSITION.type : 'fadeblack', undefined, 'out')}>
          ⇄ {audio ? 'Sona ses kısılması ekle' : 'Sona kapanış geçişi ekle (siyaha)'}
        </button>
      </div>
    );
  }
  const set = (patch: Partial<NonNullable<Clip['transIn']>>) => edit('Geçişi düzenle', (s) => {
    const c = s.clips[clip.id];
    const t = side === 'in' ? c.transIn : c.transOut;
    if (t) Object.assign(t, patch);
  });
  const neighbour = side === 'in' ? neighbourBefore(seq, clip) : neighbourAfter(seq, clip);
  const label = side === 'in' ? (neighbour ? 'Geçiş (kesimde, başta)' : 'Açılış geçişi (başta)') : (neighbour ? 'Geçiş (kesimde, sonda)' : 'Kapanış geçişi (sonda)');
  return (
    <div className={`fx-group ${selected ? 'sel' : ''}`}>
      <div className="gh"><span className={`fx-badge transition ${audio ? 'audio' : ''}`}>⇄</span>{label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: 6, padding: '3px 10px', alignItems: 'center' }}>
        <span style={{ color: 'var(--text-2)' }}>Tür</span>
        <select className="mini" value={tr.type} onChange={(e) => set({ type: e.target.value })}>
          {!list.some((t) => t.id === tr.type) && <option value={tr.type}>{transName(tr.type)}</option>}
          {list.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <span style={{ color: 'var(--text-2)' }}>Süre</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <HotNumber value={tr.duration / seq.fps} step={0.02} unit="sn" onCommit={(v) => set({ duration: Math.max(2, Math.round(v * seq.fps)) })} />
          <span style={{ color: 'var(--text-3)', font: '11px var(--mono)' }}>{framesToTimecode(tr.duration, seq.fps)}</span>
        </span>
      </div>
      <div style={{ padding: '2px 10px 8px' }}><button className="btn small" onClick={() => removeTransition(`${clip.id}:${side}`)}>{I.close} Geçişi kaldır</button></div>
    </div>
  );
}

export function AudioEffectStack({ clip }: { clip: Clip }) {
  const list = clip.audioFx ?? [];
  if (!list.length) return null;
  const mutate = (label: string, fn: (l: AudioEffect[]) => void) => edit(label, (s) => { const c = s.clips[clip.id]; c.audioFx = c.audioFx ?? []; fn(c.audioFx); });
  return (
    <>
      {list.map((e, i) => {
        const def = AUDIO_FX_BY_ID[e.type];
        if (!def) return null;
        return (
          <div key={e.id} className="fx-group">
            <div className="gh" style={{ gap: 4 }}>
              <input type="checkbox" checked={e.enabled} title="Efekti aç/kapat" onChange={(ev) => mutate('Ses efektini aç/kapat', (l) => { l[i].enabled = ev.target.checked; })} onClick={(ev) => ev.stopPropagation()} />
              <span className="fx-badge effect audio">fx</span><span style={{ flex: 1 }} title={def.desc}>{def.name}</span>
              <button className="icon-btn" title="Yukarı" disabled={i === 0} onClick={() => mutate('Ses efekti sırası', (l) => { [l[i - 1], l[i]] = [l[i], l[i - 1]]; })}>↑</button>
              <button className="icon-btn" title="Aşağı" disabled={i === list.length - 1} onClick={() => mutate('Ses efekti sırası', (l) => { [l[i + 1], l[i]] = [l[i], l[i + 1]]; })}>↓</button>
              <button className="icon-btn" title="Sıfırla" onClick={() => mutate('Ses efektini sıfırla', (l) => { l[i].params = defaultAudioParams(e.type); })}>{I.reset}</button>
              <button className="icon-btn" title="Kaldır" onClick={() => mutate('Ses efektini kaldır', (l) => { l.splice(i, 1); })}>{I.close}</button>
            </div>
            {def.params.map((p) => <AudioParam key={p.key} def={p} value={e.params[p.key] ?? p.def} onChange={(v) => mutate(`${def.name}: ${p.label}`, (l) => { l[i].params[p.key] = v; })} />)}
            {def.approxPreview && <div style={{ padding: '0 10px 6px 28px', color: 'var(--text-3)', fontSize: 11 }}>Önizlemede yaklaşık; tam etkisi dışa aktarımda.</div>}
          </div>
        );
      })}
    </>
  );
}

function AudioParam({ def, value, onChange }: { def: AudioFxParam; value: number; onChange: (v: number) => void }) {
  return (
    <div className="fx-row"><span /><span className="lbl">{def.label}</span>
      <HotNumber value={value} step={def.step} unit={def.unit?.trim()} onCommit={(v) => onChange(Math.max(def.min, Math.min(def.max, def.step >= 1 ? Math.round(v) : v)))} />
      <span /></div>
  );
}

export function EffectStack({ clip }: { clip: Clip }) {
  const list = clip.effects ?? [];
  if (!list.length) return null;
  const mutate = (label: string, fn: (l: ClipEffect[]) => void) => edit(label, (s) => { const c = s.clips[clip.id]; c.effects = c.effects ?? []; fn(c.effects); });
  return (
    <>
      {list.map((e, i) => {
        const def = EFFECT_BY_ID[e.type];
        if (!def) return null;
        return (
          <div key={e.id} className="fx-group">
            <div className="gh" style={{ gap: 4 }}>
              <input type="checkbox" checked={e.enabled} title="Efekti aç/kapat" onChange={(ev) => mutate('Efekti aç/kapat', (l) => { l[i].enabled = ev.target.checked; })} onClick={(ev) => ev.stopPropagation()} />
              <span className="fx-badge effect">fx</span><span style={{ flex: 1 }}>{def.name}</span>
              <button className="icon-btn" title="Yukarı" disabled={i === 0} onClick={() => mutate('Efekt sırası', (l) => { [l[i - 1], l[i]] = [l[i], l[i - 1]]; })}>↑</button>
              <button className="icon-btn" title="Aşağı" disabled={i === list.length - 1} onClick={() => mutate('Efekt sırası', (l) => { [l[i + 1], l[i]] = [l[i], l[i + 1]]; })}>↓</button>
              <button className="icon-btn" title="Sıfırla" onClick={() => mutate('Efekti sıfırla', (l) => { l[i].params = defaultParams(e.type); })}>{I.reset}</button>
              <button className="icon-btn" title="Kaldır" onClick={() => mutate('Efekti kaldır', (l) => { l.splice(i, 1); })}>{I.close}</button>
            </div>
            {def.params.filter((p) => !(e.type === 'warpstab' && p.key === 'smooth' && (e.params.mode ?? 0) === 1)).map((p) => <FxParam key={p.key} def={p} value={e.params[p.key] ?? p.def} onChange={(v) => mutate(`${def.name}: ${p.label}`, (l) => { l[i].params[p.key] = v; })} />)}
            {def.kind === 'stabilize' && <StabStatusLine clip={clip} />}
          </div>
        );
      })}
    </>
  );
}

function FxParam({ def, value, onChange }: { def: FxParamDef; value: number; onChange: (v: number) => void }) {
  if (def.options) {
    return (
      <div className="fx-row"><span /><span className="lbl">{def.label}</span>
        <select className="mini" value={Math.round(value)} onChange={(e) => onChange(Number(e.target.value))}>{def.options.map((o, i) => <option key={o} value={i}>{o}</option>)}</select><span /></div>
    );
  }
  if (def.color) {
    const hex = `#${Math.round(value).toString(16).padStart(6, '0')}`;
    return (
      <div className="fx-row"><span /><span className="lbl">{def.label}</span>
        <input type="color" value={hex} onChange={(e) => onChange(parseInt(e.target.value.slice(1), 16))} /><span /></div>
    );
  }
  return (
    <div className="fx-row"><span /><span className="lbl">{def.label}</span>
      <HotNumber value={value} step={def.step} unit={def.unit} onCommit={(v) => onChange(Math.max(def.min, Math.min(def.max, def.step >= 1 ? Math.round(v) : v)))} />
      <span /></div>
  );
}

/** where a transition dropped at `frame` on a lane goes: a cut, a clip head or a clip tail */
export function transitionTarget(seq: Sequence, trackId: string, frame: number, tolerance: number, stream: 'video' | 'audio' = 'video'): { clip: Clip; side: Side } | null {
  const clips = Object.values(seq.clips).filter((c) => c.trackId === trackId && c.stream === stream).sort((a, b) => a.start - b.start);
  let best: { clip: Clip; side: Side } | null = null;
  let bestD = Infinity;
  for (const c of clips) {
    const d = Math.abs(c.start - frame);
    if (d < bestD) { bestD = d; best = { clip: c, side: 'in' }; }
    const de = Math.abs(clipEnd(c) - frame);
    if (de < bestD) {
      const nx = clips.find((x) => x.start === clipEnd(c));
      bestD = de;
      best = nx ? { clip: nx, side: 'in' } : { clip: c, side: 'out' };
    }
  }
  if (best && bestD <= tolerance) return best;
  // otherwise the clip under the cursor: the nearer end
  const under = clips.find((c) => frame >= c.start && frame < clipEnd(c));
  if (!under) return null;
  return frame - under.start <= clipEnd(under) - frame ? { clip: under, side: 'in' } : { clip: under, side: 'out' };
}

function StabStatusLine({ clip }: { clip: Clip }) {
  useStore((s) => s.stabTick);
  const seq = useStore((s) => activeSeq(s));
  const m = useStore((s) => s.project.media[clip.mediaId]);
  const st = stabStatus.get(clip.id);
  const ok = m && stabilizedSource(clip, m, seq.fps);
  let text: string, cls = '';
  if (!m || m.kind !== 'video') { text = 'Sabitleyici yalnızca video kliplerde çalışır.'; cls = 'err'; }
  else if (ok) { text = '✓ Sabitlendi — önizleme ve dışa aktarım aynı sonucu kullanıyor.'; cls = 'ok'; }
  else if (st?.state === 'running') text = st.progress < 0.01 ? 'Analiz başlıyor…' : `Arka planda analiz ediliyor… %${Math.round(st.progress * 100)}`;
  else if (st?.state === 'error') { text = `Hata: ${st.error}`; cls = 'err'; }
  else text = 'Sırada — birazdan başlayacak.';
  return (
    <div className={`stab-status ${cls}`}>
      {text}
      {st?.state === 'running' && <div className="stab-bar"><div style={{ width: `${Math.round(st.progress * 100)}%` }} /></div>}
      {st?.state === 'error' && <button className="btn small" onClick={retryStabilize}>Tekrar dene</button>}
    </div>
  );
}
