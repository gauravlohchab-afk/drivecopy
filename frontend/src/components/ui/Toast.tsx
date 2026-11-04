import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CircleAlert, Check, X } from 'lucide-react';
import clsx from 'clsx';

interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
  action?: { label: string; onClick: () => void };
}
type Push = (t: Omit<Toast, 'id'>) => void;

const Ctx = createContext<Push>(() => undefined);
let next = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback<Push>(
    (t) => {
      const id = ++next;
      setToasts((list) => [...list.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.kind === 'error' ? 8000 : 5000);
    },
    [dismiss],
  );
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] md:bottom-4 flex flex-col items-center gap-2 px-4 sm:items-start sm:pl-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="toast pointer-events-auto w-full max-w-sm animate-pop-in"
          >
            {t.kind === 'error' ? <CircleAlert className="size-4 shrink-0 text-red-300" /> : <Check className={clsx('size-4 shrink-0', t.kind === 'success' ? 'text-emerald-300' : 'text-line-strong')} />}
            <span className="min-w-0 flex-1">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="focus-ring rounded px-1 font-semibold text-brand-300 hover:text-brand-200"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" aria-label="Dismiss" className="focus-ring rounded text-ink-faint hover:text-white" onClick={() => dismiss(t.id)}>
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
