// User preferences (per machine). Applied at start and whenever they change.
import { DEFAULT_AUDIO_TRANSITION, DEFAULT_TRANSITION } from './Effects';
import { useStore } from './store';

export interface Prefs {
  autosaveMin: number; // 0 = off
  autosaveKeep: number;
  videoTransitionSec: number;
  audioTransitionSec: number;
  stillSec: number;
  uiScale: number; // %
  playbackRes: 'auto' | 1 | 0.5 | 0.25;
  proxies: 'auto' | 'on' | 'off';
}

export const DEFAULT_PREFS: Prefs = { autosaveMin: 2, autosaveKeep: 20, videoTransitionSec: 1, audioTransitionSec: 1, stillSec: 5, uiScale: 100, playbackRes: 'auto', proxies: 'auto' };
const KEY = 'basecut.prefs.v1';

export function loadPrefs(): Prefs {
  try { return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) }; } catch { return { ...DEFAULT_PREFS }; }
}

let current = loadPrefs();
export const prefs = () => current;

export function savePrefs(p: Prefs) {
  current = p;
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private window */ }
  applyPrefs();
}

export function applyPrefs() {
  const p = current;
  DEFAULT_TRANSITION.seconds = p.videoTransitionSec;
  DEFAULT_AUDIO_TRANSITION.seconds = p.audioTransitionSec;
  void window.kurgu?.setPrefs({ autosaveMin: p.autosaveMin, autosaveKeep: p.autosaveKeep, uiScale: p.uiScale });
  const st = useStore.getState();
  if (p.playbackRes !== 'auto') useStore.setState({ playbackRes: p.playbackRes });
  if (p.proxies !== 'auto') useStore.setState({ useProxies: p.proxies === 'on' });
  void st;
}
