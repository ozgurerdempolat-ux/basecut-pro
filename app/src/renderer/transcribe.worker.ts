// Speech recognition in a Web Worker so the editor never freezes.
// Whisper (multilingual, word timestamps) via transformers.js on WebGPU when the
// machine has it, otherwise CPU (wasm). The model downloads once and is cached.
import { env, pipeline } from '@huggingface/transformers';

type Req = { type: 'run'; audio: Float32Array; model: string; language: string; device: 'webgpu' | 'wasm' };
type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
let cached: { key: string; asr: Asr } | null = null;

async function load(model: string, device: 'webgpu' | 'wasm'): Promise<Asr> {
  const key = `${model}|${device}`;
  if (cached?.key === key) return cached.asr;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  // the onnxruntime wasm is bundled with the app (no CDN), so this works offline
  const onnx = (env.backends as unknown as { onnx: { wasm: { numThreads?: number } } }).onnx;
  onnx.wasm.numThreads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
  const files: Record<string, { loaded: number; total: number }> = {};
  const asr = (await pipeline('automatic-speech-recognition', model, {
    device,
    dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file) {
        files[p.file] = { loaded: p.loaded ?? 0, total: p.total ?? 0 };
        const loaded = Object.values(files).reduce((a, f) => a + f.loaded, 0);
        const total = Object.values(files).reduce((a, f) => a + f.total, 0);
        post({ type: 'download', loaded, total });
      }
    },
  } as never)) as unknown as Asr;
  cached = { key, asr };
  return asr;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { audio, model, language } = e.data;
  let device = e.data.device;
  try {
    let asr: Asr;
    try { asr = await load(model, device); }
    catch (err) {
      if (device !== 'webgpu') throw err;
      device = 'wasm'; // no usable GPU → CPU
      post({ type: 'info', text: 'GPU kullanılamadı, işlemci ile devam ediliyor' });
      asr = await load(model, device);
    }
    post({ type: 'ready', device });
    const SR = 16000;
    const piece = SR * 60 * 5; // feed 5-minute pieces so progress moves and memory stays low
    const words: { text: string; start: number; end: number }[] = [];
    for (let off = 0; off < audio.length; off += piece) {
      const chunk = audio.subarray(off, Math.min(audio.length, off + piece));
      const base = off / SR;
      const opts: Record<string, unknown> = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, task: 'transcribe' };
      if (language !== 'auto') opts.language = language;
      let out;
      try { out = await asr(chunk, opts); }
      catch {
        // some models lack word-level alignment: fall back to segment times
        out = await asr(chunk, { ...opts, return_timestamps: true });
      }
      for (const c of out.chunks ?? []) {
        const s = c.timestamp[0] ?? 0;
        const en = c.timestamp[1] ?? s + 0.3;
        const parts = c.text.trim().split(/\s+/).filter(Boolean);
        if (parts.length <= 1) words.push({ text: c.text.trim(), start: base + s, end: base + en });
        else {
          // a segment, not a word: spread by length
          const total = parts.reduce((n, p) => n + p.length + 1, 0);
          let t = s;
          for (const p of parts) { const d = ((en - s) * (p.length + 1)) / total; words.push({ text: p, start: base + t, end: base + t + d }); t += d; }
        }
      }
      post({ type: 'progress', value: Math.min(1, (off + chunk.length) / audio.length) });
    }
    post({ type: 'done', words: words.filter((w) => w.text) });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
