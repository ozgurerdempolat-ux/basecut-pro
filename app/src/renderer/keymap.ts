// Customisable keyboard shortcuts. Every default binding has a command id; the
// user can move any command to another key. Pressing the new key replays the
// default key into the editor's key handler, so all the context rules (source
// monitor focus, panels, tools) keep working exactly as before.

export interface KeyCommand { id: string; label: string; group: string; keys: string }

export const KEY_COMMANDS: KeyCommand[] = [
  // playback
  { id: 'play', label: 'Oynat / durdur', group: 'Oynatma', keys: 'Space' },
  { id: 'shuttle-left', label: 'Geri oynat (J)', group: 'Oynatma', keys: 'J' },
  { id: 'shuttle-stop', label: 'Dur (K)', group: 'Oynatma', keys: 'K' },
  { id: 'shuttle-right', label: 'İleri oynat (L)', group: 'Oynatma', keys: 'L' },
  { id: 'step-back', label: '1 kare geri', group: 'Oynatma', keys: 'ArrowLeft' },
  { id: 'step-fwd', label: '1 kare ileri', group: 'Oynatma', keys: 'ArrowRight' },
  { id: 'step-back-5', label: '5 kare geri', group: 'Oynatma', keys: 'Shift+ArrowLeft' },
  { id: 'step-fwd-5', label: '5 kare ileri', group: 'Oynatma', keys: 'Shift+ArrowRight' },
  { id: 'prev-edit', label: 'Önceki kesim noktası', group: 'Oynatma', keys: 'ArrowUp' },
  { id: 'next-edit', label: 'Sonraki kesim noktası', group: 'Oynatma', keys: 'ArrowDown' },
  { id: 'home', label: 'Başa git', group: 'Oynatma', keys: 'Home' },
  { id: 'end', label: 'Sona git', group: 'Oynatma', keys: 'End' },
  // marks
  { id: 'mark-in', label: 'Giriş işaretle', group: 'İşaretler', keys: 'I' },
  { id: 'mark-out', label: 'Çıkış işaretle', group: 'İşaretler', keys: 'O' },
  { id: 'go-in', label: 'Girişe git', group: 'İşaretler', keys: 'Shift+I' },
  { id: 'go-out', label: 'Çıkışa git', group: 'İşaretler', keys: 'Shift+O' },
  { id: 'clear-inout', label: 'Giriş ve çıkışı temizle', group: 'İşaretler', keys: 'Ctrl+Shift+X' },
  { id: 'mark-clip', label: 'Klibi işaretle', group: 'İşaretler', keys: 'Shift+X' },
  { id: 'add-marker', label: 'İşaret ekle', group: 'İşaretler', keys: 'M' },
  { id: 'next-marker', label: 'Sonraki işarete git', group: 'İşaretler', keys: 'Shift+M' },
  // editing
  { id: 'insert', label: 'Kaynağı ekle (insert)', group: 'Kurgu', keys: ',' },
  { id: 'overwrite', label: 'Kaynağın üzerine yaz', group: 'Kurgu', keys: '.' },
  { id: 'lift', label: 'Kaldır (lift)', group: 'Kurgu', keys: ';' },
  { id: 'extract', label: 'Ayıkla (extract)', group: 'Kurgu', keys: "'" },
  { id: 'add-edit', label: 'Oynatma kafasında kes', group: 'Kurgu', keys: 'Ctrl+K' },
  { id: 'add-edit-all', label: 'Tüm izlerde kes', group: 'Kurgu', keys: 'Ctrl+Shift+K' },
  { id: 'trim-prev', label: 'Öncekini oynatma kafasına kırp (Q)', group: 'Kurgu', keys: 'Q' },
  { id: 'trim-next', label: 'Sonrakini oynatma kafasına kırp (W)', group: 'Kurgu', keys: 'W' },
  { id: 'delete', label: 'Sil', group: 'Kurgu', keys: 'Delete' },
  { id: 'ripple-delete', label: 'Dalgalı sil', group: 'Kurgu', keys: 'Shift+Delete' },
  { id: 'nudge-left', label: 'Klibi 1 kare sola it', group: 'Kurgu', keys: 'Alt+ArrowLeft' },
  { id: 'nudge-right', label: 'Klibi 1 kare sağa it', group: 'Kurgu', keys: 'Alt+ArrowRight' },
  { id: 'default-transition', label: 'Varsayılan video geçişi', group: 'Kurgu', keys: 'Ctrl+D' },
  { id: 'default-audio-transition', label: 'Varsayılan ses geçişi', group: 'Kurgu', keys: 'Ctrl+Shift+D' },
  { id: 'speed', label: 'Hız / süre', group: 'Kurgu', keys: 'Ctrl+R' },
  { id: 'toggle-link', label: 'Bağla / bağlantıyı kaldır', group: 'Kurgu', keys: 'Ctrl+L' },
  { id: 'toggle-enable', label: 'Klibi etkinleştir / devre dışı', group: 'Kurgu', keys: 'Shift+E' },
  { id: 'match-frame', label: 'Kareyi eşle', group: 'Kurgu', keys: 'F' },
  { id: 'select-clip', label: 'Oynatma kafasındaki klibi seç', group: 'Kurgu', keys: 'D' },
  { id: 'paste-attributes', label: 'Özellikleri yapıştır', group: 'Kurgu', keys: 'Ctrl+Alt+V' },
  // tools
  { id: 'tool-select', label: 'Seçim aracı', group: 'Araçlar', keys: 'V' },
  { id: 'tool-track', label: 'İleri iz seçimi', group: 'Araçlar', keys: 'A' },
  { id: 'tool-ripple', label: 'Dalgalı düzenleme', group: 'Araçlar', keys: 'B' },
  { id: 'tool-roll', label: 'Kaydırarak düzenleme', group: 'Araçlar', keys: 'N' },
  { id: 'tool-rate', label: 'Hız esnetme', group: 'Araçlar', keys: 'R' },
  { id: 'tool-razor', label: 'Jilet', group: 'Araçlar', keys: 'C' },
  { id: 'tool-slip', label: 'Slip', group: 'Araçlar', keys: 'Y' },
  { id: 'tool-slide', label: 'Slide', group: 'Araçlar', keys: 'U' },
  { id: 'tool-hand', label: 'El', group: 'Araçlar', keys: 'H' },
  { id: 'tool-zoom', label: 'Yakınlaştırma', group: 'Araçlar', keys: 'Z' },
  { id: 'tool-type', label: 'Yazı', group: 'Araçlar', keys: 'T' },
  // view
  { id: 'snap', label: 'Yapıştırmayı aç/kapat', group: 'Görünüm', keys: 'S' },
  { id: 'zoom-in', label: 'Timeline yakınlaştır', group: 'Görünüm', keys: '=' },
  { id: 'zoom-out', label: 'Timeline uzaklaştır', group: 'Görünüm', keys: '-' },
  { id: 'zoom-fit', label: 'Sekansı sığdır', group: 'Görünüm', keys: '\\' },
  { id: 'multicam-view', label: 'Çoklu kamera görünümü', group: 'Görünüm', keys: 'Shift+0' },
  // file / edit
  { id: 'undo', label: 'Geri al', group: 'Dosya ve düzen', keys: 'Ctrl+Z' },
  { id: 'redo', label: 'Yinele', group: 'Dosya ve düzen', keys: 'Ctrl+Shift+Z' },
  { id: 'copy', label: 'Kopyala', group: 'Dosya ve düzen', keys: 'Ctrl+C' },
  { id: 'cut', label: 'Kes (pano)', group: 'Dosya ve düzen', keys: 'Ctrl+X' },
  { id: 'paste', label: 'Yapıştır', group: 'Dosya ve düzen', keys: 'Ctrl+V' },
  { id: 'paste-insert', label: 'Yapıştır ve ekle', group: 'Dosya ve düzen', keys: 'Ctrl+Shift+V' },
  { id: 'save', label: 'Kaydet', group: 'Dosya ve düzen', keys: 'Ctrl+S' },
  { id: 'save-as', label: 'Farklı kaydet', group: 'Dosya ve düzen', keys: 'Ctrl+Shift+S' },
  { id: 'open', label: 'Proje aç', group: 'Dosya ve düzen', keys: 'Ctrl+O' },
  { id: 'import', label: 'İçe aktar', group: 'Dosya ve düzen', keys: 'Ctrl+I' },
  { id: 'export', label: 'Dışa aktar', group: 'Dosya ve düzen', keys: 'Ctrl+M' },
  { id: 'export-frame', label: 'Kareyi dışa aktar', group: 'Dosya ve düzen', keys: 'Ctrl+Shift+E' },
  { id: 'new-sequence', label: 'Yeni sekans', group: 'Dosya ve düzen', keys: 'Ctrl+N' },
  { id: 'select-all', label: 'Tümünü seç', group: 'Dosya ve düzen', keys: 'Ctrl+A' },
  { id: 'deselect', label: 'Seçimi kaldır', group: 'Dosya ve düzen', keys: 'Ctrl+Shift+A' },
  { id: 'shortcuts', label: 'Klavye kısayolları', group: 'Dosya ve düzen', keys: 'Ctrl+Alt+K' },
];

const STORE = 'basecut.keymap.v1';

/** canonical combo text for a keyboard event: "Ctrl+Shift+K", "Space", "Alt+ArrowLeft" */
export function comboOf(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): string {
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (/^Digit[0-9]$/.test(e.code ?? '')) key = e.code!.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  if (key === 'Backspace') key = 'Delete';
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
  const mods = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  // shifted symbols arrive as their own character; don't add Shift twice for them
  return [...mods, key].join('+');
}

export function loadUserKeys(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, string>; } catch { return {}; }
}
export function saveUserKeys(m: Record<string, string>) {
  try { localStorage.setItem(STORE, JSON.stringify(m)); } catch { /* private window: keys last for this session */ }
  userKeys = m;
}
let userKeys: Record<string, string> = loadUserKeys();

export const keysFor = (id: string) => userKeys[id] ?? KEY_COMMANDS.find((c) => c.id === id)?.keys ?? '';

/** which command (if any) a combo triggers under the current map, and what default combo to replay */
export function remap(combo: string): { replay: string | null; swallow: boolean } {
  if (!combo || !Object.keys(userKeys).length) return { replay: null, swallow: false };
  const byUser = KEY_COMMANDS.find((c) => userKeys[c.id] === combo);
  if (byUser) return { replay: byUser.keys, swallow: false };
  // the default key of a command the user moved elsewhere does nothing now
  const moved = KEY_COMMANDS.find((c) => c.keys === combo && userKeys[c.id] !== undefined && userKeys[c.id] !== combo);
  return { replay: null, swallow: !!moved };
}

/** a synthetic key event for a combo string (fed to the editor's key handler) */
export function eventFor(combo: string, target: EventTarget | null) {
  const parts = combo.split('+');
  let key = parts[parts.length - 1];
  const digit = /^[0-9]$/.test(key);
  const named: Record<string, string> = { Space: ' ' };
  key = named[key] ?? (key.length === 1 ? key.toLowerCase() : key);
  const shift = parts.includes('Shift');
  return {
    key: shift && key.length === 1 && /[a-z]/.test(key) ? key.toUpperCase() : key,
    code: digit ? `Digit${key}` : '',
    ctrlKey: parts.includes('Ctrl'), metaKey: false, shiftKey: shift, altKey: parts.includes('Alt'),
    target, preventDefault() { /* synthetic */ }, stopPropagation() { /* synthetic */ },
  };
}

/** conflicts: other commands already on this combo */
export function conflictsFor(id: string, combo: string): KeyCommand[] {
  return KEY_COMMANDS.filter((c) => c.id !== id && keysFor(c.id) === combo);
}
