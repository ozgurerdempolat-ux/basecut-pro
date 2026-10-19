// Context-menu contents for timeline clips, transitions, lanes, track headers,
// project items and the program monitor.
import { TRANSITIONS } from '../core/fx';
import { AUDIO_TRANSITIONS } from '../core/audiofx';
import { Clip, LabelColor, MediaItem, Track, clipEnd } from '../core/model';
import * as ops from '../core/ops';
import { runCommand } from './App';
import { MenuItem, openMenu } from './ContextMenu';
import { DEFAULT_AUDIO_TRANSITION, DEFAULT_TRANSITION, addTransition, removeTransition } from './Effects';
import { committedSeq, edit, editProject, selectClips, setPlayhead, toast, useStore } from './store';
import { openNested } from './multicam';

const LABEL_NAMES: [LabelColor, string][] = [
  ['violet', 'Menekşe'], ['iris', 'İris'], ['caribbean', 'Karayip'], ['lavender', 'Lavanta'], ['cerulean', 'Gök mavisi'], ['forest', 'Orman'],
  ['rose', 'Gül'], ['mango', 'Mango'], ['purple', 'Mor'], ['blue', 'Mavi'], ['teal', 'Deniz'], ['magenta', 'Eflatun'], ['tan', 'Ten'],
  ['green', 'Yeşil'], ['brown', 'Kahve'], ['yellow', 'Sarı'],
];
type Ev = { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void };
const run = (c: string) => () => runCommand(c);

export function clipMenu(e: Ev, clip: Clip) {
  const st = useStore.getState();
  if (!st.selection.includes(clip.id)) selectClips([clip.id]);
  const sel = useStore.getState().selection;
  const seq = committedSeq();
  const isV = clip.stream === 'video';
  const linked = !!clip.linkId;
  const inside = seq.playhead >= clip.start && seq.playhead < clipEnd(clip);
  const nextTouch = Object.values(seq.clips).some((x) => x.trackId === clip.trackId && x.start === clipEnd(clip));
  const items: MenuItem[] = [
    { label: 'Kes', shortcut: 'Ctrl+X', action: run('cut') },
    { label: 'Kopyala', shortcut: 'Ctrl+C', action: run('copy') },
    { label: 'Yapıştır', shortcut: 'Ctrl+V', action: run('paste'), disabled: !st.clipboard?.length },
    { label: 'Özellikleri Yapıştır…', shortcut: 'Ctrl+Alt+V', action: run('paste-attributes'), disabled: !st.clipboard?.length },
    { label: 'Özellikleri Kaldır…', action: run('remove-attributes') },
    { sep: true },
    { label: 'Sil', shortcut: 'Del', action: () => edit('Sil', (s) => ops.deleteClips(s, sel, st.linkedSelection)), danger: true },
    { label: 'Dalgalı Sil', shortcut: 'Shift+Del', action: () => edit('Dalgalı sil', (s) => ops.rippleDelete(s, sel, st.linkedSelection)), danger: true },
    { sep: true },
    { label: 'Etkin', checked: clip.enabled, shortcut: 'Shift+E', action: run('toggle-enable') },
    { label: linked ? 'Bağlantıyı Kaldır' : 'Bağla', shortcut: 'Ctrl+L', action: run('toggle-link') },
    { label: 'Yeniden Adlandır…', action: run('rename-clip') },
    { label: 'Etiket', submenu: LABEL_NAMES.map(([id, name]) => ({ label: name, checked: clip.label === id, action: () => edit('Etiket', (s) => { for (const x of sel) if (s.clips[x]) s.clips[x].label = id; }) })) },
    { sep: true },
    { label: 'Hız / Süre…', shortcut: 'Ctrl+R', action: run('speed') },
    { label: 'İç İçe Yerleştir (Nest)', action: run('nest') },
    ...(clip.nest || clip.mc ? [{ label: clip.mc ? 'Çoklu kamera kaynağını aç' : 'İç içe sekansı aç', action: () => openNested(clip.id) } as MenuItem] : []),
  ];
  if (isV) items.push(
    { label: 'Kare Dondurma Ekle', action: run('frame-hold'), disabled: !inside },
    { label: 'Kare Dondurma Bölümü Ekle (2 sn)', action: run('frame-hold-segment'), disabled: !inside },
    { label: clip.freeze !== undefined ? 'Dondurmayı Kaldır' : 'Klibin Tamamını Dondur', action: clip.freeze !== undefined ? () => edit('Dondurmayı kaldır', (s) => { delete s.clips[clip.id].freeze; }) : run('frame-hold-whole'), disabled: clip.freeze === undefined && !inside },
  );
  items.push(
    { sep: true },
    { label: isV ? 'Başa geçiş ekle' : 'Başa ses geçişi ekle', action: () => addTransition(clip.id, isV ? DEFAULT_TRANSITION.type : DEFAULT_AUDIO_TRANSITION.type, undefined, 'in') },
    { label: nextTouch ? (isV ? 'Sonraki kesime geçiş ekle' : 'Sonraki kesime crossfade ekle') : isV ? 'Sona kapanış geçişi ekle' : 'Sona ses kısılması ekle', action: () => addTransition(clip.id, isV ? (nextTouch ? DEFAULT_TRANSITION.type : 'black') : DEFAULT_AUDIO_TRANSITION.type, undefined, 'out') },
    { sep: true },
    { label: 'Kareyi Eşle (kaynakta aç)', shortcut: 'F', action: () => { if (!inside) setPlayhead(clip.start); runCommand('match-frame'); } },
    { label: 'Projede Göster', action: run('reveal-in-project') },
    { label: 'Klasörde Göster', action: run('reveal-in-folder') },
  );
  openMenu(e, items);
}

export function transitionMenu(e: Ev, owner: Clip, side: 'in' | 'out', frames: number) {
  const key = `${owner.id}:${side}`;
  useStore.setState({ selection: [owner.id], selTransition: key });
  const audio = owner.stream === 'audio';
  const list = audio ? AUDIO_TRANSITIONS.map((t) => ({ id: t.id, name: t.name, group: 'Ses' })) : TRANSITIONS;
  const groups = [...new Set(list.map((t) => t.group))];
  const setDur = (sec: number) => edit('Geçiş süresi', (s) => { const c = s.clips[owner.id]; const t = side === 'in' ? c?.transIn : c?.transOut; if (t) t.duration = Math.max(2, Math.round(sec * s.fps)); });
  const fps = committedSeq().fps;
  openMenu(e, [
    { label: 'Süre', submenu: [
      ...[0.25, 0.5, 1, 1.5, 2, 3].map((x): MenuItem => ({ label: `${x} sn`, checked: Math.round(x * fps) === frames, action: () => { setDur(x); } })),
      { label: 'Özel…', action: () => { const v = window.prompt('Geçiş süresi (saniye)', (frames / fps).toFixed(2)); const n = v ? Number(v.replace(',', '.')) : NaN; if (Number.isFinite(n) && n > 0) setDur(n); } },
    ] },
    ...groups.map((g): MenuItem => ({ label: groups.length === 1 ? 'Tür' : `Tür › ${g}`, submenu: list.filter((t) => t.group === g).map((t): MenuItem => ({ label: t.name, checked: (side === 'in' ? owner.transIn : owner.transOut)?.type === t.id, action: () => edit('Geçiş türü', (s) => { const c = s.clips[owner.id]; const tr = side === 'in' ? c?.transIn : c?.transOut; if (tr) tr.type = t.id; }) })) })),
    { sep: true },
    { label: 'Varsayılan geçiş yap', action: () => { if (audio) DEFAULT_AUDIO_TRANSITION.type = (side === 'in' ? owner.transIn : owner.transOut)?.type ?? DEFAULT_AUDIO_TRANSITION.type; else DEFAULT_TRANSITION.type = (side === 'in' ? owner.transIn : owner.transOut)?.type ?? DEFAULT_TRANSITION.type; toast('Varsayılan geçiş ayarlandı (Ctrl+D)', 'success'); } },
    { label: 'Geçişi Kaldır', shortcut: 'Del', danger: true, action: () => { removeTransition(key); useStore.setState({ selTransition: null }); } },
  ]);
}

export function laneMenu(e: Ev, track: Track, frame: number) {
  const st = useStore.getState();
  const seq = committedSeq();
  const inGap = !Object.values(seq.clips).some((c) => c.trackId === track.id && frame >= c.start && frame < clipEnd(c));
  openMenu(e, [
    { label: 'Buraya Yapıştır', action: () => { setPlayhead(Math.round(frame)); runCommand('paste'); }, disabled: !st.clipboard?.length },
    { label: 'Boşluğu Kapat (dalgalı sil)', action: () => edit('Boşluğu kapat', (s) => ops.closeGapAt(s, track.id, Math.round(frame))), disabled: !inGap },
    { label: 'Tüm Boşlukları Kapat', action: run('close-gaps') },
    { sep: true },
    { label: 'Oynatma kafasını buraya al', action: () => setPlayhead(Math.round(frame)) },
    { label: 'Buraya marker ekle', shortcut: 'M', action: () => edit('Marker ekle', (s) => { ops.addMarker(s, Math.round(frame)); }) },
    { sep: true },
    { label: 'Video İzi Ekle', action: run('add-video-track') },
    { label: 'Ses İzi Ekle', action: run('add-audio-track') },
  ]);
}

export function trackMenu(e: Ev, track: Track) {
  const seq = committedSeq();
  const same = seq.tracks.filter((t) => t.kind === track.kind);
  const t = (label: string, fn: (x: Track) => void) => () => edit(label, (s) => { const x = s.tracks.find((y) => y.id === track.id); if (x) fn(x); });
  openMenu(e, [
    { label: 'Yeniden Adlandır…', action: () => { const n = window.prompt('İz adı', track.name); if (n && n.trim()) t('İzi adlandır', (x) => { x.name = n.trim(); })(); } },
    { label: 'Hedef İz Yap', action: () => edit('Hedef iz', (s) => ops.targetTrack(s, track.id)) },
    { label: 'Kilitli', checked: track.locked, action: t('İz kilidi', (x) => { x.locked = !x.locked; }) },
    { label: track.kind === 'video' ? 'Görünür' : 'Sesi açık', checked: !track.muted, action: t('İz çıkışı', (x) => { x.muted = !x.muted; }) },
    ...(track.kind === 'audio' ? [{ label: 'Solo', checked: track.solo, action: t('Solo', (x) => { x.solo = !x.solo; }) } as MenuItem] : []),
    { label: 'Yükseklik', submenu: [['Küçük', 34], ['Orta', 56], ['Büyük', 90], ['Çok büyük', 140]].map(([n, h]) => ({ label: n as string, checked: track.height === h, action: t('İz yüksekliği', (x) => { x.height = h as number; }) })) },
    { sep: true },
    { label: track.kind === 'video' ? 'Yukarı Taşı' : 'Yukarı Taşı', action: () => edit('İzi taşı', (s) => ops.moveTrack(s, track.id, track.kind === 'video' ? 1 : -1)) },
    { label: 'Aşağı Taşı', action: () => edit('İzi taşı', (s) => ops.moveTrack(s, track.id, track.kind === 'video' ? -1 : 1)) },
    { sep: true },
    { label: track.kind === 'video' ? 'Video İzi Ekle' : 'Ses İzi Ekle', action: run(track.kind === 'video' ? 'add-video-track' : 'add-audio-track') },
    { label: 'İzi Sil', danger: true, disabled: same.length <= 1, action: () => { try { edit('İzi sil', (s) => ops.deleteTrack(s, track.id)); } catch (err) { toast((err as Error).message, 'error'); } } },
  ]);
}

export function mediaMenu(e: Ev, m: MediaItem, openInSource: () => void) {
  const st = useStore.getState();
  const sel = st.selectedMedia.includes(m.id) ? st.selectedMedia : [m.id];
  if (!st.selectedMedia.includes(m.id)) useStore.setState({ selectedMedia: [m.id] });
  const used = Object.values(st.project.sequences).some((s) => Object.values(s.clips).some((c) => sel.includes(c.mediaId)));
  openMenu(e, [
    { label: 'Kaynak Monitörde Aç', action: openInSource },
    ...(sel.length >= 2 ? [{ label: `Çoklu kamera kaynak sekansı oluştur (${sel.length} açı)…`, action: () => useStore.setState({ dialog: { kind: 'multicam' } }) } as MenuItem] : []),
    { label: 'Sekansa Ekle (oynatma kafasına)', action: () => {
      edit('Sekansa ekle', (s, media) => {
        const t = ops.targetTracks(s);
        let at = s.playhead;
        for (const id of sel) {
          const mm = media[id];
          if (!mm) continue;
          const dur = mm.kind === 'image' ? 5 : mm.duration;
          ops.overwriteEdit(s, { media: mm, srcIn: mm.markIn ?? 0, srcOut: mm.markOut ?? dur }, at, mm.hasVideo ? t.video ?? s.tracks.find((x) => x.kind === 'video')!.id : null, mm.hasAudio ? t.audio ?? s.tracks.find((x) => x.kind === 'audio')!.id : null);
          at += Math.round(((mm.markOut ?? dur) - (mm.markIn ?? 0)) * s.fps);
        }
      });
    } },
    { sep: true },
    { label: 'Yeniden Adlandır…', disabled: sel.length > 1, action: () => { const n = window.prompt('Ad', m.name); if (n && n.trim()) editProject('Yeniden adlandır', (p) => { p.media[m.id].name = n.trim(); }); } },
    { label: 'Etiket', submenu: LABEL_NAMES.map(([id, name]) => ({ label: name, checked: m.label === id, action: () => editProject('Etiket', (p) => { for (const x of sel) if (p.media[x]) p.media[x].label = id; }) })) },
    { label: 'Klasörde Göster', action: () => window.kurgu.revealInFolder(m.path) },
    { sep: true },
    { label: used ? 'Projeden Kaldır (sekanslarda kullanılıyor)' : 'Projeden Kaldır', danger: true, disabled: used, action: () => editProject('Projeden kaldır', (p) => { for (const x of sel) delete p.media[x]; }) },
  ]);
}

export function programMenu(e: Ev) {
  const st = useStore.getState();
  openMenu(e, [
    { label: 'Kareyi Dışa Aktar…', shortcut: 'Ctrl+Shift+E', action: run('export-frame') },
    { label: 'Kareyi Eşle (kaynakta aç)', shortcut: 'F', action: run('match-frame') },
    { sep: true },
    { label: 'Oynatma çözünürlüğü', submenu: ([1, 0.5, 0.25] as const).map((r) => ({ label: r === 1 ? 'Tam' : `1/${1 / r}`, checked: st.playbackRes === r, action: () => useStore.setState({ playbackRes: r }) })) },
    { label: 'Proxy kullan', checked: st.useProxies, action: () => useStore.setState({ useProxies: !st.useProxies }) },
  ]);
}
