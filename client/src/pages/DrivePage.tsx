import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { FolderX, HardDrive, Upload, FolderPlus } from 'lucide-react';
import clsx from 'clsx';
import { folderApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { FileBrowser } from '../components/drive/FileBrowser';
import { PageHeader, Breadcrumbs } from '../components/drive/PageHeader';
import { EmptyState } from '../components/ui/States';
import { Button } from '../components/ui/Button';
import { useViewPrefs } from '../hooks/usePrefs';
import { useDriveActions } from '../components/drive/DriveActions';
import { UploadPickers, type UploadPickersHandle } from '../uploads/UploadPickers';
import { useUploadManager } from '../uploads/UploadsProvider';
import { useToast } from '../components/ui/Toast';

export function DrivePage() {
  const { folderId = null } = useParams();
  const prefs = useViewPrefs();
  const actions = useDriveActions();
  const manager = useUploadManager();
  const toast = useToast();
  const pickers = useRef<UploadPickersHandle>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const q = useInfiniteQuery({
    queryKey: ['contents', folderId, prefs.sort, prefs.order],
    queryFn: ({ pageParam }) => folderApi.contents(folderId, { sort: prefs.sort, order: prefs.order, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });

  if (q.error instanceof ApiError && q.error.status === 404) {
    return (
      <EmptyState
        icon={<FolderX />}
        title="This folder isn’t available"
        body="It may have been moved to Trash or deleted, or the link is wrong."
        action={<Link to="/drive" className="focus-ring rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">Go to My Drive</Link>}
      />
    );
  }

  const first = q.data?.pages[0];
  const folders = first?.folders ?? [];
  const files = q.data?.pages.flatMap((p) => p.files) ?? [];

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const items = [...e.dataTransfer.items];
    const hasDirs = items.some((i) => i.webkitGetAsEntry?.()?.isDirectory);
    const dropped = [...e.dataTransfer.files].filter((_, idx) => !items[idx]?.webkitGetAsEntry?.()?.isDirectory);
    if (hasDirs) toast({ kind: 'info', message: 'To upload a folder, use New → Upload folder.' });
    if (dropped.length) manager.add(dropped, folderId);
  };

  return (
    <div
      className="relative min-h-[60vh]"
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <PageHeader
        title={folderId ? (first ? <Breadcrumbs path={first.path} /> : <div className="h-7 w-48 animate-pulse rounded bg-slate-100" />) : <h1 className="text-xl font-semibold text-slate-900">My Drive</h1>}
        view={prefs.view}
        onView={prefs.setView}
        sort={prefs.sort}
        order={prefs.order}
        onSort={prefs.setSort}
        onUpload={() => pickers.current?.pickFiles()}
      />
      <UploadPickers ref={pickers} parentId={folderId} />
      <FileBrowser
        folders={folders}
        files={files}
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
        empty={
          <EmptyState
            icon={<HardDrive />}
            title={folderId ? 'This folder is empty' : 'Your drive is empty'}
            body="Drop files here, or use the buttons below to add your first files."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => pickers.current?.pickFiles()}>Upload files</Button>
                <Button icon={<FolderPlus className="size-4" />} onClick={() => actions.newFolder(folderId)}>New folder</Button>
              </div>
            }
          />
        }
      />
      <div
        aria-hidden={!dragging}
        className={clsx(
          'pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand-400 bg-brand-50/80 transition-opacity',
          dragging ? 'opacity-100' : 'opacity-0',
        )}
      >
        <p className="flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-medium text-brand-700 shadow">
          <Upload className="size-4" /> Drop files to upload {first?.folder ? `to “${first.folder.name}”` : 'to My Drive'}
        </p>
      </div>
    </div>
  );
}
