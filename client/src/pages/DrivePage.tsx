import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { FolderX, HardDrive, Upload, FolderPlus, Network } from 'lucide-react';
import clsx from 'clsx';
import { driveApi, folderApi } from '../api/endpoints';
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
import { formatBytes } from '../lib/format';
import { DriveHeaderActions, DriveUnavailable, ROLE_LABEL } from './SharedDrivePages';

/** My Drive and its folders, or (with :driveId) a shared drive and its folders. */
export function DrivePage() {
  const { folderId = null, driveId = null } = useParams();
  const prefs = useViewPrefs();
  const actions = useDriveActions();
  const manager = useUploadManager();
  const toast = useToast();
  const pickers = useRef<UploadPickersHandle>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const notFound = (err: unknown) => err instanceof ApiError && err.status === 404;

  const info = useQuery({
    queryKey: ['drives', driveId, 'info'],
    queryFn: () => driveApi.get(driveId!),
    enabled: Boolean(driveId),
    retry: (n, err) => !notFound(err) && n < 2,
  });
  const drive = info.data?.drive;
  const canEdit = !driveId || (drive !== undefined && drive.role !== 'viewer');

  const q = useInfiniteQuery({
    queryKey: driveId ? ['drives', driveId, 'contents', folderId, prefs.sort, prefs.order] : ['contents', folderId, prefs.sort, prefs.order],
    queryFn: ({ pageParam }) => folderApi.contents(folderId, { sort: prefs.sort, order: prefs.order, cursor: pageParam }, driveId),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: (n, err) => !notFound(err) && n < 2,
  });

  if (driveId && notFound(info.error)) return <DriveUnavailable />;
  if (notFound(q.error)) {
    const home = driveId ? `/drives/${driveId}` : '/drive';
    return (
      <EmptyState
        icon={<FolderX />}
        title="This folder isn’t available"
        body="It may have been moved to Trash or deleted, or the link is wrong."
        action={<Link to={home} className="focus-ring rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">{driveId ? `Go to ${drive?.name ?? 'the shared drive'}` : 'Go to My Drive'}</Link>}
      />
    );
  }

  const first = q.data?.pages[0];
  const folders = first?.folders ?? [];
  const files = q.data?.pages.flatMap((p) => p.files) ?? [];
  const placeName = driveId ? drive?.name ?? 'Shared drive' : 'My Drive';

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!canEdit) return;
    const items = [...e.dataTransfer.items];
    const hasDirs = items.some((i) => i.webkitGetAsEntry?.()?.isDirectory);
    const dropped = [...e.dataTransfer.files].filter((_, idx) => !items[idx]?.webkitGetAsEntry?.()?.isDirectory);
    if (hasDirs) toast({ kind: 'info', message: 'To upload a folder, use New → Upload folder.' });
    if (dropped.length) manager.add(dropped, folderId, driveId);
  };

  const title = folderId ? (
    first ? <Breadcrumbs path={first.path} rootLabel={placeName} driveId={driveId ?? undefined} /> : <div className="h-7 w-48 animate-pulse rounded bg-slate-100" />
  ) : (
    <h1 className="flex min-w-0 items-center gap-2 truncate text-xl font-semibold text-slate-900">
      {driveId && <Network className="size-5 shrink-0 text-brand-600" aria-hidden />}
      <span className="truncate">{placeName}</span>
    </h1>
  );

  return (
    <div
      className="relative min-h-[60vh]"
      onDragEnter={(e) => {
        if (!canEdit || ![...e.dataTransfer.types].includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (canEdit && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <PageHeader
        title={title}
        view={prefs.view}
        onView={prefs.setView}
        sort={prefs.sort}
        order={prefs.order}
        onSort={prefs.setSort}
        onUpload={canEdit ? () => pickers.current?.pickFiles() : undefined}
        extra={drive && <DriveHeaderActions drive={drive} />}
      />
      {drive && (
        <p className="-mt-2 mb-3 px-1 text-xs text-slate-500">
          Shared drive · {ROLE_LABEL[drive.role]}
          {drive.usage && ` · ${formatBytes(drive.usage.used)} of ${formatBytes(drive.usage.quota)} used`}
        </p>
      )}
      <UploadPickers ref={pickers} parentId={folderId} driveId={driveId} />
      <FileBrowser
        folders={folders}
        files={files}
        view={prefs.view}
        isLoading={q.isLoading || (Boolean(driveId) && info.isLoading)}
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
            icon={driveId ? <Network /> : <HardDrive />}
            title={folderId ? 'This folder is empty' : driveId ? 'This shared drive is empty' : 'Your drive is empty'}
            body={canEdit ? 'Drop files here, or use the buttons below to add the first files.' : 'Nothing has been added here yet.'}
            action={
              canEdit && (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => pickers.current?.pickFiles()}>Upload files</Button>
                  <Button icon={<FolderPlus className="size-4" />} onClick={() => actions.newFolder(folderId, driveId)}>New folder</Button>
                </div>
              )
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
          <Upload className="size-4" /> Drop files to upload {first?.folder ? `to “${first.folder.name}”` : `to ${placeName}`}
        </p>
      </div>
    </div>
  );
}
