import { useQuery } from '@tanstack/react-query';
import { Cloud } from 'lucide-react';
import clsx from 'clsx';
import { discoveryApi } from '../../api/endpoints';
import { formatBytes } from '../../lib/format';

export function StorageMeter() {
  const q = useQuery({ queryKey: ['usage'], queryFn: discoveryApi.usage, staleTime: 30_000 });
  if (q.isLoading) return <div className="h-16 animate-pulse rounded-lg bg-slate-100" aria-label="Loading storage" />;
  if (q.isError || !q.data) {
    return (
      <button type="button" onClick={() => q.refetch()} className="focus-ring w-full rounded text-left text-xs text-slate-500 hover:text-slate-700">
        Storage unavailable. Retry
      </button>
    );
  }
  const { used, quota, reserved, inTrash, remaining } = q.data;
  const pct = quota > 0 ? Math.min(100, ((used + reserved) / quota) * 100) : 0;
  return (
    <div className="px-1">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
        <Cloud className="size-4 text-slate-500" /> Storage
      </div>
      <div
        role="progressbar"
        aria-label="Storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className="h-1.5 overflow-hidden rounded-full bg-slate-200"
      >
        <div className={clsx('h-full rounded-full transition-all', pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-slate-600">
        {formatBytes(used)} of {formatBytes(quota)} used
      </p>
      <p className="text-xs text-slate-500">
        {formatBytes(remaining)} free{inTrash > 0 && ` · ${formatBytes(inTrash)} in Trash`}
        {reserved > 0 && ` · ${formatBytes(reserved)} uploading`}
      </p>
    </div>
  );
}
