import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, shell, utilityProcess, UtilityProcess } from 'electron';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Project } from '../core/model';
import type { ExportRequest, JobProgress, SystemInfo, WorkerRequest, WorkerResponse } from '../shared/ipc';
import { FFMPEG } from './ffbin';

const APP_NAME = 'BaseCut Pro';
app.setName(APP_NAME);
if (process.env.KURGU_NO_SANDBOX) app.commandLine.appendSwitch('no-sandbox');
// smoother video on weak GPUs; Chromium picks hardware decode where it can
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

protocol.registerSchemesAsPrivileged([
  { scheme: 'kmedia', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true } },
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
  const headers: Record<string, string> = { 'Content-Type': mimeFor(path), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
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

// ------------------------------------------------------------------ window & menu

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1024, minHeight: 640, backgroundColor: '#141416', title: APP_NAME, show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('close', () => flushJournal());
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
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
    ] },
    { label: 'Sekans', submenu: [
      { label: 'Kesim Ekle', accelerator: 'CmdOrCtrl+K', click: cmd('add-edit') },
      { label: 'Tüm İzlere Kesim Ekle', accelerator: 'CmdOrCtrl+Shift+K', click: cmd('add-edit-all') },
      { label: 'Tüm Boşlukları Kapat', click: cmd('close-gaps') },
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
}

let quitting = false;
app.on('before-quit', () => { quitting = true; flushJournal(); });

app.whenReady().then(() => {
  protocol.handle('kmedia', (req) => serveMedia(req));
  void net; // reserved for remote media later
  registerIpc();
  buildMenu();
  worker = startWorker();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
