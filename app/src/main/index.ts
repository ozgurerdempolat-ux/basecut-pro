import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, shell, utilityProcess, UtilityProcess } from 'electron';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Project } from '../core/model';
import type { ExportRequest, JobProgress, StabilizeRequest, SystemInfo, WorkerRequest, WorkerResponse } from '../shared/ipc';
import { FFMPEG } from './ffbin';

const APP_NAME = 'BaseCut Pro';
app.setName(APP_NAME);
if (process.env.KURGU_NO_SANDBOX) app.commandLine.appendSwitch('no-sandbox');
// smoother video on weak GPUs; Chromium picks hardware decode where it can
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,SharedArrayBuffer');

protocol.registerSchemesAsPrivileged([
  { scheme: 'kmedia', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true } },
  // the UI itself: a real origin (not file://) so workers, wasm and fetch behave like on the web
  { scheme: 'basecut', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } },
]);

let win: BrowserWindow | null = null;
const userDir = () => app.getPath('userData');
const cacheDir = () => join(userDir(), 'cache');
const recoveryFile = () => join(userDir(), 'recovery.basecut');
const autosaveDir = () => join(userDir(), 'autosave');

// ------------------------------------------------------------------ media worker (crash isolated)

let worker: UtilityProcess | null = null;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; job?: JobProgress }>();
let seq = 0;

function startWorker(): UtilityProcess {
  mkdirSync(cacheDir(), { recursive: true });
  const w = utilityProcess.fork(join(__dirname, 'worker.js'), [], {
    serviceName: 'BaseCut Media Worker',
    env: { ...process.env, KURGU_CACHE: cacheDir() },
    stdio: 'pipe',
  });
  w.on('message', (m: WorkerResponse) => {
    const p = pending.get(m.id);
    if (!p) return;
    if (m.progress !== undefined && m.ok === undefined) {
      if (p.job) { p.job.progress = m.progress; win?.webContents.send('job', { ...p.job }); }
      return;
    }
    pending.delete(m.id);
    if (p.job) {
      p.job.done = true;
      p.job.progress = m.ok ? 1 : p.job.progress;
      if (!m.ok) p.job.error = m.error;
      if (m.ok && typeof m.result === 'string') p.job.output = m.result;
      win?.webContents.send('job', { ...p.job });
    }
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
  });
  w.on('exit', (code) => {
    // never lose the editor: fail what was in flight, then restart
    for (const [id, p] of pending) {
      if (p.job) { p.job.done = true; p.job.error = 'Medya işçisi beklenmedik şekilde kapandı, yeniden başlatıldı.'; win?.webContents.send('job', { ...p.job }); }
      p.reject(new Error(`Medya işçisi kapandı (${code}). Yeniden başlatıldı.`));
      pending.delete(id);
    }
    worker = null;
    if (!quitting) setTimeout(() => { worker = startWorker(); }, 300);
  });
  return w;
}

function ask<T>(type: WorkerRequest['type'], payload: unknown, job?: Omit<JobProgress, 'jobId' | 'progress'>): { id: string; promise: Promise<T> } {
  if (!worker) worker = startWorker();
  const id = `j${++seq}`;
  const promise = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, job: job ? { jobId: id, progress: 0, ...job } : undefined });
  });
  if (job) win?.webContents.send('job', { jobId: id, progress: 0, ...job });
  worker.postMessage({ id, type, payload } satisfies WorkerRequest);
  return { id, promise };
}

// ------------------------------------------------------------------ media protocol with range support

function mimeFor(path: string): string {
  const e = path.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
    wasm: 'application/wasm', mjs: 'text/javascript', js: 'text/javascript', json: 'application/json', ass: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
  };
  return map[e] ?? 'application/octet-stream';
}

function serveMedia(request: Request): Response {
  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname.slice(1));
  if (!existsSync(path)) return new Response('not found', { status: 404 });
  const size = statSync(path).size;
  const range = request.headers.get('range');
  const headers: Record<string, string> = { 'Content-Type': mimeFor(path), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (m && !m[1] && m[2]) { start = size - parseInt(m[2], 10); end = size - 1; }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': `${end - start + 1}` } });
  }
  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': `${size}` } });
}

function uiMime(path: string): string {
  const e = path.toLowerCase().split('.').pop() ?? '';
  return ({ html: 'text/html; charset=utf-8', css: 'text/css', svg: 'image/svg+xml', ttf: 'font/ttf', woff2: 'font/woff2', ico: 'image/x-icon' } as Record<string, string>)[e] ?? 'application/octet-stream';
}

// ------------------------------------------------------------------ system

let hwEncoders: string[] | null = null;
function detectEncoders(): Promise<string[]> {
  if (hwEncoders) return Promise.resolve(hwEncoders);
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-hide_banner', '-encoders'], { windowsHide: true }, (_e, out) => {
      const names = ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf', 'h264_videotoolbox', 'hevc_videotoolbox'];
      hwEncoders = names.filter((n) => (out ?? '').includes(` ${n} `));
      resolve(hwEncoders);
    });
  });
}

async function systemInfo(): Promise<SystemInfo> {
  const mem = totalmem() / 1024 ** 3;
  const n = cpus().length;
  return { platform: process.platform, cpus: n, totalMemGb: Math.round(mem * 10) / 10, lowSpec: mem < 8.5 || n <= 4, hwEncoders: await detectEncoders() };
}

// ------------------------------------------------------------------ project files, journal, autosave

let journalTimer: NodeJS.Timeout | null = null;
let journalPending: Project | null = null;
let lastAutosave = 0;

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function flushJournal() {
  if (!journalPending) return;
  const data = JSON.stringify({ savedAt: Date.now(), project: journalPending });
  journalPending = null;
  try {
    writeAtomic(recoveryFile(), data);
    // rolling autosaves: one every 2 minutes, keep 20
    if (Date.now() - lastAutosave > 120_000) {
      lastAutosave = Date.now();
      mkdirSync(autosaveDir(), { recursive: true });
      writeFileSync(join(autosaveDir(), `autosave-${new Date().toISOString().replace(/[:.]/g, '-')}.basecut`), data);
      const files = readdirSync(autosaveDir()).filter((f) => f.endsWith('.basecut')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 20))) unlinkSync(join(autosaveDir(), f));
    }
  } catch { /* disk full etc. — never crash the app over a journal */ }
}

/** bundled caption fonts: resources/fonts in a packaged app, app/resources/fonts in dev */
function fontsDir(): string {
  const packaged = join(process.resourcesPath, 'fonts');
  if (app.isPackaged && existsSync(packaged)) return packaged;
  return join(app.getAppPath(), 'resources', 'fonts');
}

// ------------------------------------------------------------------ window & menu

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1024, minHeight: 640, backgroundColor: '#141416', title: APP_NAME, show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('close', () => flushJournal());
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadURL('basecut://ui/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function cmd(c: string) { return () => win?.webContents.send('menu', c); }

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tpl: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { label: 'Dosya', submenu: [
      { label: 'Yeni Proje', accelerator: 'CmdOrCtrl+Alt+N', click: cmd('new-project') },
      { label: 'Yeni Sekans…', accelerator: 'CmdOrCtrl+N', click: cmd('new-sequence') },
      { label: 'Proje Aç…', accelerator: 'CmdOrCtrl+O', click: cmd('open') },
      { type: 'separator' },
      { label: 'Kaydet', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
      { label: 'Farklı Kaydet…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('save-as') },
      { type: 'separator' },
      { label: 'İçe Aktar…', accelerator: 'CmdOrCtrl+I', click: cmd('import') },
      { label: 'Dışa Aktar…', accelerator: 'CmdOrCtrl+M', click: cmd('export') },
      { label: 'Kareyi Dışa Aktar', accelerator: 'CmdOrCtrl+Shift+E', click: cmd('export-frame') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit', label: 'Çıkış' },
    ] },
    { label: 'Düzen', submenu: [
      { label: 'Geri Al', accelerator: 'CmdOrCtrl+Z', click: cmd('undo') },
      { label: 'Yinele', accelerator: 'CmdOrCtrl+Shift+Z', click: cmd('redo') },
      { type: 'separator' },
      { label: 'Kes', accelerator: 'CmdOrCtrl+X', click: cmd('cut') },
      { label: 'Kopyala', accelerator: 'CmdOrCtrl+C', click: cmd('copy') },
      { label: 'Yapıştır', accelerator: 'CmdOrCtrl+V', click: cmd('paste') },
      { label: 'Yapıştır ve Ekle', accelerator: 'CmdOrCtrl+Shift+V', click: cmd('paste-insert') },
      { label: 'Tümünü Seç', accelerator: 'CmdOrCtrl+A', click: cmd('select-all') },
      { label: 'Seçimi Kaldır', accelerator: 'CmdOrCtrl+Shift+A', click: cmd('deselect') },
      { type: 'separator' },
      { label: 'Klavye Kısayolları…', accelerator: 'CmdOrCtrl+Alt+K', click: cmd('shortcuts') },
    ] },
    { label: 'Klip', submenu: [
      { label: 'Hız/Süre…', accelerator: 'CmdOrCtrl+R', click: cmd('speed') },
      { label: 'Bağla / Bağlantıyı Kaldır', accelerator: 'CmdOrCtrl+L', click: cmd('toggle-link') },
      { label: 'Etkinleştir', accelerator: 'Shift+E', click: cmd('toggle-enable') },
      { label: 'Yeniden Adlandır…', click: cmd('rename-clip') },
      { type: 'separator' },
      { label: 'Kare Dondurma Ekle', click: cmd('frame-hold') },
      { label: 'Kare Dondurma Bölümü Ekle (2 sn)', click: cmd('frame-hold-segment') },
      { label: 'Klibin Tamamını Dondur', click: cmd('frame-hold-whole') },
      { type: 'separator' },
      { label: 'Özellikleri Yapıştır…', accelerator: 'CmdOrCtrl+Alt+V', click: cmd('paste-attributes') },
      { label: 'Özellikleri Kaldır…', click: cmd('remove-attributes') },
      { type: 'separator' },
      { label: 'Kareyi Eşle (kaynakta aç)', accelerator: 'F', click: cmd('match-frame') },
      { label: 'Projede Göster', click: cmd('reveal-in-project') },
      { label: 'Klasörde Göster', click: cmd('reveal-in-folder') },
    ] },
    { label: 'Sekans', submenu: [
      { label: 'Kesim Ekle', accelerator: 'CmdOrCtrl+K', click: cmd('add-edit') },
      { label: 'Tüm İzlere Kesim Ekle', accelerator: 'CmdOrCtrl+Shift+K', click: cmd('add-edit-all') },
      { label: 'Varsayılan Video Geçişini Uygula (çapraz geçiş)', accelerator: 'CmdOrCtrl+D', click: cmd('default-transition') },
      { label: 'Varsayılan Ses Geçişini Uygula (sabit güç)', accelerator: 'CmdOrCtrl+Shift+D', click: cmd('default-audio-transition') },
      { label: 'Tüm Boşlukları Kapat', click: cmd('close-gaps') },
      { label: 'Otomatik Yeniden Kadrajla (9:16, 1:1, 4:5)…', click: cmd('auto-reframe') },
      { type: 'separator' },
      { label: 'Çoklu Kamera Kaynak Sekansı Oluştur…', click: cmd('create-multicam') },
      { label: 'Çoklu Kamera Görünümü', accelerator: 'Shift+0', click: cmd('multicam-view') },
      { label: 'Çoklu Kamerayı Düzleştir', click: cmd('flatten-multicam') },
      { label: 'Video İzi Ekle', click: cmd('add-video-track') },
      { label: 'Ses İzi Ekle', click: cmd('add-audio-track') },
    ] },
    { label: 'Görünüm', submenu: [
      { role: 'reload', label: 'Arayüzü Yenile' }, { role: 'toggleDevTools', label: 'Geliştirici Araçları' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Tam Ekran' },
      { role: 'zoomIn', label: 'Arayüzü Büyüt' }, { role: 'zoomOut', label: 'Arayüzü Küçült' }, { role: 'resetZoom', label: 'Arayüz Boyutunu Sıfırla' },
    ] },
    { label: 'Yardım', submenu: [{ label: 'BaseCut Pro hakkında', click: cmd('about') }] },
  ];
  // shortcuts are handled by the editor itself (so they respect panel focus and
  // text fields); the menu only shows them. Clipboard roles stay native.
  const passive = (items: Electron.MenuItemConstructorOptions[]) => {
    for (const it of items) {
      if (it.accelerator && it.click) it.registerAccelerator = false;
      if (Array.isArray(it.submenu)) passive(it.submenu);
    }
  };
  passive(tpl);
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle('openFiles', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Medya içe aktar', properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Medya', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'mxf', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', 'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'psd'] },
        { name: 'Tüm dosyalar', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('probe', async (_e, paths: string[]) => Promise.all(paths.map((p) => ask('probe', p).promise.catch((err: Error) => ({ path: p, error: err.message })))));
  ipcMain.handle('assets', (_e, path: string) => ask('assets', path).promise);
  ipcMain.handle('stabilize', (_e, req: StabilizeRequest) => ask<string>('stabilize', req, { kind: 'stabilize', label: req.label }).promise);
  ipcMain.handle('audioEnvelope', (_e, req: { label: string }) => ask('envelope', req, { kind: 'analyze', label: req.label }).promise);
  ipcMain.handle('reframeAnalyze', (_e, req: { label: string }) => ask('reframe', req, { kind: 'analyze', label: req.label }).promise);
  ipcMain.handle('makeProxy', (_e, path: string) => ask('proxy', path, { kind: 'proxy', label: `Proxy: ${path.split(/[\\/]/).pop()}` }).promise);
  ipcMain.handle('exportSequence', (_e, req: ExportRequest) => {
    const { id, promise } = ask('export', req, { kind: 'export', label: `Dışa aktarılıyor: ${req.settings.output.split(/[\\/]/).pop()}` });
    promise.catch(() => { /* reported via job channel */ });
    return { jobId: id };
  });
  ipcMain.handle('cancelJob', (_e, jobId: string) => ask('cancel', jobId).promise);
  ipcMain.handle('chooseExportPath', async (_e, name: string, ext: string) => {
    const r = await dialog.showSaveDialog(win!, { title: 'Dışa aktar', defaultPath: join(app.getPath('videos'), `${name}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    return r.canceled ? null : r.filePath ?? null;
  });
  ipcMain.handle('saveProject', async (_e, project: Project, path: string | null) => {
    let target = path;
    if (!target) {
      const r = await dialog.showSaveDialog(win!, { title: 'Projeyi kaydet', defaultPath: join(app.getPath('documents'), `${project.name}.basecut`), filters: [{ name: 'BaseCut Projesi', extensions: ['basecut', 'kurgu'] }] });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    if (existsSync(target)) { try { writeFileSync(`${target}.bak`, readFileSync(target)); } catch { /* ignore */ } }
    writeAtomic(target, JSON.stringify(project, null, 1));
    return target;
  });
  ipcMain.handle('openProject', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Proje aç', properties: ['openFile'], filters: [{ name: 'BaseCut Projesi', extensions: ['basecut', 'kurgu'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const project = JSON.parse(readFileSync(r.filePaths[0], 'utf8')) as Project;
    if (project.format !== 'kurgu-project') throw new Error('Bu bir BaseCut projesi değil');
    return { project, path: r.filePaths[0] };
  });
  ipcMain.on('journal', (_e, project: Project) => {
    journalPending = project;
    if (journalTimer) clearTimeout(journalTimer);
    journalTimer = setTimeout(flushJournal, 400);
  });
  ipcMain.handle('recover', () => {
    if (!existsSync(recoveryFile())) return null;
    try { return JSON.parse(readFileSync(recoveryFile(), 'utf8')); } catch { return null; }
  });
  ipcMain.handle('clearRecovery', () => { try { unlinkSync(recoveryFile()); } catch { /* none */ } });
  ipcMain.handle('systemInfo', () => systemInfo());
  ipcMain.on('reveal', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.on('title', (_e, t: string) => win?.setTitle(t));
  ipcMain.handle('pathExists', (_e, paths: string[]) => paths.map((p) => existsSync(p)));
  ipcMain.handle('speechAudio', (_e, req: { project: Project; sequenceId: string; trackIds: string[] }) =>
    ask<string>('speechAudio', req, { kind: 'transcribe', label: 'Ses hazırlanıyor (altyazı)' }).promise);
  ipcMain.handle('writeTemp', (_e, name: string, content: string) => {
    mkdirSync(cacheDir(), { recursive: true });
    const p = join(cacheDir(), name.replace(/[^\w.-]/g, '_'));
    writeFileSync(p, content, 'utf8');
    return p;
  });
  ipcMain.handle('fontsDir', () => fontsDir());
  ipcMain.handle('writeBinary', (_e, path: string, data: Uint8Array) => { writeFileSync(path, Buffer.from(data)); return path; });
  ipcMain.handle('writeCache', (_e, name: string, data: Uint8Array) => {
    const dir = join(cacheDir(), 'generated');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name.replace(/[^\w.-]/g, '_'));
    if (!existsSync(p)) writeFileSync(p, Buffer.from(data));
    return p;
  });

  ipcMain.handle('saveRecording', async (_e, name: string, data: Uint8Array) => {
    const dir = join(app.getPath('documents'), 'BaseCut Pro', 'Seslendirmeler');
    mkdirSync(dir, { recursive: true });
    const base = join(dir, name.replace(/[^\w.-]/g, '_'));
    const raw = `${base}.webm`, wav = `${base}.wav`;
    writeFileSync(raw, Buffer.from(data));
    // MediaRecorder files have no duration header; a plain WAV edits and seeks reliably
    await new Promise<void>((res, rej) => execFile(FFMPEG, ['-v', 'error', '-y', '-i', raw, '-c:a', 'pcm_s16le', '-ar', '48000', wav], (err) => (err ? rej(err) : res())));
    try { unlinkSync(raw); } catch { /* keep going */ }
    return wav;
  });
  ipcMain.handle('micAccess', async () => {
    if (process.platform !== 'darwin') return true;
    const { systemPreferences } = await import('electron');
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });

  ipcMain.handle('saveText', async (_e, name: string, ext: string, content: string) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('documents'), `${name}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, content, 'utf8');
    return r.filePath;
  });
  ipcMain.handle('openText', async (_e, exts: string[]) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: exts.map((x) => x.toUpperCase()).join(', '), extensions: exts }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], content: readFileSync(r.filePaths[0], 'utf8') };
  });
}

let quitting = false;
app.on('before-quit', () => { quitting = true; flushJournal(); });

app.whenReady().then(() => {
  protocol.handle('kmedia', (req) => serveMedia(req));
  const uiRoot = join(__dirname, '../renderer');
  protocol.handle('basecut', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = join(uiRoot, rel);
    if (!file.startsWith(uiRoot) || !existsSync(file)) return new Response('not found', { status: 404 });
    const data = readFileSync(file);
    return new Response(data, { headers: { 'Content-Type': mimeFor(file) === 'application/octet-stream' ? uiMime(file) : mimeFor(file), 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' } });
  });
  void net; // reserved for remote media later
  registerIpc();
  buildMenu();
  worker = startWorker();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
