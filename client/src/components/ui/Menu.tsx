import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}
export type MenuEntry = MenuItem | 'separator';

interface Props {
  items: MenuEntry[];
  /** Viewport coordinates of the anchor point. */
  at: { x: number; y: number } | null;
  onClose: () => void;
  label: string;
}

/** Keyboard-accessible popup menu (arrow keys, Home/End, Esc), clamped to the viewport. */
export function Menu({ items, at, onClose, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!at || !ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.x, window.innerWidth - width - 8));
    const top = at.y + height + 8 > window.innerHeight ? Math.max(8, at.y - height) : at.y;
    setPos({ left, top });
    ref.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onResize = () => onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [at, onClose]);

  if (!at) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') buttons[(i + 1) % buttons.length]?.focus();
    else if (e.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else if (e.key === 'Home') buttons[0]?.focus();
    else if (e.key === 'End') buttons[buttons.length - 1]?.focus();
    else if (e.key === 'Escape' || e.key === 'Tab') onClose();
    else return;
    e.preventDefault();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ left: pos?.left ?? at.x, top: pos?.top ?? at.y, visibility: pos ? 'visible' : 'hidden' }}
      className="fixed z-50 min-w-52 animate-pop-in rounded-xl border border-slate-200 bg-white py-1.5 shadow-xl shadow-slate-900/10"
    >
      {items.map((item, idx) =>
        item === 'separator' ? (
          <div key={`sep-${idx}`} role="separator" className="my-1.5 border-t border-slate-100" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={clsx(
              'flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm outline-none transition-colors disabled:opacity-40',
              item.danger ? 'text-red-600 hover:bg-red-50 focus:bg-red-50' : 'text-slate-700 hover:bg-slate-100 focus:bg-slate-100',
            )}
          >
            <span className="flex size-4 items-center justify-center [&>svg]:size-4" aria-hidden>
              {item.icon}
            </span>
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function anchorBelow(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { x: r.right - 208, y: r.bottom + 4 };
}
