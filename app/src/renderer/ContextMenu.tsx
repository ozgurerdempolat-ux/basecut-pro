// Right-click menus for every object (clips, transitions, tracks, keyframes,
// project items, monitors). One menu at a time, keyboard-navigable, closes on
// outside click / Escape / scroll.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';

export type MenuItem =
  | { label: string; action: () => void; shortcut?: string; disabled?: boolean; checked?: boolean; danger?: boolean }
  | { label: string; submenu: MenuItem[]; disabled?: boolean }
  | { sep: true };

interface MenuState { menu: { x: number; y: number; items: MenuItem[] } | null }
export const useMenu = create<MenuState>(() => ({ menu: null }));

export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  e.stopPropagation?.();
  useMenu.setState({ menu: { x: e.clientX, y: e.clientY, items: items.filter((x, i, a) => !('sep' in x) || (i > 0 && i < a.length - 1 && !('sep' in a[i - 1]))) } });
}
export const closeMenu = () => useMenu.setState({ menu: null });

function List({ items, x, y, onDone }: { items: MenuItem[]; x: number; y: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState<number | null>(null);
  const [hi, setHi] = useState(-1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const act = items.map((it, i) => ('sep' in it || it.disabled ? -1 : i)).filter((i) => i >= 0);
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setHi((h) => act[(act.indexOf(h) + 1) % act.length] ?? -1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setHi((h) => act[(act.indexOf(h) - 1 + act.length) % act.length] ?? -1); }
      if (e.key === 'Enter' && hi >= 0) {
        e.preventDefault(); e.stopPropagation();
        const it = items[hi];
        if ('action' in it) { onDone(); it.action(); } else if ('submenu' in it) setOpen(hi);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [items, hi, onDone]);
  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => {
        if ('sep' in it) return <div key={i} className="ctx-sep" />;
        const sub = 'submenu' in it;
        return (
          <div key={i} className={`ctx-item ${it.disabled ? 'disabled' : ''} ${hi === i ? 'hi' : ''} ${'danger' in it && it.danger ? 'danger' : ''}`}
            onMouseEnter={(e) => { setHi(i); setOpen(sub ? i : null); void e; }}
            onClick={() => { if (it.disabled) return; if ('action' in it) { onDone(); it.action(); } else setOpen(i); }}>
            <span className="ctx-check">{'checked' in it && it.checked ? '✓' : ''}</span>
            <span className="ctx-label">{it.label}</span>
            {'shortcut' in it && it.shortcut && <span className="ctx-kbd">{it.shortcut}</span>}
            {sub && <span className="ctx-arrow">▸</span>}
            {sub && open === i && !it.disabled && <SubList items={it.submenu} onDone={onDone} />}
          </div>
        );
      })}
    </div>
  );
}

function SubList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r && r.right > window.innerWidth - 4) setFlip(true);
  }, []);
  return (
    <div ref={ref} className={`ctx-menu ctx-sub ${flip ? 'flip' : ''}`} onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) => {
        if ('sep' in it) return <div key={i} className="ctx-sep" />;
        return (
          <div key={i} className={`ctx-item ${it.disabled ? 'disabled' : ''}`} onClick={() => { if (it.disabled || !('action' in it)) return; onDone(); it.action(); }}>
            <span className="ctx-check">{'checked' in it && it.checked ? '✓' : ''}</span>
            <span className="ctx-label">{it.label}</span>
            {'shortcut' in it && it.shortcut && <span className="ctx-kbd">{it.shortcut}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function ContextMenuHost() {
  const menu = useMenu((s) => s.menu);
  useEffect(() => {
    if (!menu) return;
    const close = () => closeMenu();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', close); window.removeEventListener('blur', close); window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close); window.removeEventListener('keydown', key, true);
    };
  }, [menu]);
  if (!menu) return null;
  return <List items={menu.items} x={menu.x} y={menu.y} onDone={closeMenu} />;
}
