import type { ReactNode } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { errorMessage } from '../../api/client';

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <h3 className="empty-state-title">{title}</h3>
      {body && <p className="empty-state-body">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="empty-state">
      <div className="empty-state-icon bg-danger-soft text-danger">
        <CircleAlert />
      </div>
      <h3 className="empty-state-title">Couldn’t load this view</h3>
      <p className="empty-state-body">{errorMessage(error)}</p>
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
        <div key={i} className="card overflow-hidden">
          <div className="skeleton aspect-[4/3] rounded-none" />
          <div className="space-y-2 p-3">
            <div className="skeleton h-3 w-3/4" />
            <div className="skeleton h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="list-box">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="skeleton size-8" />
          <div className="skeleton h-3 flex-1" />
          <div className="skeleton hidden h-3 w-20 sm:block" />
        </div>
      ))}
    </div>
  );
}
