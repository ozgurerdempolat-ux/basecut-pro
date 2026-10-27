// User preferences (per machine). Applied at start and whenever they change.
// This module must stay import-free: the store reads it while it is being
// created, so importing the store (or anything that does) here would be a cycle.

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

const listeners: ((p: Prefs) => void)[] = [];
/** run `fn` now and after every change */
export function onPrefs(fn: (p: Prefs) => void) { listeners.push(fn); fn(current); }

export function savePrefs(p: Prefs) {
  current = p;
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private window */ }
  for (const fn of listeners) fn(current);
}
