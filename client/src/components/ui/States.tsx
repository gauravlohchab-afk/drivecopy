import type { ReactNode } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { errorMessage } from '../../api/client';

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-500 [&>svg]:size-8">{icon}</div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-sm text-slate-500">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-red-50 text-red-500">
        <CircleAlert className="size-7" />
      </div>
      <h3 className="text-base font-semibold text-slate-900">Couldn’t load this view</h3>
      <p className="mt-1 max-w-sm text-sm text-slate-500">{errorMessage(error)}</p>
      <Button className="mt-5" icon={<RefreshCw className="size-4" />} onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function GridSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="animate-pulse overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="aspect-[4/3] bg-slate-100" />
          <div className="space-y-2 p-3">
            <div className="h-3 w-3/4 rounded bg-slate-100" />
            <div className="h-2.5 w-1/3 rounded bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex animate-pulse items-center gap-4 px-4 py-3">
          <div className="size-8 rounded-lg bg-slate-100" />
          <div className="h-3 flex-1 rounded bg-slate-100" />
          <div className="hidden h-3 w-20 rounded bg-slate-100 sm:block" />
        </div>
      ))}
    </div>
  );
}
