import { contextBridge, ipcRenderer } from 'electron';
import type { KurguApi } from '../shared/ipc';

const api: KurguApi = {
  openFiles: () => ipcRenderer.invoke('openFiles'),
  probe: (paths) => ipcRenderer.invoke('probe', paths),
  assets: (path) => ipcRenderer.invoke('assets', path),
  makeProxy: (path) => ipcRenderer.invoke('makeProxy', path),
  exportSequence: (req) => ipcRenderer.invoke('exportSequence', req),
  cancelJob: (id) => ipcRenderer.invoke('cancelJob', id),
  onJob: (cb) => {
    const h = (_: unknown, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on('job', h);
    return () => ipcRenderer.removeListener('job', h);
  },
  chooseExportPath: (name, ext) => ipcRenderer.invoke('chooseExportPath', name, ext),
  saveProject: (project, path) => ipcRenderer.invoke('saveProject', project, path),
  openProject: (path) => ipcRenderer.invoke('openProject', path),
  recentProjects: () => ipcRenderer.invoke('recentProjects'),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
  relinkSearch: (names) => ipcRenderer.invoke('relinkSearch', names),
  setPrefs: (p) => ipcRenderer.invoke('setPrefs', p),
  openAutosaves: () => ipcRenderer.invoke('openAutosaves'),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  forgetRecent: (path) => ipcRenderer.invoke('forgetRecent', path),
  cacheInfo: () => ipcRenderer.invoke('cacheInfo'),
  clearCache: (keep) => ipcRenderer.invoke('clearCache', keep),
  journal: (project) => ipcRenderer.send('journal', project),
  recover: () => ipcRenderer.invoke('recover'),
  clearRecovery: () => ipcRenderer.invoke('clearRecovery'),
  mediaUrl: (path) => `kmedia://local/${encodeURIComponent(path)}`,
  systemInfo: () => ipcRenderer.invoke('systemInfo'),
  onMenu: (cb) => {
    const h = (_: unknown, c: string) => cb(c);
    ipcRenderer.on('menu', h);
    return () => ipcRenderer.removeListener('menu', h);
  },
  revealInFolder: (p) => ipcRenderer.send('reveal', p),
  setTitle: (t) => ipcRenderer.send('title', t),
  pathExists: (paths) => ipcRenderer.invoke('pathExists', paths),
  speechAudio: (req) => ipcRenderer.invoke('speechAudio', req),
  writeTemp: (name, content) => ipcRenderer.invoke('writeTemp', name, content),
  fontsDir: () => ipcRenderer.invoke('fontsDir'),
  writeBinary: (path, data) => ipcRenderer.invoke('writeBinary', path, data),
  writeCache: (name, data) => ipcRenderer.invoke('writeCache', name, data),
  saveRecording: (name, data) => ipcRenderer.invoke('saveRecording', name, data),
  stabilize: (req) => ipcRenderer.invoke('stabilize', req),
  reframeAnalyze: (req) => ipcRenderer.invoke('reframeAnalyze', req),
  audioEnvelope: (req) => ipcRenderer.invoke('audioEnvelope', req),
  measureLoudness: (req) => ipcRenderer.invoke('measureLoudness', req),
  micAccess: () => ipcRenderer.invoke('micAccess'),
  saveText: (name, ext, content) => ipcRenderer.invoke('saveText', name, ext, content),
  openText: (exts) => ipcRenderer.invoke('openText', exts),
};

contextBridge.exposeInMainWorld('kurgu', api);
