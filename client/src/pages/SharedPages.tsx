import { Link, useParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { FolderX, Users } from 'lucide-react';
import { shareApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { FileBrowser } from '../components/drive/FileBrowser';
import { PageHeader, Breadcrumbs } from '../components/drive/PageHeader';
import { EmptyState } from '../components/ui/States';
import { useViewPrefs } from '../hooks/usePrefs';

export function SharedPage() {
  const prefs = useViewPrefs();
  const q = useQuery({ queryKey: ['shared', 'list'], queryFn: shareApi.sharedWithMe });
  return (
    <>
      <PageHeader title="Shared with me" view={prefs.view} onView={prefs.setView} />
      <FileBrowser
        mode="shared"
        canLeave
        folders={q.data?.folders ?? []}
        files={q.data?.files ?? []}
        view={prefs.view}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={<Users />} title="Nothing shared with you yet" body="Files and folders other people share with you show up here." />}
      />
    </>
  );
}

/** Read-only view of a folder someone shared (or a folder inside it). */
export function SharedFolderPage() {
  const { folderId = '' } = useParams();
  const prefs = useViewPrefs();
  const q = useInfiniteQuery({
    queryKey: ['shared', 'contents', folderId, prefs.sort, prefs.order],
    queryFn: ({ pageParam }) => shareApi.folderContents(folderId, { sort: prefs.sort, order: prefs.order, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });

  if (q.error instanceof ApiError && q.error.status === 404) {
    return (
      <EmptyState
        icon={<FolderX />}
        title="This folder isn’t available"
        body="It may no longer be shared with you, or the owner moved it to Trash."
        action={<Link to="/shared" className="focus-ring rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Go to Shared with me</Link>}
      />
    );
  }

  const first = q.data?.pages[0];
  const owner = first?.folder?.owner;
  return (
    <>
      <PageHeader
        title={first ? <Breadcrumbs path={first.path} rootLabel="Shared with me" shared /> : <div className="h-7 w-48 animate-pulse rounded bg-slate-100" />}
        view={prefs.view}
        onView={prefs.setView}
        sort={prefs.sort}
        order={prefs.order}
        onSort={prefs.setSort}
      />
      {owner && <p className="-mt-2 mb-3 px-1 text-xs text-slate-500">Owned by {owner.name} · View only</p>}
      <FileBrowser
        mode="shared"
        folders={first?.folders ?? []}
        files={q.data?.pages.flatMap((p) => p.files) ?? []}
        view={prefs.view}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        sort={prefs.sort}
        order={prefs.order}
        onSort={prefs.setSort}
        hasMore={q.hasNextPage}
        loadingMore={q.isFetchingNextPage}
        onLoadMore={() => void q.fetchNextPage()}
        empty={<EmptyState icon={<Users />} title="This folder is empty" body="Nothing has been added to this shared folder yet." />}
      />
    </>
  );
}
