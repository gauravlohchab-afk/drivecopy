import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Eye, EyeOff, FolderOpen, FolderX, MinusCircle, MoreVertical, Pencil, Plus, Shapes, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { workspaceApi } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import type { DriveItem, WorkspaceSummary } from '../api/types';
import { FileBrowser } from '../components/drive/FileBrowser';
import { PageHeader } from '../components/drive/PageHeader';
import { NameDialog, ConfirmDialog } from '../components/drive/dialogs';
import { EmptyState, ErrorState, GridSkeleton } from '../components/ui/States';
import { Button, IconButton } from '../components/ui/Button';
import { Menu, anchorBelow } from '../components/ui/Menu';
import { useToast } from '../components/ui/Toast';
import { useViewPrefs } from '../hooks/usePrefs';
import { formatDate } from '../lib/format';

const pluralItems = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

type Dialog = { type: 'create' } | { type: 'rename'; ws: WorkspaceSummary } | { type: 'delete'; ws: WorkspaceSummary } | null;

/** Create / rename / hide / delete, shared by the list and the single-workspace page. */
function useWorkspaceDialogs(onDeleted?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['workspaces'] });
  const close = () => setDialog(null);

  const setHidden = async (ws: WorkspaceSummary, hidden: boolean) => {
    try {
      await workspaceApi.update(ws.id, { hidden });
      refresh();
      toast({ kind: 'success', message: hidden ? `Hid ${ws.name}` : `${ws.name} is visible again` });
    } catch (err) {
      toast({ kind: 'error', message: errorMessage(err) });
    }
  };

  const dialogs = (
    <>
      <NameDialog
        open={dialog?.type === 'create'}
        title="New workspace"
        initial="Untitled workspace"
        confirmLabel="Create"
        onClose={close}
        onSubmit={async (name) => {
          await workspaceApi.create(name, []);
          refresh();
        }}
      />
      <NameDialog
        open={dialog?.type === 'rename'}
        title="Rename workspace"
        initial={dialog?.type === 'rename' ? dialog.ws.name : ''}
        confirmLabel="Rename"
        onClose={close}
        onSubmit={async (name) => {
          if (dialog?.type !== 'rename') return;
          await workspaceApi.update(dialog.ws.id, { name });
          refresh();
        }}
      />
      <ConfirmDialog
        open={dialog?.type === 'delete'}
        title="Delete workspace?"
        body={dialog?.type === 'delete' ? `“${dialog.ws.name}” will be deleted. The files and folders in it are not affected.` : ''}
        confirmLabel="Delete workspace"
        danger
        onClose={close}
        onConfirm={async () => {
          if (dialog?.type !== 'delete') return;
          await workspaceApi.remove(dialog.ws.id);
          refresh();
          toast({ kind: 'success', message: `Deleted ${dialog.ws.name}` });
          onDeleted?.();
        }}
      />
    </>
  );

  const menuFor = (ws: WorkspaceSummary, open?: () => void) => [
    ...(open ? [{ label: 'Open', icon: <FolderOpen />, onSelect: open }] : []),
    { label: 'Rename', icon: <Pencil />, onSelect: () => setDialog({ type: 'rename', ws }) },
    ws.hidden
      ? { label: 'Show workspace', icon: <Eye />, onSelect: () => void setHidden(ws, false) }
      : { label: 'Hide workspace', icon: <EyeOff />, onSelect: () => void setHidden(ws, true) },
    'separator' as const,
    { label: 'Delete workspace', icon: <Trash2 />, danger: true, onSelect: () => setDialog({ type: 'delete', ws }) },
  ];

  return { dialogs, menuFor, create: () => setDialog({ type: 'create' }) };
}

function WorkspaceCard({ ws, onMenu }: { ws: WorkspaceSummary; onMenu: (el: HTMLElement) => void }) {
  const navigate = useNavigate();
  return (
    <li className="group relative flex items-center gap-3 rounded-card border border-line bg-surface p-3 transition-colors hover:border-line-strong hover:bg-surface-muted">
      <span aria-hidden className={clsx('flex size-11 shrink-0 items-center justify-center rounded-card', ws.hidden ? 'bg-surface-hover text-ink-muted' : 'bg-accent-soft text-accent')}>
        <Shapes className="size-5" />
      </span>
      <button type="button" onClick={() => navigate(`/workspaces/${ws.id}`)} className="focus-ring min-w-0 flex-1 rounded text-left after:absolute after:inset-0 after:content-['']">
        <span className="block truncate text-sm font-semibold text-ink">{ws.name}</span>
        <span className="block text-xs text-ink-muted">{ws.itemCount} {ws.itemCount === 1 ? 'item' : 'items'} · Updated {formatDate(ws.updatedAt)}</span>
      </button>
      <IconButton label={`More actions for ${ws.name}`} className="relative z-10 size-8" onClick={(e) => onMenu(e.currentTarget)}>
        <MoreVertical className="size-4" />
      </IconButton>
    </li>
  );
}

export function WorkspacesPage() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['workspaces'], queryFn: workspaceApi.list });
  const { dialogs, menuFor, create } = useWorkspaceDialogs();
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; ws: WorkspaceSummary } | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const all = q.data?.workspaces ?? [];
  const visible = all.filter((w) => !w.hidden);
  const hidden = all.filter((w) => w.hidden);
  const grid = (list: WorkspaceSummary[]) => (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
      {list.map((ws) => <WorkspaceCard key={ws.id} ws={ws} onMenu={(el) => setMenu({ at: anchorBelow(el), ws })} />)}
    </ul>
  );

  return (
    <>
      <PageHeader
        title="Workspaces"
        extra={all.length > 0 && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={create}>New workspace</Button>}
      />
      {q.isLoading ? (
        <GridSkeleton />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="space-y-6">
          {visible.length === 0 && (
            <EmptyState
              icon={<Shapes />}
              title="Create your own personal workspace"
              body="Gather the files and folders you’re working on in one place, so you can pick up right where you left off."
              action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={create}>Create workspace</Button>}
            />
          )}
          {visible.length > 0 && grid(visible)}
          {hidden.length > 0 && (
            <section aria-label="Hidden workspaces" className="border-t border-line-subtle pt-4">
              <button
                type="button"
                aria-expanded={showHidden}
                onClick={() => setShowHidden((s) => !s)}
                className="focus-ring mb-3 flex items-center gap-1.5 rounded text-sm font-semibold text-ink-soft"
              >
                {showHidden ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                Hidden workspaces <span className="font-normal text-ink-muted">({hidden.length})</span>
              </button>
              {showHidden && grid(hidden)}
            </section>
          )}
        </div>
      )}
      <Menu
        label="Workspace actions"
        at={menu?.at ?? null}
        title={menu && <span className="truncate">{menu.ws.name}</span>}
        items={menu ? menuFor(menu.ws, () => navigate(`/workspaces/${menu.ws.id}`)) : []}
        onClose={() => setMenu(null)}
      />
      {dialogs}
    </>
  );
}

export function WorkspacePage() {
  const { workspaceId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const prefs = useViewPrefs();
  const q = useQuery({
    queryKey: ['workspaces', workspaceId],
    queryFn: () => workspaceApi.get(workspaceId),
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });
  const { dialogs, menuFor } = useWorkspaceDialogs(() => navigate('/workspaces'));
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  if (q.error instanceof ApiError && q.error.status === 404) {
    return (
      <EmptyState
        icon={<FolderX />}
        title="This workspace isn’t available"
        body="It may have been deleted."
        action={<Link to="/workspaces" className="btn btn-primary focus-ring">Go to Workspaces</Link>}
      />
    );
  }

  const ws = q.data?.workspace;
  const removeItems = async (items: DriveItem[]) => {
    const results = await Promise.allSettled(items.map((i) => workspaceApi.removeItem(workspaceId, i.id)));
    void qc.invalidateQueries({ queryKey: ['workspaces'] });
    const failed = results.filter((r) => r.status === 'rejected').length;
    toast(failed ? { kind: 'error', message: `${failed} item(s) couldn’t be removed` } : { kind: 'success', message: `Removed ${items.length === 1 ? '1 item' : `${items.length} items`} from ${ws?.name ?? 'workspace'}` });
  };

  return (
    <>
      <PageHeader
        title={
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex min-w-0 items-center gap-0.5 text-lg font-semibold text-ink-strong sm:text-xl">
              <li className="flex shrink-0 items-center">
                <Link to="/workspaces" className="focus-ring rounded-lg px-1.5 py-1 font-medium text-ink-muted hover:bg-surface-hover hover:text-ink">Workspaces</Link>
              </li>
              <li className="flex min-w-0 items-center">
                <ChevronRight className="mx-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
                {ws ? <span aria-current="page" className="truncate px-1.5 py-1">{ws.name}</span> : <span className="skeleton h-6 w-32" />}
              </li>
            </ol>
          </nav>
        }
        view={prefs.view}
        onView={prefs.setView}
        extra={ws && (
          <IconButton label={`Workspace actions for ${ws.name}`} onClick={(e) => setMenuAt(anchorBelow(e.currentTarget))}>
            <MoreVertical className="size-4" />
          </IconButton>
        )}
      />
      {ws && q.data && (
        <p className="-mt-2 mb-3 px-1 text-xs text-ink-muted">
          {pluralItems(q.data.folders.length + q.data.files.length)}
          {q.data.unavailable > 0 && ` · ${q.data.unavailable} unavailable (in Trash or no longer shared)`}
          {ws.hidden && ' · Hidden workspace'}
        </p>
      )}
      <FileBrowser
        folders={q.data?.folders ?? []}
        files={q.data?.files ?? []}
        view={prefs.view}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        extraEntries={(targets) => [{ label: 'Remove from workspace', icon: <MinusCircle />, onSelect: () => void removeItems(targets) }]}
        empty={
          <EmptyState
            icon={<Shapes />}
            title="This workspace is empty"
            body="Add files and folders from their ⋮ menu: choose “Add to workspace”."
            action={<Link to="/drive" className="btn btn-primary focus-ring">Go to My Drive</Link>}
          />
        }
      />
      <Menu label="Workspace actions" at={menuAt} items={ws ? menuFor(ws) : []} title={ws && <span className="truncate">{ws.name}</span>} onClose={() => setMenuAt(null)} />
      {dialogs}
    </>
  );
}
