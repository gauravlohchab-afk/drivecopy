import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown, ChevronRight, Eye, EyeOff, FolderOpen, FolderX, LogOut, MoreVertical, Pencil, Plus, Search, Trash2, Users, Network, X,
} from 'lucide-react';
import clsx from 'clsx';
import { driveApi, trashApi } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import type { DriveMember, DriveRole, SharedDriveSummary } from '../api/types';
import { FileBrowser } from '../components/drive/FileBrowser';
import { PageHeader } from '../components/drive/PageHeader';
import { NameDialog, ConfirmDialog } from '../components/drive/dialogs';
import { useDriveActions } from '../components/drive/DriveActions';
import { EmptyState, ErrorState, GridSkeleton } from '../components/ui/States';
import { Button, IconButton } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Modal } from '../components/ui/Modal';
import { Menu, anchorBelow, type MenuEntry } from '../components/ui/Menu';
import { useToast } from '../components/ui/Toast';
import { useViewPrefs } from '../hooks/usePrefs';

export const ROLE_LABEL: Record<DriveRole, string> = { manager: 'Manager', content_manager: 'Content manager', viewer: 'Viewer' };
const ROLE_HELP: Record<DriveRole, string> = {
  manager: 'Manage members and the drive, plus everything below',
  content_manager: 'Add, edit, move and delete files',
  viewer: 'View and download only',
};
const ROLES: DriveRole[] = ['manager', 'content_manager', 'viewer'];

type DriveDialog =
  | { type: 'create' }
  | { type: 'rename'; drive: SharedDriveSummary }
  | { type: 'delete'; drive: SharedDriveSummary }
  | { type: 'leave'; drive: SharedDriveSummary }
  | { type: 'members'; drive: SharedDriveSummary }
  | null;

/** Everything you can do to a drive itself, shared by the list page and the drive page. */
export function useDriveMenu({ onGone }: { onGone?: () => void } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<DriveDialog>(null);
  const close = () => setDialog(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['drives'] });

  const setHidden = async (d: SharedDriveSummary, hidden: boolean) => {
    try {
      await driveApi.update(d.id, { hidden });
      refresh();
      toast({ kind: 'success', message: hidden ? `Hid ${d.name}` : `${d.name} is visible again` });
    } catch (err) {
      toast({ kind: 'error', message: errorMessage(err) });
    }
  };

  const entries = (d: SharedDriveSummary, opts: { open?: boolean } = {}): MenuEntry[] => [
    ...(opts.open ? [{ label: 'Open', icon: <FolderOpen />, onSelect: () => navigate(`/drives/${d.id}`) }] : []),
    { label: d.role === 'manager' ? 'Manage members' : 'View members', icon: <Users />, onSelect: () => setDialog({ type: 'members', drive: d }) },
    { label: 'Trash', icon: <Trash2 />, onSelect: () => navigate(`/drives/${d.id}/trash`) },
    ...(d.role === 'manager' ? [{ label: 'Rename', icon: <Pencil />, onSelect: () => setDialog({ type: 'rename', drive: d }) }] : []),
    d.hidden
      ? { label: 'Show shared drive', icon: <Eye />, onSelect: () => void setHidden(d, false) }
      : { label: 'Hide shared drive', icon: <EyeOff />, onSelect: () => void setHidden(d, true) },
    'separator',
    { label: 'Leave shared drive', icon: <LogOut />, onSelect: () => setDialog({ type: 'leave', drive: d }) },
    ...(d.role === 'manager' ? [{ label: 'Delete shared drive', icon: <Trash2 />, danger: true, onSelect: () => setDialog({ type: 'delete', drive: d }) }] : []),
  ];

  const dialogs = (
    <>
      <NameDialog
        open={dialog?.type === 'create'}
        title="New shared drive"
        initial="Untitled shared drive"
        confirmLabel="Create"
        onClose={close}
        onSubmit={async (name) => {
          const { drive } = await driveApi.create(name);
          refresh();
          navigate(`/drives/${drive.id}`);
        }}
      />
      <NameDialog
        open={dialog?.type === 'rename'}
        title="Rename shared drive"
        initial={dialog?.type === 'rename' ? dialog.drive.name : ''}
        confirmLabel="Rename"
        onClose={close}
        onSubmit={async (name) => {
          if (dialog?.type !== 'rename') return;
          await driveApi.update(dialog.drive.id, { name });
          refresh();
        }}
      />
      <ConfirmDialog
        open={dialog?.type === 'delete'}
        title="Delete shared drive?"
        body={dialog?.type === 'delete' ? `“${dialog.drive.name}” will be deleted for everyone. The drive must be empty, including its Trash.` : ''}
        confirmLabel="Delete shared drive"
        danger
        onClose={close}
        onConfirm={async () => {
          if (dialog?.type !== 'delete') return;
          await driveApi.remove(dialog.drive.id);
          refresh();
          toast({ kind: 'success', message: `Deleted ${dialog.drive.name}` });
          onGone?.();
        }}
      />
      <ConfirmDialog
        open={dialog?.type === 'leave'}
        title="Leave shared drive?"
        body={dialog?.type === 'leave' ? `You’ll lose access to “${dialog.drive.name}” until a manager adds you again. Its files stay in the drive.` : ''}
        confirmLabel="Leave"
        danger
        onClose={close}
        onConfirm={async () => {
          if (dialog?.type !== 'leave') return;
          const me = (await driveApi.members(dialog.drive.id)).members.find((m) => m.isYou);
          if (me) await driveApi.removeMember(dialog.drive.id, me.userId);
          refresh();
          toast({ kind: 'success', message: `You left ${dialog.drive.name}` });
          onGone?.();
        }}
      />
      <DriveMembersDialog drive={dialog?.type === 'members' ? dialog.drive : null} onClose={close} />
    </>
  );

  return { entries, dialogs, create: () => setDialog({ type: 'create' }), members: (d: SharedDriveSummary) => setDialog({ type: 'members', drive: d }) };
}

function Avatar({ name }: { name: string }) {
  return (
    <span aria-hidden className="avatar">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Members and roles. Managers add people, change roles and remove; everyone else sees the list. */
export function DriveMembersDialog({ drive, onClose }: { drive: SharedDriveSummary | null; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ['drives', drive?.id, 'members'];
  const q = useQuery({ queryKey: key, queryFn: () => driveApi.members(drive!.id), enabled: Boolean(drive) });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<DriveRole>('content_manager');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manager = drive?.role === 'manager';

  useEffect(() => {
    setEmail('');
    setError(null);
  }, [drive?.id]);

  const apply = async (fn: () => Promise<{ members: DriveMember[] }>) => {
    setError(null);
    try {
      qc.setQueryData(key, await fn());
      void qc.invalidateQueries({ queryKey: ['drives'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!drive || !email.trim()) return;
    setBusy(true);
    await apply(() => driveApi.addMember(drive.id, email.trim(), role));
    setBusy(false);
    setEmail('');
  };

  return (
    <Modal open={Boolean(drive)} onClose={onClose} title={drive ? `Members of “${drive.name}”` : 'Members'} size="md" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      {manager && (
        <form onSubmit={add} noValidate className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-start">
          <Field id="member-email" label="Add people" type="email" placeholder="Email address" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          <div>
            <label htmlFor="member-role" className="label">Role</label>
            <select id="member-role" value={role} onChange={(e) => setRole(e.target.value as DriveRole)} className="input focus-ring">
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </div>
          <Button type="submit" variant="primary" className="h-11 sm:mt-[1.625rem]" loading={busy} disabled={!email.trim()}>Add</Button>
        </form>
      )}
      {error && <p role="alert" className="alert alert-error mb-3">{error}</p>}
      <ul className="list-box">
        {q.isLoading && <li className="px-3 py-3"><div className="skeleton h-9" /></li>}
        {q.data?.members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <Avatar name={m.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{m.name}{m.isYou && ' (you)'}</p>
              <p className="truncate text-xs text-ink-muted">{m.email}</p>
            </div>
            {manager ? (
              <>
                <label className="sr-only" htmlFor={`role-${m.userId}`}>Role for {m.name}</label>
                <select
                  id={`role-${m.userId}`}
                  value={m.role}
                  onChange={(e) => void apply(() => driveApi.setRole(drive!.id, m.userId, e.target.value as DriveRole))}
                  className="input input-sm focus-ring w-auto px-2"
                >
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                {!m.isYou && (
                  <IconButton label={`Remove ${m.name}`} onClick={() => void apply(() => driveApi.removeMember(drive!.id, m.userId))}><X className="size-4" /></IconButton>
                )}
              </>
            ) : (
              <span className="text-xs text-ink-muted">{ROLE_LABEL[m.role]}</span>
            )}
          </li>
        ))}
      </ul>
      <ul className="mt-3 space-y-0.5 text-xs text-ink-muted">
        {ROLES.map((r) => <li key={r}><span className="font-medium text-ink-soft">{ROLE_LABEL[r]}:</span> {ROLE_HELP[r]}</li>)}
      </ul>
    </Modal>
  );
}

function DriveCard({ d, view, onMenu }: { d: SharedDriveSummary; view: 'grid' | 'list'; onMenu: (el: HTMLElement) => void }) {
  const navigate = useNavigate();
  return (
    <li className={clsx('group relative flex items-center gap-3 border-line bg-surface transition-colors hover:bg-surface-muted', view === 'grid' ? 'rounded-card border p-3' : 'px-4 py-2.5')}>
      <span aria-hidden className={clsx('flex size-10 shrink-0 items-center justify-center rounded-card', d.hidden ? 'bg-surface-hover text-ink-muted' : 'bg-accent-soft text-accent')}>
        <Network className="size-5" />
      </span>
      <button type="button" onClick={() => navigate(`/drives/${d.id}`)} className="focus-ring min-w-0 flex-1 rounded text-left after:absolute after:inset-0 after:content-['']">
        <span className="block truncate text-sm font-semibold text-ink">{d.name}</span>
        <span className="block text-xs text-ink-muted">{ROLE_LABEL[d.role]} · {d.memberCount} {d.memberCount === 1 ? 'member' : 'members'}</span>
      </button>
      <IconButton label={`More actions for ${d.name}`} className="relative z-10 size-8" onClick={(e) => onMenu(e.currentTarget)}>
        <MoreVertical className="size-4" />
      </IconButton>
    </li>
  );
}

export function SharedDrivesPage() {
  const prefs = useViewPrefs();
  const q = useQuery({ queryKey: ['drives', 'list'], queryFn: driveApi.list });
  const menu = useDriveMenu();
  const [at, setAt] = useState<{ x: number; y: number; d: SharedDriveSummary } | null>(null);
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);

  const all = q.data?.drives ?? [];
  const match = (d: SharedDriveSummary) => d.name.toLowerCase().includes(filter.trim().toLowerCase());
  const visible = all.filter((d) => !d.hidden && match(d));
  const hidden = all.filter((d) => d.hidden && match(d));
  const list = (items: SharedDriveSummary[]) => (
    <ul className={prefs.view === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3' : 'divide-y divide-line-subtle overflow-hidden rounded-card border border-line'}>
      {items.map((d) => <DriveCard key={d.id} d={d} view={prefs.view} onMenu={(el) => setAt({ ...anchorBelow(el), d })} />)}
    </ul>
  );

  return (
    <>
      <PageHeader
        title="Shared drives"
        view={prefs.view}
        onView={prefs.setView}
        extra={all.length > 0 && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={menu.create}>New</Button>}
      />
      {q.isLoading ? (
        <GridSkeleton />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState
          icon={<Network />}
          title="A place for teamwork"
          body="Use shared drives to organise, store and work on files together. Files belong to the team, not one person, so they stay when people come and go."
          action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={menu.create}>Create a shared drive</Button>}
        />
      ) : (
        <div className="space-y-5">
          <div className="relative max-w-xs">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <label htmlFor="drive-filter" className="sr-only">Shared drive name</label>
            <input id="drive-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Shared drive name" className="input input-sm focus-ring h-10 pl-9" />
          </div>
          {visible.length > 0 ? list(visible) : <p className="text-sm text-ink-muted">{filter ? 'No shared drives match that name.' : 'All your shared drives are hidden.'}</p>}
          {hidden.length > 0 && (
            <section aria-label="Hidden shared drives" className="border-t border-line-subtle pt-4">
              <button type="button" aria-expanded={showHidden} onClick={() => setShowHidden((s) => !s)} className="focus-ring mb-3 flex items-center gap-1.5 rounded text-sm font-semibold text-ink-soft">
                {showHidden ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                Hidden shared drives <span className="font-normal text-ink-muted">({hidden.length})</span>
              </button>
              {showHidden && list(hidden)}
            </section>
          )}
        </div>
      )}
      <Menu label="Shared drive actions" at={at} title={at && <span className="truncate">{at.d.name}</span>} items={at ? menu.entries(at.d, { open: true }) : []} onClose={() => setAt(null)} />
      {menu.dialogs}
    </>
  );
}

/** Header controls on a drive's own pages: members button and the drive menu. */
export function DriveHeaderActions({ drive }: { drive: SharedDriveSummary }) {
  const navigate = useNavigate();
  const menu = useDriveMenu({ onGone: () => navigate('/drives') });
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <Button size="sm" variant="ghost" icon={<Users className="size-4" />} onClick={() => menu.members(drive)} className="hidden sm:inline-flex">
        {drive.role === 'manager' ? 'Manage members' : 'Members'}
      </Button>
      <IconButton label={`Shared drive actions for ${drive.name}`} onClick={(e) => setAt(anchorBelow(e.currentTarget))}>
        <MoreVertical className="size-4" />
      </IconButton>
      <Menu label="Shared drive actions" at={at} title={<span className="truncate">{drive.name}</span>} items={menu.entries(drive)} onClose={() => setAt(null)} />
      {menu.dialogs}
    </>
  );
}

export function DriveUnavailable() {
  return (
    <EmptyState
      icon={<FolderX />}
      title="This shared drive isn’t available"
      body="It may have been deleted, or you’re no longer a member."
      action={<Link to="/drives" className="btn btn-primary focus-ring">Go to Shared drives</Link>}
    />
  );
}

export function DriveTrashPage() {
  const { driveId = '' } = useParams();
  const prefs = useViewPrefs();
  const actions = useDriveActions();
  const info = useQuery({ queryKey: ['drives', driveId, 'info'], queryFn: () => driveApi.get(driveId), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });
  const q = useQuery({ queryKey: ['drives', driveId, 'trash'], queryFn: () => trashApi.list(driveId), enabled: Boolean(info.data) });
  if (info.error instanceof ApiError && info.error.status === 404) return <DriveUnavailable />;
  const drive = info.data?.drive;
  const count = (q.data?.folders.length ?? 0) + (q.data?.files.length ?? 0);
  const canEdit = drive && drive.role !== 'viewer';

  return (
    <>
      <PageHeader
        title={
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex min-w-0 items-center gap-0.5 text-lg font-semibold text-ink-strong sm:text-xl">
              <li className="flex min-w-0 shrink items-center">
                <Link to={`/drives/${driveId}`} className="focus-ring truncate rounded-lg px-1.5 py-1 font-medium text-ink-muted hover:bg-surface-hover hover:text-ink">{drive?.name ?? '…'}</Link>
              </li>
              <li className="flex shrink-0 items-center">
                <ChevronRight className="mx-0.5 size-4 text-ink-faint" aria-hidden />
                <span aria-current="page" className="px-1.5 py-1">Trash</span>
              </li>
            </ol>
          </nav>
        }
        view={prefs.view}
        onView={prefs.setView}
        extra={count > 0 && canEdit && <Button size="sm" variant="danger-ghost" className="mr-1" onClick={() => actions.emptyTrash(driveId)}>Empty Trash</Button>}
      />
      {count > 0 && <p className="alert alert-info mb-4">Items in this drive’s Trash still count toward the drive’s storage until they’re deleted forever.</p>}
      <FileBrowser
        mode={canEdit ? 'trash' : 'shared'}
        folders={q.data?.folders ?? []}
        files={q.data?.files ?? []}
        view={prefs.view}
        isLoading={info.isLoading || q.isLoading}
        error={info.error ?? q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState icon={<Trash2 />} title="Trash is empty" body="Items deleted from this shared drive appear here until they’re restored or deleted forever." />}
      />
    </>
  );
}

