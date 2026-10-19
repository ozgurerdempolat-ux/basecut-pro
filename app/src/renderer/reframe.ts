// Auto Reframe Sequence: a copy of the active sequence at a new aspect ratio,
// every shot following its subject with Position keyframes.
import { REFRAME_PRESETS, reframeKeyframes, reframeRange, smoothPath } from '../core/reframe';
import { MediaItem, newId } from '../core/model';
import { fitted, groupWords } from '../core/captions';
import { renderTitleFile } from './titles';
import { committedSeq, editProject, toast, useStore } from './store';

export async function reframeSequence(presetId: string, speed: number): Promise<string | null> {
  const preset = REFRAME_PRESETS.find((p) => p.id === presetId)!;
  const st = useStore.getState();
  const src = committedSeq(st);
  // keep the sequence's resolution class: 1080 wide verticals from a 1080p edit, 4K stays 4K
  const k = Math.max(src.width, src.height) / 1920;
  const target = { width: Math.round((preset.w * k) / 2) * 2, height: Math.round((preset.h * k) / 2) * 2 };
  const media = st.project.media;
  const vclips = Object.values(src.clips).filter((c) => c.stream === 'video' && media[c.mediaId]?.kind === 'video' && !media[c.mediaId]?.synthetic);
  const paths = new Map<string, { t: number; x: number }[]>();
  let done = 0;
  for (const c of vclips) {
    const m = media[c.mediaId];
    const range = reframeRange(c, src.fps);
    try {
      const samples = await window.kurgu.reframeAnalyze({ path: m.path, range, perSecond: 4, width: m.width, height: m.height, label: `Yeniden kadraj: ${c.name} (${++done}/${vclips.length})` });
      const xs = smoothPath(samples, speed, 0.04);
      paths.set(c.id, samples.map((s, i) => ({ t: s.t, x: xs[i] })));
    } catch (e) {
      toast(`${c.name} analiz edilemedi: ${(e as Error).message.split('\n')[0]}`, 'error');
    }
  }
  // titles: re-render at the new frame size so text stays the same size on screen
  const titleMap = new Map<string, MediaItem>();
  for (const c of Object.values(src.clips)) {
    const m = media[c.mediaId];
    if (!m?.title || titleMap.has(m.id)) continue;
    const path = await renderTitleFile(m.title, target.width, target.height);
    titleMap.set(m.id, { ...m, id: newId('m'), path, width: target.width, height: target.height });
  }
  const id = newId('seq');
  editProject(`Otomatik yeniden kadraj (${preset.id})`, (p) => {
    const s = JSON.parse(JSON.stringify(src)) as typeof src;
    s.id = id;
    s.name = `${src.name} (${preset.id})`;
    s.width = target.width; s.height = target.height;
    for (const t of titleMap.values()) p.media[t.id] = t;
    for (const c of Object.values(s.clips)) {
      const m = p.media[c.mediaId];
      if (titleMap.has(c.mediaId)) { c.mediaId = titleMap.get(c.mediaId)!.id; continue; }
      const path = paths.get(c.id);
      if (c.stream === 'video' && !path) {
        // logos, stickers, stills: keep their place relative to the frame
        const kx = s.width / src.width, ky = s.height / src.height;
        c.transform.posX.value *= kx; for (const kf of c.transform.posX.keyframes) kf.value *= kx;
        c.transform.posY.value *= ky; for (const kf of c.transform.posY.keyframes) kf.value *= ky;
        continue;
      }
      if (c.stream !== 'video' || !m || m.kind !== 'video' || !path) continue;
      const { scale, keys } = reframeKeyframes(c, m, s.fps, target, path);
      // positions in the old frame were in old pixels; the reframe owns position now
      const sx = c.transform.scale.keyframes.length ? 1 : c.transform.scale.value / 100;
      c.transform.scale = { value: Math.round(scale * sx * 10) / 10, keyframes: [] };
      if (keys.length > 1) c.transform.posX = { value: keys[0].value, keyframes: keys };
      else c.transform.posX = { value: keys[0]?.value ?? 0, keyframes: [] };
      c.transform.posY = { value: 0, keyframes: [] };
    }
    // captions: regroup the words for the new frame width so lines never run off the edge
    if (s.captions?.items.length) {
      const words = s.captions.items.flatMap((c) => c.words);
      if (words.length) s.captions.items = groupWords(words, fitted(s.captions.style, s.width, s.height), s.fps);
    }
    p.sequences[id] = s;
    p.activeSequenceId = id;
  });
  toast(`"${src.name} (${preset.id})" oluşturuldu — konumlar anahtar kare olarak düzenlenebilir`, 'success');
  return id;
}
