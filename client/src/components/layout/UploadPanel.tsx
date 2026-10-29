import { useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, CircleAlert, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { useUploadManager, useUploadTasks } from '../../uploads/UploadsProvider';
import type { UploadTask } from '../../uploads/uploadManager';
import { formatBytes } from '../../lib/format';
import { IconButton } from '../ui/Button';

const labels: Record<UploadTask['status'], string> = {
  queued: 'Waiting…',
  preparing: 'Preparing…',
  uploading: 'Uploading',
  verifying: 'Verifying…',
  done: 'Uploaded',
  error: 'Failed',
  cancelled: 'Cancelled',
};

export function UploadPanel() {
  const tasks = useUploadTasks();
  const manager = useUploadManager();
  const [collapsed, setCollapsed] = useState(false);
  if (tasks.length === 0) return null;

  const active = tasks.filter((t) => ['queued', 'preparing', 'uploading', 'verifying'].includes(t.status)).length;
  const failed = tasks.filter((t) => t.status === 'error').length;
  const title = active ? `Uploading ${active} item${active === 1 ? '' : 's'}` : failed ? `${failed} upload${failed === 1 ? '' : 's'} failed` : 'Uploads complete';

  return (
    <section aria-label="Uploads" className="fixed inset-x-2 bottom-2 z-40 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/15 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96">
      <header className="flex items-center gap-2 bg-slate-900 px-4 py-2.5 text-white">
        <h2 className="flex-1 text-sm font-medium" aria-live="polite">{title}</h2>
        <button type="button" aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'} onClick={() => setCollapsed((c) => !c)} className="focus-ring rounded p-1 hover:bg-white/10">
          <ChevronDown className={clsx('size-4 transition-transform', collapsed && 'rotate-180')} />
        </button>
        {active === 0 && (
          <button type="button" aria-label="Close uploads" onClick={() => tasks.forEach((t) => manager.dismiss(t.id))} className="focus-ring rounded p-1 hover:bg-white/10">
            <X className="size-4" />
          </button>
        )}
      </header>
      {!collapsed && (
        <ul className="max-h-72 divide-y divide-slate-100 overflow-auto">
          {tasks.map((t) => {
            const pct = t.size > 0 ? Math.round((t.loaded / t.size) * 100) : t.status === 'done' ? 100 : 0;
            const running = ['queued', 'preparing', 'uploading', 'verifying'].includes(t.status);
            return (
              <li key={t.id} className="px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <StatusIcon status={t.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800" title={t.name}>{t.name}</p>
                    <p className={clsx('truncate text-xs', t.status === 'error' ? 'text-red-600' : 'text-slate-500')} title={t.error}>
                      {t.status === 'error' ? t.error : t.status === 'uploading' ? `${formatBytes(t.loaded)} of ${formatBytes(t.size)} · ${pct}%` : `${labels[t.status]} · ${formatBytes(t.size)}`}
                    </p>
                  </div>
                  {t.status === 'error' && t.retryable && (
                    <IconButton label={`Retry ${t.name}`} className="size-8" onClick={() => manager.retry(t.id)}><RotateCcw className="size-4" /></IconButton>
                  )}
                  {running ? (
                    <IconButton label={`Cancel ${t.name}`} className="size-8" onClick={() => manager.cancel(t.id)}><X className="size-4" /></IconButton>
                  ) : (
                    <IconButton label={`Dismiss ${t.name}`} className="size-8" onClick={() => manager.dismiss(t.id)}><X className="size-4" /></IconButton>
                  )}
                </div>
                {running && (
                  <div role="progressbar" aria-label={`${t.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-2 h-1 overflow-hidden rounded-full bg-slate-100">
                    <div className={clsx('h-full rounded-full bg-brand-600 transition-[width] duration-200', t.status === 'verifying' && 'animate-pulse')} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function StatusIcon({ status }: { status: UploadTask['status'] }) {
  if (status === 'done') return <span className="flex size-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><Check className="size-3.5" strokeWidth={3} /></span>;
  if (status === 'error') return <CircleAlert className="size-6 text-red-500" />;
  if (status === 'cancelled') return <X className="size-6 text-slate-400" />;
  return <LoaderCircle className="size-6 animate-spin text-brand-500" />;
}
