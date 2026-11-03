import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { discoveryApi, folderApi, type SearchParams } from '../api/endpoints';
import { FileBrowser } from '../components/drive/FileBrowser';
import { PageHeader } from '../components/drive/PageHeader';
import { EmptyState } from '../components/ui/States';
import { Button } from '../components/ui/Button';
import { AdvancedSearch, DATE_OPTIONS, SIZE_OPTIONS, TYPE_OPTIONS } from '../components/layout/AdvancedSearch';
import { useViewPrefs } from '../hooks/usePrefs';
import { formatBytes } from '../lib/format';

function since(days: string) {
  if (!days) return undefined;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (Number(days) - 1));
  return d.toISOString();
}

/** Local calendar day bounds for the custom date range. */
const dayStart = (ymd: string) => (ymd ? new Date(`${ymd}T00:00:00`).toISOString() : undefined);
const dayEnd = (ymd: string) => (ymd ? new Date(`${ymd}T23:59:59.999`).toISOString() : undefined);

const ownerLabel = (o: string) => (o === 'me' ? 'Owned by me' : o === 'others' ? 'Not owned by me' : `Owner: ${o}`);
const locationLabel = (l: string) => (l === 'mydrive' ? 'In My Drive' : 'Shared with me');

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const prefs = useViewPrefs();
  const [advanced, setAdvanced] = useState(false);
  const get = (k: string) => params.get(k) ?? '';
  const q = get('q');
  const type = get('type') as SearchParams['type'];
  const days = get('days');
  const folderId = params.get('folderId');
  const owner = get('owner');
  const location = get('location');
  const trash = get('trash') === '1';
  const starred = get('starred') === '1';
  const after = get('after');
  const before = get('before');
  const min = get('min');
  const max = get('max');
  const sharedTo = get('sharedTo');

  const folder = useQuery({ queryKey: ['folder', folderId], queryFn: () => folderApi.contents(folderId, { sort: 'name', order: 'asc' }), enabled: Boolean(folderId) });
  const enabled = Boolean(q || type || days || owner || location || trash || starred || after || before || min || max || sharedTo || folderId);

  const api: SearchParams = {
    q,
    type,
    folderId,
    owner: owner || undefined,
    location: (location || undefined) as SearchParams['location'],
    inTrash: trash || undefined,
    starred: starred || undefined,
    modifiedAfter: after ? dayStart(after) : since(days),
    modifiedBefore: dayEnd(before),
    sizeMin: min ? Number(min) : undefined,
    sizeMax: max ? Number(max) : undefined,
    sharedTo: sharedTo || undefined,
    sort: prefs.sort,
    order: prefs.order,
  };
  const results = useInfiniteQuery({
    queryKey: ['search', params.toString(), prefs.sort, prefs.order],
    queryFn: ({ pageParam }) => discoveryApi.search({ ...api, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });

  const set = (keys: string | string[], value: string | null = null) => {
    const next = new URLSearchParams(params);
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };

  const sizeLabel = () => {
    const preset = SIZE_OPTIONS.find((o) => o.value && o.value !== 'custom' && String(o.min ?? '') === min && String(o.max ?? '') === max);
    if (preset) return preset.label;
    if (min && max) return `${formatBytes(Number(min))} – ${formatBytes(Number(max))}`;
    return min ? `At least ${formatBytes(Number(min))}` : `Up to ${formatBytes(Number(max))}`;
  };
  const chips: { label: string; clear: () => void }[] = [];
  if (owner) chips.push({ label: ownerLabel(owner), clear: () => set('owner') });
  if (location) chips.push({ label: locationLabel(location), clear: () => set('location') });
  if (folderId) chips.push({ label: `In “${folder.data?.folder?.name ?? '…'}”`, clear: () => set('folderId') });
  if (trash) chips.push({ label: 'In Trash', clear: () => set('trash') });
  if (starred) chips.push({ label: 'Starred', clear: () => set('starred') });
  if (after || before) chips.push({ label: `Modified ${after || '…'} to ${before || 'today'}`, clear: () => set(['after', 'before']) });
  if (min || max) chips.push({ label: sizeLabel(), clear: () => set(['min', 'max']) });
  if (sharedTo) chips.push({ label: `Shared to ${sharedTo}`, clear: () => set('sharedTo') });

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
          {TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.value ? t.label : 'Any type'}</option>)}
        </select>
        {!(after || before) && (
          <>
            <label className="sr-only" htmlFor="filter-date">Modified</label>
            <select id="filter-date" className={select} value={days} onChange={(e) => (e.target.value === 'custom' ? setAdvanced(true) : set('days', e.target.value))}>
              {DATE_OPTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </>
        )}
        {chips.map((c) => (
          <span key={c.label} className="inline-flex h-9 max-w-full items-center gap-1 rounded-full bg-brand-50 pl-3 pr-1 text-sm text-brand-800">
            <span className="truncate">{c.label}</span>
            <button type="button" aria-label={`Remove filter: ${c.label}`} className="focus-ring shrink-0 rounded-full p-1 hover:bg-brand-100" onClick={c.clear}>
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        <Button size="sm" variant="ghost" className="h-9 rounded-full" icon={<SlidersHorizontal className="size-4" />} onClick={() => setAdvanced(true)}>
          Advanced
        </Button>
      </div>
      {!enabled ? (
        <EmptyState
          icon={<Search />}
          title="Search your drive"
          body="Type a name in the search box, or use Advanced search to filter by type, owner, location, date or size."
          action={<Button variant="primary" icon={<SlidersHorizontal className="size-4" />} onClick={() => setAdvanced(true)}>Advanced search</Button>}
        />
      ) : (
        <FileBrowser
          mode={trash ? 'trash' : 'drive'}
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
          empty={<EmptyState icon={<Search />} title="No matches" body="Try a different name, or remove some filters." />}
        />
      )}
      <AdvancedSearch open={advanced} onClose={() => setAdvanced(false)} />
    </>
  );
}
