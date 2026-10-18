// Where the ffmpeg / ffprobe binaries live, in dev and in a packaged app.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const req = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);

function unpacked(p: string): string {
  // electron-builder puts native binaries in app.asar.unpacked
  return p.replace(`app.asar${require_sep()}`, `app.asar.unpacked${require_sep()}`);
}

function require_sep(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

function resolveStatic(mod: string, field?: string): string | null {
  try {
    const m = req(mod);
    const p: string = field ? m[field] : m;
    if (p && existsSync(unpacked(p))) return unpacked(p);
  } catch { /* not installed */ }
  return null;
}

export const FFMPEG = process.env.KURGU_FFMPEG ?? resolveStatic('ffmpeg-static') ?? 'ffmpeg';
export const FFPROBE = process.env.KURGU_FFPROBE ?? resolveStatic('ffprobe-static', 'path') ?? 'ffprobe';
