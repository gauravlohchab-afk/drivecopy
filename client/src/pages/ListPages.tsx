import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Clock, Star, Trash2 } from 'lucide-react';
import { discoveryApi, trashApi } from '../api/endpoints';
import { FileBrowser } from '../components/drive/FileBrowser';
import { PageHeader } from '../components/drive/PageHeader';
import { EmptyState } from '../components/ui/States';
import { Button } from '../components/ui/Button';
import { useViewPrefs } from '../hooks/usePrefs';
import { useDriveActions } from '../components/drive/DriveActions';

export function RecentPage() {
  const prefs = useViewPrefs();
  const q = useInfiniteQuery({
    queryKey: ['recent'],
    queryFn: ({ pageParam }) => discoveryApi.recent(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  return (
    <>
      <PageHeader title="Recent" view={prefs.view} onView={prefs.setView} />
      <FileBrowser
        folders={[]}
        files={q.data?.pages.flatMap((p) => p.files) ?? []}
        view={prefs.view}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        hasMore={q.hasNextPage}
        loadingMore={q.isFetchingNextPage}
        onLoadMore={() => void q.fetchNextPage()}
        empty={<EmptyState icon={<Clock />} title="No recent files" body="Files you upload, open or edit show up here." />}
      />
    </>
  );
}

export function StarredPage() {
  const prefs = useViewPrefs();
  const q = useQuery({ queryKey: ['starred'], queryFn: discoveryApi.starred });
  return (
    <>
      <PageHeader title="Starred" view={prefs.view} onView={prefs.setView} />
      <FileBrowser
        folders={q.data?.folders ?? []}
        files={q.data?.files ?? []}
        view={prefs.view}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={<Star />} title="Nothing starred yet" body="Star files and folders you want to find quickly." />}
      />
    </>
  );
}

export function TrashPage() {
  const prefs = useViewPrefs();
  const actions = useDriveActions();
  const q = useQuery({ queryKey: ['trash'], queryFn: trashApi.list });
  const count = (q.data?.folders.length ?? 0) + (q.data?.files.length ?? 0);
  return (
    <>
      <PageHeader
        title="Trash"
        view={prefs.view}
        onView={prefs.setView}
        extra={count > 0 && <Button size="sm" variant="ghost" className="mr-1 text-red-600 hover:bg-red-50" onClick={actions.emptyTrash}>Empty Trash</Button>}
      />
      {count > 0 && (
        <p className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          Items in Trash still count toward your storage until you delete them forever.
        </p>
      )}
      <FileBrowser
        mode="trash"
        folders={q.data?.folders ?? []}
        files={q.data?.files ?? []}
        view={prefs.view}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={<Trash2 />} title="Trash is empty" body="Items you move to Trash appear here until you restore or delete them." />}
      />
    </>
  );
}
