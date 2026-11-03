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
  other: { label: 'Other', bar: 'bg-slate-300' },
};

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={clsx('rounded-xl border border-slate-200 bg-white p-4 sm:p-5', className)}>
      <h2 className="mb-3 text-sm font-semibold text-slate-800">{title}</h2>
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
  const pct = u && u.quota > 0 ? Math.min(100, ((u.used + u.reserved) / u.quota) * 100) : 0;
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
                <div className="h-28 animate-pulse rounded-lg bg-slate-100" />
              ) : (
                <>
                  <p className="text-2xl font-semibold tracking-tight text-slate-900">
                    {formatBytes(u.used)} <span className="text-base font-normal text-slate-500">of {formatBytes(u.quota)} used</span>
                  </p>
                  <p className="mt-0.5 text-sm text-slate-500">{Math.round(pct)}% full · {formatBytes(u.remaining)} available</p>
                  {/* One segment per file type, scaled to the quota. Trash and uploads in progress make up the rest. */}
                  <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${Math.round(pct)}% of storage used`}>
                    {b.byCategory.map((c) => (
                      <div key={c.category} className={categories[c.category].bar} style={{ width: `${(c.bytes / u.quota) * 100}%` }} title={`${categories[c.category].label}: ${formatBytes(c.bytes)}`} />
                    ))}
                    {u.inTrash > 0 && <div className="bg-slate-500" style={{ width: `${(u.inTrash / u.quota) * 100}%` }} title={`Trash: ${formatBytes(u.inTrash)}`} />}
                  </div>
                  <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                    {b.byCategory.map((c) => (
                      <li key={c.category} className="flex items-center gap-2 text-sm">
                        <span aria-hidden className={clsx('size-2.5 shrink-0 rounded-full', categories[c.category].bar)} />
                        <span className="text-slate-700">{categories[c.category].label}</span>
                        <span className="ml-auto text-slate-500">{formatBytes(c.bytes)} · {c.count}</span>
                      </li>
                    ))}
                    {u.inTrash > 0 && (
                      <li className="flex items-center gap-2 text-sm">
                        <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-slate-500" />
                        <Link to="/trash" className="focus-ring rounded text-slate-700 underline-offset-2 hover:underline">In Trash</Link>
                        <span className="ml-auto text-slate-500">{formatBytes(u.inTrash)}</span>
                      </li>
                    )}
                    {u.reserved > 0 && (
                      <li className="flex items-center gap-2 text-sm">
                        <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-slate-200" />
                        <span className="text-slate-700">Uploading</span>
                        <span className="ml-auto text-slate-500">{formatBytes(u.reserved)}</span>
                      </li>
                    )}
                  </ul>
                  {b.byCategory.length === 0 && u.inTrash === 0 && <p className="mt-3 text-sm text-slate-500">You haven’t stored any files yet.</p>}
                  {u.inTrash > 0 && (
                    <p className="mt-4 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                      <Trash2 className="size-4 shrink-0" aria-hidden />
                      <span>Files in Trash still use space. <Link to="/trash" className="font-medium text-brand-700 hover:underline">Empty Trash</Link> to free {formatBytes(u.inTrash)}.</span>
                    </p>
                  )}
                </>
              )}
            </Card>

            <Card title="Largest folders">
              {!b ? (
                <div className="h-28 animate-pulse rounded-lg bg-slate-100" />
              ) : b.largestFolders.length === 0 ? (
                <p className="text-sm text-slate-500">No folders contain files yet.</p>
              ) : (
                <ul className="space-y-1">
                  {b.largestFolders.map(({ folder, bytes }) => (
                    <li key={folder.id}>
                      <Link to={`/folders/${folder.id}`} className="focus-ring flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                        <FileIcon item={folder} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-800">{folder.name}</span>
                          <span className="mt-1 block h-1 overflow-hidden rounded-full bg-slate-100">
                            <span className="block h-full rounded-full bg-brand-400" style={{ width: `${(bytes / b.largestFolders[0]!.bytes) * 100}%` }} />
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-slate-500">{formatBytes(bytes)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <section aria-label="Largest files">
            <div className="mb-3 mt-2 flex flex-wrap items-center gap-2">
              <h2 className="mr-auto text-sm font-semibold text-slate-800">Largest files</h2>
              <label htmlFor="storage-type" className="sr-only">File type</label>
              <select
                id="storage-type"
                value={type}
                onChange={(e) => setType(e.target.value as FileCategory | '')}
                className="focus-ring h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700"
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
