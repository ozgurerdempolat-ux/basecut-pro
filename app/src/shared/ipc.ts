// Messages between the UI, the main process and the media worker.
import type { ExportSettings } from '../core/render-graph';
import type { MediaItem, Project } from '../core/model';

export interface ProbeResult {
  path: string;
  name: string;
  kind: MediaItem['kind'];
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioChannels: number;
  sampleRate: number;
  codec: string;
  /** Chromium can't decode this directly (ProRes, DNx, some HEVC...) → needs a proxy for preview */
  needsProxy: boolean;
}

export interface MediaAssets {
  /** filmstrip image: frames laid side by side */
  filmstrip?: string;
  filmstripFrames?: number;
  /** audio peaks, 0..1, `peaksPerSecond` values per second */
  peaks?: number[];
  peaksPerSecond?: number;
  proxy?: string;
}

export interface StabilizeRequest {
  key: string;
  path: string;
  range: [number, number];
  fps: number;
  params: import('../core/stabilize').StabParams;
  label: string;
}

export interface JobProgress {
  jobId: string;
  kind: 'export' | 'proxy' | 'analyze' | 'transcribe' | 'stabilize';
  label: string;
  progress: number; // 0..1
  done?: boolean;
  error?: string;
  output?: string;
}

export interface WorkerRequest {
  id: string;
  type: 'probe' | 'assets' | 'export' | 'proxy' | 'cancel' | 'frame' | 'speechAudio' | 'stabilize' | 'reframe' | 'envelope' | 'loudness';
  payload: unknown;
}

export interface WorkerResponse {
  id: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
  progress?: number;
}

export interface ExportRequest {
  project: Project;
  sequenceId: string;
  settings: ExportSettings;
  useProxies: boolean;
}

export interface SystemInfo {
  platform: string;
  cpus: number;
  totalMemGb: number;
  /** a weak machine: we default to proxies and 1/2 playback resolution */
  lowSpec: boolean;
  hwEncoders: string[];
  version: string;
}

/** API exposed to the renderer by the preload script */
export interface KurguApi {
  openFiles(): Promise<string[]>;
  probe(paths: string[]): Promise<(ProbeResult | { path: string; error: string })[]>;
  assets(path: string): Promise<MediaAssets>;
  makeProxy(path: string): Promise<string>;
  /** Warp Stabilizer: analyse + render the stabilised intermediate (cached by key); resolves to its path */
  stabilize(req: StabilizeRequest): Promise<string>;
  /** EBU R128 loudness of a source range: integrated LUFS, loudness range, true peak */
  measureLoudness(req: { path: string; range: [number, number]; label: string }): Promise<{ I: number; LRA: number; TP: number }>;
  /** loudness envelope (rate values per second, first maxSec seconds) for audio sync */
  audioEnvelope(req: { path: string; rate: number; maxSec: number; label: string }): Promise<number[]>;
  /** Auto Reframe: subject position samples for a source range */
  reframeAnalyze(req: { path: string; range: [number, number]; perSecond: number; width: number; height: number; label: string }): Promise<import('../core/reframe').ReframeSample[]>;
  exportSequence(req: ExportRequest): Promise<{ jobId: string }>;
  cancelJob(jobId: string): Promise<void>;
  onJob(cb: (p: JobProgress) => void): () => void;
  chooseExportPath(defaultName: string, ext: string): Promise<string | null>;
  saveProject(project: Project, path: string | null): Promise<string | null>;
  openProject(path?: string): Promise<{ project: Project; path: string } | null>;
  setPrefs(p: { autosaveMin: number; autosaveKeep: number; uiScale: number }): Promise<void>;
  openAutosaves(): Promise<void>;
  /** choose a folder and find files by (case-insensitive) name below it: lower-case name → path */
  relinkSearch(names: string[]): Promise<Record<string, string> | null>;
  checkUpdate(): Promise<{ latest: string; current: string; url: string; newer: boolean } | null>;
  openExternal(url: string): Promise<void>;
  recentProjects(): Promise<{ path: string; name: string; openedAt: number; sequences: number; media: number }[]>;
  forgetRecent(path: string): Promise<void>;
  cacheInfo(): Promise<{ path: string; bytes: number; files: number }>;
  clearCache(keepGenerated: boolean): Promise<number>;
  journal(project: Project): void;
  recover(): Promise<{ project: Project; savedAt: number } | null>;
  clearRecovery(): Promise<void>;
  mediaUrl(path: string): string;
  systemInfo(): Promise<SystemInfo>;
  onMenu(cb: (command: string) => void): () => void;
  revealInFolder(path: string): void;
  setTitle(title: string): void;
  pathExists(paths: string[]): Promise<boolean[]>;
  /** mix the chosen tracks of a sequence to 16 kHz mono WAV for speech recognition */
  speechAudio(req: { project: Project; sequenceId: string; trackIds: string[] }): Promise<string>;
  writeTemp(name: string, content: string): Promise<string>;
  fontsDir(): Promise<string>;
  writeBinary(path: string, data: Uint8Array): Promise<string>;
  writeCache(name: string, data: Uint8Array): Promise<string>;
  /** store a microphone recording (webm/opus from MediaRecorder) as WAV under Documents/BaseCut Pro/Seslendirmeler */
  saveRecording(name: string, data: Uint8Array): Promise<string>;
  /** ask the OS for microphone access (macOS); true when allowed */
  micAccess(): Promise<boolean>;
  saveText(defaultName: string, ext: string, content: string): Promise<string | null>;
  openText(exts: string[]): Promise<{ path: string; content: string } | null>;
}
