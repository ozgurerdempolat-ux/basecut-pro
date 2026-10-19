import { describe, expect, it } from 'vitest';
import { youtubeChapters } from './markers';

const mk = (frame: number, name: string) => ({ id: name, frame, duration: 0, name, comment: '', color: 'blue' as const });
describe('YouTube chapters', () => {
  it('starts at 0:00, keeps ≥10 s gaps and formats hours', () => {
    expect(youtubeChapters([mk(30 * 75, 'Tarif'), mk(30 * 80, 'çok yakın'), mk(30 * 3725, 'Final')], 30)).toBe('0:00 Giriş\n1:15 Tarif\n1:02:05 Final');
    expect(youtubeChapters([mk(0, 'Başla'), mk(30 * 20, 'İki')], 30)).toBe('0:00 Başla\n0:20 İki');
  });
});
