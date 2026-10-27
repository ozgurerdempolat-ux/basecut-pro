// Pushes preferences into the editor (default transition lengths, playback, autosave in main).
import { DEFAULT_AUDIO_TRANSITION, DEFAULT_TRANSITION } from './Effects';
import { Prefs, onPrefs } from './prefs';
import { useStore } from './store';

function apply(p: Prefs) {
  DEFAULT_TRANSITION.seconds = p.videoTransitionSec;
  DEFAULT_AUDIO_TRANSITION.seconds = p.audioTransitionSec;
  void window.kurgu?.setPrefs({ autosaveMin: p.autosaveMin, autosaveKeep: p.autosaveKeep, uiScale: p.uiScale });
  if (p.playbackRes !== 'auto') useStore.setState({ playbackRes: p.playbackRes });
  if (p.proxies !== 'auto') useStore.setState({ useProxies: p.proxies === 'on' });
}

export function applyPrefs() { onPrefs(apply); }
