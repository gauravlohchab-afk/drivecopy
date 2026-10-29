import { useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { discoveryApi, folderApi, type SearchParams } from '../api/endpoints';
import { FileBrowser } from '../components/drive/FileBrowser';
import { PageHeader } from '../components/drive/PageHeader';
import { EmptyState } from '../components/ui/States';
import { useViewPrefs } from '../hooks/usePrefs';

const TYPES: { value: NonNullable<SearchParams['type']>; label: string }[] = [
  { value: '', label: 'Any type' },
  { value: 'folder', label: 'Folders' },
  { value: 'pdf', label: 'PDFs' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'audio', label: 'Audio' },
  { value: 'document', label: 'Documents' },
  { value: 'spreadsheet', label: 'Spreadsheets' },
  { value: 'presentation', label: 'Presentations' },
  { value: 'text', label: 'Text' },
  { value: 'archive', label: 'Archives' },
];

const DATES = [
  { value: '', label: 'Any time' },
  { value: '1', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '365', label: 'This year' },
];

function since(days: string) {
  if (!days) return undefined;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (Number(days) - 1));
  return d.toISOString();
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const prefs = useViewPrefs();
  const q = params.get('q') ?? '';
  const type = (params.get('type') ?? '') as SearchParams['type'];
  const days = params.get('days') ?? '';
  const folderId = params.get('folderId');

  const folder = useQuery({ queryKey: ['folder', folderId], queryFn: () => folderApi.contents(folderId, { sort: 'name', order: 'asc' }), enabled: Boolean(folderId) });
  const enabled = Boolean(q || type || days);

  const results = useInfiniteQuery({
    queryKey: ['search', q, type, days, folderId, prefs.sort, prefs.order],
    queryFn: ({ pageParam }) => discoveryApi.search({ q, type, folderId, modifiedAfter: since(days), sort: prefs.sort, order: prefs.order, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const select = 'focus-ring h-9 rounded-full border border-slate-200 bg-white pl-3 pr-8 text-sm text-slate-700 hover:border-slate-300';

  return (
    <>
      <PageHeader
        title={q ? `Results for “${q}”` : 'Search'}
        view={prefs.view}
        onView={prefs.setView}
        sort={prefs.sort}
        order={prefs.order}
        onSort={prefs.setSort}
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="filter-type">File type</label>
        <select id="filter-type" className={select} value={type} onChange={(e) => set('type', e.target.value)}>
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <label className="sr-only" htmlFor="filter-date">Modified</label>
        <select id="filter-date" className={select} value={days} onChange={(e) => set('days', e.target.value)}>
          {DATES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        {folderId && (
          <span className="inline-flex h-9 items-center gap-1 rounded-full bg-brand-50 pl-3 pr-1 text-sm text-brand-800">
            In “{folder.data?.folder?.name ?? '…'}”
            <button type="button" aria-label="Search everywhere instead" className="focus-ring rounded-full p-1 hover:bg-brand-100" onClick={() => set('folderId', null)}>
              <X className="size-3.5" />
            </button>
          </span>
        )}
      </div>
      {!enabled ? (
        <EmptyState icon={<Search />} title="Search your drive" body="Type a name in the search box, or pick a file type or date to browse." />
      ) : (
        <FileBrowser
          folders={results.data?.pages[0]?.folders ?? []}
          files={results.data?.pages.flatMap((p) => p.files) ?? []}
          view={prefs.view}
          isLoading={results.isLoading}
          error={results.error}
          onRetry={() => void results.refetch()}
          sort={prefs.sort}
          order={prefs.order}
          onSort={prefs.setSort}
          hasMore={results.hasNextPage}
          loadingMore={results.isFetchingNextPage}
          onLoadMore={() => void results.fetchNextPage()}
          empty={<EmptyState icon={<Search />} title="No matches" body="Try a different name, type or date." />}
        />
      )}
    </>
  );
}
