import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { discoveryApi } from '../../api/endpoints';
import { formatDate } from '../../lib/format';

const STATUS = {
  connected: { label: 'Connected', dot: 'bg-emerald-500' },
  checking: { label: 'Checking…', dot: 'bg-line-strong' },
  unavailable: { label: 'Unavailable', dot: 'bg-danger' },
} as const;

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{term}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-ink-soft">{children}</dd>
    </div>
  );
}

/** What is actually in the bucket, from the server's cached figures. S3 has no fixed capacity to show. */
export function StorageInfo() {
  const q = useQuery({ queryKey: ['s3-stats'], queryFn: discoveryApi.s3Stats, staleTime: 30_000 });
  if (q.isLoading) return <div className="skeleton h-24" aria-label="Loading storage" />;
  if (q.isError || !q.data) {
    return (
      <button type="button" onClick={() => void q.refetch()} className="focus-ring w-full rounded text-left text-xs text-ink-muted hover:text-ink-soft">
        Storage unavailable. Retry
      </button>
    );
  }
  const s = q.data;
  const status = STATUS[s.status];
  return (
    <section aria-label="AWS S3 Storage" className="px-1 text-xs">
      <h2 className="mb-1.5 font-semibold text-ink-soft">AWS S3 Storage</h2>
      <dl className="space-y-1">
        <Row term="Storage used">{s.totalSize ?? 'Not available yet'}</Row>
        <Row term="Total files">{s.totalFiles?.toLocaleString() ?? 'Not available yet'}</Row>
        <Row term="Storage type">{s.storageType}</Row>
        <Row term="Status">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className={clsx('size-1.5 rounded-full', status.dot)} />
            {status.label}
          </span>
        </Row>
      </dl>
      {s.lastVerifiedAt && (
        <p className="mt-1.5 text-ink-muted">
          {s.status === 'unavailable' ? 'Last verified' : 'Verified'} {formatDate(s.lastVerifiedAt)}
        </p>
      )}
    </section>
  );
}
