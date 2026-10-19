// Background Warp Stabilizer queue: watches the project for clips whose
// stabiliser has no valid render yet, renders them one at a time in the media
// worker, and attaches the result without an undo step. Undo/redo stay instant
// because finished renders are cached on disk by their settings.
import { stabEffect, stabKey, stabParams, stabRange, needsStabilize } from '../core/stabilize';
import { patchProjectSilently, toast, useStore } from './store';

let busy = false;
let timer: number | undefined;
const failed = new Map<string, string>(); // key -> error (don't retry the same thing in a loop)

export interface StabStatus { state: 'queued' | 'running' | 'error'; progress: number; error?: string }
export const stabStatus = new Map<string, StabStatus>(); // clip id -> status
let current: { clipId: string; jobLabel: string } | null = null;

function pick() {
  const st = useStore.getState();
  for (const seq of Object.values(st.project.sequences)) {
    for (const c of Object.values(seq.clips)) {
      const m = st.project.media[c.mediaId];
      if (!m || !needsStabilize(c, m, seq.fps)) { stabStatus.delete(c.id); continue; }
      const p = stabParams(stabEffect(c)!.params);
      const { analyse } = stabRange(c, m, seq.fps);
      const key = stabKey(m, p, analyse);
      if (failed.has(key)) { stabStatus.set(c.id, { state: 'error', progress: 0, error: failed.get(key) }); continue; }
      if (!stabStatus.has(c.id) || stabStatus.get(c.id)!.state !== 'running') stabStatus.set(c.id, { state: 'queued', progress: 0 });
    }
  }
  if (busy) return;
  for (const seq of Object.values(st.project.sequences)) {
    for (const c of Object.values(seq.clips)) {
      const s = stabStatus.get(c.id);
      if (!s || s.state !== 'queued') continue;
      const m = st.project.media[c.mediaId]!;
      const p = stabParams(stabEffect(c)!.params);
      const { analyse } = stabRange(c, m, seq.fps);
      const key = stabKey(m, p, analyse);
      busy = true;
      const label = `Warp Stabilizer: ${c.name}`;
      current = { clipId: c.id, jobLabel: label };
      stabStatus.set(c.id, { state: 'running', progress: 0 });
      useStore.setState((x) => ({ stabTick: x.stabTick + 1 }));
      window.kurgu.stabilize({ key, path: m.path, range: analyse, fps: seq.fps, params: p, label })
        .then((path) => {
          // attach to every clip that asked for the same render (copies, undo states)
          patchProjectSilently((pr) => {
            for (const sq of Object.values(pr.sequences)) for (const x of Object.values(sq.clips)) {
              const mm = pr.media[x.mediaId];
              if (!mm || !stabEffect(x)) continue;
              const r = stabRange(x, mm, sq.fps);
              if (stabKey(mm, stabParams(stabEffect(x)!.params), r.analyse) === key || x.id === c.id) x.stab = { key, path, lo: analyse[0], hi: analyse[1] };
            }
          });
        })
        .then(() => {
          // never loop: if the render still doesn't satisfy the clip, report instead of re-queuing
          const now = useStore.getState();
          for (const sq of Object.values(now.project.sequences)) {
            const x = sq.clips[c.id];
            const mm = x && now.project.media[x.mediaId];
            if (x && mm && needsStabilize(x, mm, sq.fps) && stabKey(mm, stabParams(stabEffect(x)!.params), stabRange(x, mm, sq.fps).analyse) === key) failed.set(key, 'Sonuç bu klibe uygulanamadı');
          }
        })
        .catch((e: Error) => {
          const msg = e.message.includes('İptal') ? 'İptal edildi' : e.message.split('\n')[0];
          failed.set(key, msg);
          toast(`Sabitleme başarısız (${c.name}): ${msg}`, 'error');
        })
        .finally(() => {
          busy = false; current = null;
          stabStatus.delete(c.id);
          useStore.setState((x) => ({ stabTick: x.stabTick + 1 }));
          schedule();
        });
      return;
    }
  }
}

export function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(pick, 500);
}

/** progress of the running job (from the job channel) */
export function trackJobs() {
  useStore.subscribe((s, prev) => {
    if (s.project !== prev.project) schedule();
    if (current && s.jobs !== prev.jobs) {
      const j = Object.values(s.jobs).find((x) => x.kind === 'stabilize' && x.label === current!.jobLabel && !x.done);
      if (j) { const st = stabStatus.get(current.clipId); if (st) st.progress = j.progress; useStore.setState((x) => ({ stabTick: x.stabTick + 1 })); }
    }
  });
  schedule();
}

/** retry after a failure (e.g. after relinking media) */
export function retryStabilize() { failed.clear(); schedule(); }
