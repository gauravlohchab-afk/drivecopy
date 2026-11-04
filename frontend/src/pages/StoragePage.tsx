import { useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Cloud, HardDrive, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { discoveryApi } from '../api/endpoints';
import type { FileCategory } from '../api/types';
import { formatBytes } from '../lib/format';
import { FileBrowser } from '../components/drive/FileBrowser';
import { FileIcon } from '../components/drive/FileIcon';
import { PageHeader } from '../components/drive/PageHeader';
import { EmptyState, ErrorState } from '../components/ui/States';

const categories: Record<FileCategory, { label: string; bar: string }> = {
  image: { label: 'Images', bar: 'bg-rose-400' },
  video: { label: 'Videos', bar: 'bg-fuchsia-500' },
  audio: { label: 'Audio', bar: 'bg-amber-400' },
  pdf: { label: 'PDFs', bar: 'bg-red-500' },
  document: { label: 'Documents', bar: 'bg-blue-500' },
  spreadsheet: { label: 'Spreadsheets', bar: 'bg-emerald-500' },
  presentation: { label: 'Presentations', bar: 'bg-orange-400' },
  text: { label: 'Text', bar: 'bg-slate-400' },
  archive: { label: 'Archives', bar: 'bg-yellow-500' },
  other: { label: 'Other', bar: 'bg-line-strong' },
};

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={clsx('rounded-card border border-line bg-surface p-4 sm:p-5', className)}>
      <h2 className="mb-3 text-sm font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

/** Where storage goes, from server-side data: totals, a by-type breakdown, and the biggest items. */
export function StoragePage() {
  const usage = useQuery({ queryKey: ['usage'], queryFn: discoveryApi.usage });
  const breakdown = useQuery({ queryKey: ['storage', 'breakdown'], queryFn: discoveryApi.storageBreakdown });
  const [type, setType] = useState<FileCategory | ''>('');
  const files = useInfiniteQuery({
    queryKey: ['search', 'largest', type],
    queryFn: ({ pageParam }) => discoveryApi.search({ type: type || undefined, sort: 'size', order: 'desc', cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const u = usage.data;
  const b = breakdown.data;
  // Shares of what is stored, not of any capacity limit: S3 has none to measure against.
  const total = u && b ? b.byCategory.reduce((sum, c) => sum + c.bytes, u.inTrash) : 0;
  const share = (bytes: number) => `${total > 0 ? (bytes / total) * 100 : 0}%`;
  const error = usage.error ?? breakdown.error;

  return (
    <>
      <PageHeader title="Storage" />
      {error ? (
        <ErrorState error={error} onRetry={() => { void usage.refetch(); void breakdown.refetch(); }} />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card title="Usage">
              {!u || !b ? (
                <div className="skeleton h-28" />
              ) : (
                <>
                  <p className="text-2xl font-semibold tracking-tight text-ink-strong">
                    {formatBytes(u.used)} <span className="text-base font-normal text-ink-muted">stored</span>
                  </p>
                  {/* One segment per file type, plus Trash. */}
                  <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-surface-hover" role="img" aria-label="Stored data by file type">
                    {b.byCategory.map((c) => (
                      <div key={c.category} className={categories[c.category].bar} style={{ width: share(c.bytes) }} title={`${categories[c.category].label}: ${formatBytes(c.bytes)}`} />
                    ))}
                    {u.inTrash > 0 && <div className="bg-slate-500" style={{ width: share(u.inTrash) }} title={`Trash: ${formatBytes(u.inTrash)}`} />}
                  </div>
                  <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                    {b.byCategory.map((c) => (
                      <li key={c.category} className="flex items-center gap-2 text-sm">
                        <span aria-hidden className={clsx('size-2.5 shrink-0 rounded-full', categories[c.category].bar)} />
                        <span className="text-ink-soft">{categories[c.category].label}</span>
                        <span className="ml-auto text-ink-muted">{formatBytes(c.bytes)} · {c.count}</span>
                      </li>
                    ))}
                    {u.inTrash > 0 && (
                      <li className="flex items-center gap-2 text-sm">
                        <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-slate-500" />
                        <Link to="/trash" className="focus-ring rounded text-ink-soft underline-offset-2 hover:underline">In Trash</Link>
                        <span className="ml-auto text-ink-muted">{formatBytes(u.inTrash)}</span>
                      </li>
                    )}
                    {u.reserved > 0 && (
                      <li className="flex items-center gap-2 text-sm">
                        <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-line" />
                        <span className="text-ink-soft">Uploading</span>
                        <span className="ml-auto text-ink-muted">{formatBytes(u.reserved)}</span>
                      </li>
                    )}
                  </ul>
                  {b.byCategory.length === 0 && u.inTrash === 0 && <p className="mt-3 text-sm text-ink-muted">You haven’t stored any files yet.</p>}
                  {u.inTrash > 0 && (
                    <p className="mt-4 flex items-center gap-2 rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink-soft">
                      <Trash2 className="size-4 shrink-0" aria-hidden />
                      <span>Files in Trash still use space. <Link to="/trash" className="link">Empty Trash</Link> to free {formatBytes(u.inTrash)}.</span>
                    </p>
                  )}
                </>
              )}
            </Card>

            <Card title="Largest folders">
              {!b ? (
                <div className="skeleton h-28" />
              ) : b.largestFolders.length === 0 ? (
                <p className="text-sm text-ink-muted">No folders contain files yet.</p>
              ) : (
                <ul className="space-y-1">
                  {b.largestFolders.map(({ folder, bytes }) => (
                    <li key={folder.id}>
                      <Link to={`/folders/${folder.id}`} className="focus-ring flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-muted">
                        <FileIcon item={folder} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{folder.name}</span>
                          <span className="mt-1 block h-1 overflow-hidden rounded-full bg-surface-hover">
                            <span className="block h-full rounded-full bg-brand-400" style={{ width: `${(bytes / b.largestFolders[0]!.bytes) * 100}%` }} />
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-ink-muted">{formatBytes(bytes)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <section aria-label="Largest files">
            <div className="mb-3 mt-2 flex flex-wrap items-center gap-2">
              <h2 className="mr-auto text-sm font-semibold text-ink">Largest files</h2>
              <label htmlFor="storage-type" className="sr-only">File type</label>
              <select
                id="storage-type"
                value={type}
                onChange={(e) => setType(e.target.value as FileCategory | '')}
                className="input input-sm focus-ring w-auto"
              >
                <option value="">All types</option>
                {Object.entries(categories).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
              </select>
            </div>
            <FileBrowser
              folders={[]}
              files={files.data?.pages.flatMap((p) => p.files) ?? []}
              view="list"
              isLoading={files.isLoading}
              error={files.error}
              onRetry={() => void files.refetch()}
              hasMore={files.hasNextPage}
              loadingMore={files.isFetchingNextPage}
              onLoadMore={() => void files.fetchNextPage()}
              empty={<EmptyState icon={type ? <HardDrive /> : <Cloud />} title={type ? `No ${categories[type].label.toLowerCase()}` : 'No files yet'} body="Files you upload are listed here from largest to smallest." />}
            />
          </section>
        </div>
      )}
    </>
  );
}
