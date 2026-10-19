import type { Marker } from './model';

/** "0:00 Giriş" lines as YouTube expects: first chapter at 0:00, chapters at least 10 s apart */
export function youtubeChapters(markers: Marker[], fps: number): string {
  const list = [...markers].sort((a, b) => a.frame - b.frame);
  const fmt = (f: number) => { const s = Math.floor(f / fps), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; };
  const lines: string[] = [];
  let last = -Infinity;
  if (!list.length || list[0].frame >= fps) { lines.push('0:00 Giriş'); last = 0; }
  for (const m of list) {
    if (m.frame - last < fps * 10) continue;
    lines.push(`${lines.length ? fmt(m.frame) : '0:00'} ${m.name || 'Bölüm'}`);
    last = m.frame;
  }
  return lines.join('\n');
}
