import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { useIsPhone } from '../../hooks/useMediaQuery';

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
  /** Shown at the top of the bottom sheet on phones (e.g. the file the actions apply to). */
  title?: ReactNode;
}

/**
 * Keyboard-accessible popup menu (arrow keys, Home/End, Esc), clamped to the viewport.
 * On phones it opens as a bottom sheet with larger touch targets instead.
 */
export function Menu({ items, at, onClose, label, title }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const sheet = useIsPhone();

  useLayoutEffect(() => {
    if (!at || !ref.current) return;
    if (!sheet) {
      const { width, height } = ref.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(at.x, window.innerWidth - width - 8));
      const top = at.y + height + 8 > window.innerHeight ? Math.max(8, at.y - height) : at.y;
      setPos({ left, top });
    }
    ref.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
    // A sheet that doesn't scroll can be dragged from anywhere; a scrolling one only by its header.
    if (sheet) ref.current.style.touchAction = ref.current.scrollHeight > ref.current.clientHeight ? '' : 'none';
  }, [at, sheet]);

  const swipe = useSwipeToDismiss(ref, onClose);

  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onResize = () => onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    // A sheet doesn't follow its anchor, so page scrolls and mobile toolbar resizes leave it open.
    if (!sheet) {
      window.addEventListener('resize', onResize);
      window.addEventListener('scroll', onResize, true);
    }
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [at, onClose, sheet]);

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

  const entries = items.map((item, idx) =>
    item === 'separator' ? (
      <div key={`sep-${idx}`} role="separator" className={clsx('menu-separator', sheet && 'mx-5')} />
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
        className={clsx('menu-item', item.danger && 'menu-item-danger', sheet && 'min-h-12 gap-4 px-5 py-3 text-[15px]')}
      >
        <span className={clsx('flex items-center justify-center', sheet ? 'size-5 [&>svg]:size-5' : 'size-4 [&>svg]:size-4')} aria-hidden>
          {item.icon}
        </span>
        {item.label}
      </button>
    ),
  );

  if (sheet) {
    return createPortal(
      <div className="fixed inset-0 z-50">
        <div aria-hidden className="absolute inset-0 animate-fade-in bg-ink-strong/40" />
        <div
          ref={ref}
          {...swipe}
          className="sheet absolute inset-x-0 bottom-0 max-h-[85dvh] animate-sheet-up overflow-y-auto pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        >
          <div data-sheet-grip className="sticky top-0 z-10 touch-none bg-surface">
            <div aria-hidden className="flex justify-center pb-2 pt-3">
              <span className="h-1 w-9 rounded-full bg-line-strong" />
            </div>
            {title && <div className="card-title flex min-w-0 items-center gap-3 border-b border-line-subtle px-5 pb-3.5 pt-1 text-[15px] font-medium">{title}</div>}
          </div>
          <div role="menu" aria-label={label} onKeyDown={onKeyDown} className="py-1.5">
            {entries}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ left: pos?.left ?? at.x, top: pos?.top ?? at.y, visibility: pos ? 'visible' : 'hidden' }}
      className="popover fixed z-50 min-w-52 animate-pop-in py-1.5"
    >
      {entries}
    </div>,
    document.body,
  );
}

/**
 * Drag a bottom sheet down to close it. It follows the finger; a long or fast enough pull slides it
 * away, anything less springs back. Only starts when the sheet is scrolled to the top (or the drag
 * starts on its grip), so scrolling a long sheet still works.
 */
function useSwipeToDismiss(ref: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  const drag = useRef<{ id: number; y: number; t: number; dy: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);

  const settle = (el: HTMLDivElement, to: string, ms: number) => {
    el.style.transition = `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
    el.style.transform = to;
  };

  return {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const onGrip = Boolean((e.target as HTMLElement).closest('[data-sheet-grip]'));
      if (!onGrip && el.scrollTop > 0) return;
      drag.current = { id: e.pointerId, y: e.clientY, t: e.timeStamp, dy: 0, active: false };
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el || e.pointerId !== d.id) return;
      const dy = e.clientY - d.y;
      if (!d.active) {
        if (dy < -6) drag.current = null; // pulling up: leave it to scrolling
        if (dy <= 6) return;
        d.active = true;
        el.setPointerCapture(e.pointerId);
        el.style.transition = 'none';
      }
      d.dy = Math.max(0, dy);
      el.style.transform = `translateY(${d.dy}px)`;
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      const el = ref.current;
      drag.current = null;
      if (!d?.active || !el) return;
      suppressClick.current = true;
      const velocity = d.dy / Math.max(1, e.timeStamp - d.t);
      if (d.dy > Math.min(120, el.offsetHeight * 0.3) || velocity > 0.6) {
        settle(el, `translateY(${el.offsetHeight}px)`, 160);
        window.setTimeout(onClose, 150);
      } else {
        settle(el, '', 200);
      }
    },
    onPointerCancel: () => {
      const el = ref.current;
      if (drag.current?.active && el) settle(el, '', 200);
      drag.current = null;
    },
    // A drag that ends over a menu item must not also select it.
    onClickCapture: (e: React.MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

export function anchorBelow(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { x: r.right - 208, y: r.bottom + 4 };
}
