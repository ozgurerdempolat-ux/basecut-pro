import { useMemo, useState } from 'react';
import { ClipEffect, EFFECTS, EFFECT_BY_ID, FxParamDef, TRANSITIONS, TRANSITION_BY_ID, defaultParams } from '../core/fx';
import { Clip, Sequence, clipEnd, framesToTimecode, newId } from '../core/model';
import { I } from './icons';
import { HotNumber } from './Panels';
import { activeSeq, committedSeq, edit, toast, useStore } from './store';

export const FX_MIME = 'application/x-kurgu-fx';
export type FxDrag = { kind: 'effect' | 'transition'; id: string };

export const DEFAULT_TRANSITION = { type: 'cross', seconds: 1 };

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
      if (def.kind === 'blurfill' && list.some((e) => e.type === 'blurfill')) continue;
      list.push({ id: newId('fx'), type, enabled: true, params: defaultParams(type) });
      n++;
    }
  });
  if (!n) toast('Efekt eklemek için timeline\'da bir video klibi seçin', 'error');
  else { useStore.setState({ leftTab: 'fx' }); toast(`${def.name} eklendi`, 'success'); }
}

/** put a transition at the head of `clipId` (two-sided if a clip ends right there) */
export function addTransition(clipId: string, type: string, frames?: number) {
  edit(`Geçiş: ${TRANSITION_BY_ID[type]?.name ?? type}`, (s) => {
    const c = s.clips[clipId];
    if (!c) return;
    const d = frames ?? Math.round(s.fps * DEFAULT_TRANSITION.seconds);
    c.transIn = { type, duration: Math.max(2, Math.min(d, c.duration * 2)) };
  });
  useStore.setState({ selection: [clipId], leftTab: 'fx' });
}

/** Ctrl+D: transition at the cut nearest the playhead on the targeted video track (or the selected clip) */
export function applyDefaultTransition() {
  const st = useStore.getState();
  const seq = committedSeq(st);
  const sel = st.selection.map((id) => seq.clips[id]).find((c) => c && c.stream === 'video');
  if (sel) { addTransition(sel.id, DEFAULT_TRANSITION.type); return; }
  const tracks = seq.tracks.filter((t) => t.kind === 'video' && (t.targeted || !seq.tracks.some((x) => x.kind === 'video' && x.targeted)));
  let best: Clip | null = null;
  for (const c of Object.values(seq.clips)) {
    if (c.stream !== 'video' || !tracks.some((t) => t.id === c.trackId)) continue;
    if (!best || Math.abs(c.start - seq.playhead) < Math.abs(best.start - seq.playhead)) best = c;
  }
  if (!best) { toast('Geçiş eklenecek kesim bulunamadı', 'error'); return; }
  addTransition(best.id, DEFAULT_TRANSITION.type);
}

// ------------------------------------------------------------------ library panel

export function EffectsLibrary() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ trans: true, fx: true });
  const query = q.trim().toLocaleLowerCase('tr-TR');
  const trans = TRANSITIONS.filter((t) => !query || t.name.toLocaleLowerCase('tr-TR').includes(query));
  const fx = EFFECTS.filter((e) => !query || e.name.toLocaleLowerCase('tr-TR').includes(query) || e.category.toLocaleLowerCase('tr-TR').includes(query));
  const groups = useMemo(() => {
    const m = new Map<string, typeof fx>();
    for (const e of fx) { if (!m.has(e.category)) m.set(e.category, []); m.get(e.category)!.push(e); }
    return [...m.entries()];
  }, [fx]);
  const tGroups = useMemo(() => {
    const m = new Map<string, typeof trans>();
    for (const t of trans) { if (!m.has(t.group)) m.set(t.group, []); m.get(t.group)!.push(t); }
    return [...m.entries()];
  }, [trans]);

  const item = (kind: FxDrag['kind'], id: string, name: string, desc?: string) => (
    <div key={id} className="fx-item" draggable title={`${desc ? `${desc}\n` : ''}Timeline'a sürükleyin veya çift tıklayın`}
      onDragStart={(e) => { e.dataTransfer.setData(FX_MIME, JSON.stringify({ kind, id } satisfies FxDrag)); e.dataTransfer.effectAllowed = 'copy'; }}
      onDoubleClick={() => {
        const st = useStore.getState();
        const seq = committedSeq(st);
        const sel = st.selection.filter((x) => seq.clips[x]?.stream === 'video');
        if (kind === 'effect') addEffect(sel, id);
        else if (sel.length) for (const s of sel) addTransition(s, id);
        else { const prev = DEFAULT_TRANSITION.type; DEFAULT_TRANSITION.type = id; applyDefaultTransition(); DEFAULT_TRANSITION.type = prev; }
      }}>
      <span className={`fx-badge ${kind}`}>{kind === 'effect' ? 'fx' : '⇄'}</span>{name}
    </div>
  );

  return (
    <div className="panel-body">
      <div className="proj-toolbar"><input className="search" placeholder="Efekt veya geçiş ara…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
      <div className="fx-group">
        <div className="gh" onClick={() => setOpen({ ...open, trans: !open.trans })}><span style={{ color: 'var(--text-3)' }}>{open.trans ? '▾' : '▸'}</span>Video geçişleri <span className="pill">{trans.length}</span></div>
        {open.trans && tGroups.map(([g, list]) => (
          <div key={g}><div className="fx-cat">{g}</div>{list.map((t) => item('transition', t.id, t.name))}</div>
        ))}
      </div>
      <div className="fx-group">
        <div className="gh" onClick={() => setOpen({ ...open, fx: !open.fx })}><span style={{ color: 'var(--text-3)' }}>{open.fx ? '▾' : '▸'}</span>Video efektleri <span className="pill">{fx.length}</span></div>
        {open.fx && groups.map(([g, list]) => (
          <div key={g}><div className="fx-cat">{g}</div>{list.map((e) => item('effect', e.id, e.name, e.desc))}</div>
        ))}
      </div>
      <div style={{ padding: 10, color: 'var(--text-3)' }}>İpucu: Geçişi iki klibin birleştiği yere bırakın. <span className="kbd">Ctrl+D</span> oynatma kafasındaki kesime çapraz geçiş ekler.</div>
    </div>
  );
}

// ------------------------------------------------------------------ effect controls sections

export function TransitionControls({ clip, seq }: { clip: Clip; seq: Sequence }) {
  const tr = clip.transIn;
  if (!tr) return null;
  const set = (patch: Partial<NonNullable<Clip['transIn']>>) => edit('Geçişi düzenle', (s) => { const c = s.clips[clip.id]; if (c.transIn) Object.assign(c.transIn, patch); });
  return (
    <div className="fx-group">
      <div className="gh"><span className="fx-badge transition">⇄</span>Geçiş (başta)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: 6, padding: '3px 10px', alignItems: 'center' }}>
        <span style={{ color: 'var(--text-2)' }}>Tür</span>
        <select className="mini" value={tr.type} onChange={(e) => set({ type: e.target.value })}>{TRANSITIONS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <span style={{ color: 'var(--text-2)' }}>Süre</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <HotNumber value={tr.duration / seq.fps} step={0.02} unit="sn" onCommit={(v) => set({ duration: Math.max(2, Math.round(v * seq.fps)) })} />
          <span style={{ color: 'var(--text-3)', font: '11px var(--mono)' }}>{framesToTimecode(tr.duration, seq.fps)}</span>
        </span>
      </div>
      <div style={{ padding: '2px 10px 8px' }}><button className="btn small" onClick={() => edit('Geçişi kaldır', (s) => { delete s.clips[clip.id].transIn; })}>{I.close} Geçişi kaldır</button></div>
    </div>
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
            {def.params.map((p) => <FxParam key={p.key} def={p} value={e.params[p.key] ?? p.def} onChange={(v) => mutate(`${def.name}: ${p.label}`, (l) => { l[i].params[p.key] = v; })} />)}
          </div>
        );
      })}
    </>
  );
}

function FxParam({ def, value, onChange }: { def: FxParamDef; value: number; onChange: (v: number) => void }) {
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

/** find the clip whose head a transition dropped at (clientX on a lane) belongs to */
export function transitionTarget(seq: Sequence, trackId: string, frame: number, tolerance: number): Clip | null {
  const clips = Object.values(seq.clips).filter((c) => c.trackId === trackId && c.stream === 'video').sort((a, b) => a.start - b.start);
  let best: Clip | null = null;
  let bestD = Infinity;
  for (const c of clips) {
    const d = Math.abs(c.start - frame);
    if (d < bestD) { bestD = d; best = c; }
    // dropping near the end of a clip that has a neighbour → the neighbour's head
    const de = Math.abs(clipEnd(c) - frame);
    if (de < bestD) { const nx = clips.find((x) => x.start === clipEnd(c)); if (nx) { bestD = de; best = nx; } }
  }
  if (best && bestD <= tolerance) return best;
  // otherwise: the clip under the cursor, at its head
  return clips.find((c) => frame >= c.start && frame < clipEnd(c)) ?? null;
}

void activeSeq;
