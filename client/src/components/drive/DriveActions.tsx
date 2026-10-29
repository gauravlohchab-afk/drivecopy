import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { fileApi, folderApi, trashApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import type { DriveItem, FileItem } from '../../api/types';
import { invalidateDrive } from '../../lib/invalidate';
import { useToast } from '../ui/Toast';
import { NameDialog, MoveDialog, ConfirmDialog } from './dialogs';
import { PreviewModal } from './PreviewModal';

interface Actions {
  open: (item: DriveItem) => void;
  preview: (file: FileItem) => void;
  download: (file: FileItem) => void;
  rename: (item: DriveItem) => void;
  move: (items: DriveItem[]) => void;
  star: (items: DriveItem[], starred: boolean) => void;
  trash: (items: DriveItem[]) => void;
  newFolder: (parentId: string | null) => void;
  restore: (items: DriveItem[]) => void;
  purge: (items: DriveItem[]) => void;
  emptyTrash: () => void;
}

const Ctx = createContext<Actions | null>(null);

type Dialog =
  | { type: 'rename'; item: DriveItem }
  | { type: 'newFolder'; parentId: string | null }
  | { type: 'move'; items: DriveItem[] }
  | { type: 'purge'; items: DriveItem[] }
  | { type: 'emptyTrash' }
  | { type: 'trash'; items: DriveItem[] }
  | null;

/** Runs one request per item and reports partial failures instead of hiding them. */
async function each(items: DriveItem[], fn: (i: DriveItem) => Promise<unknown>) {
  const results = await Promise.allSettled(items.map(fn));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  return { ok: items.length - failed.length, failed: failed.length, firstError: failed[0]?.reason };
}

export function DriveActionsProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [previewing, setPreviewing] = useState<FileItem | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const close = useCallback(() => setDialog(null), []);
  const refresh = useCallback(() => invalidateDrive(qc), [qc]);

  const report = useCallback(
    (verb: string, r: Awaited<ReturnType<typeof each>>) => {
      if (r.failed === 0) toast({ kind: 'success', message: `${verb} ${r.ok === 1 ? '1 item' : `${r.ok} items`}` });
      else toast({ kind: 'error', message: `${r.failed} of ${r.ok + r.failed} failed: ${errorMessage(r.firstError)}` });
    },
    [toast],
  );

  const download = useCallback(
    async (file: FileItem) => {
      try {
        const { url } = await fileApi.downloadUrl(file.id);
        // Short-lived URL with Content-Disposition: attachment; the browser streams it to disk.
        const a = document.createElement('a');
        a.href = url;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (err) {
        toast({ kind: 'error', message: errorMessage(err) });
      }
    },
    [toast],
  );

  const actions = useMemo<Actions>(
    () => ({
      open: (item) => (item.kind === 'folder' ? navigate(`/folders/${item.id}`) : setPreviewing(item)),
      preview: (file) => setPreviewing(file),
      download: (file) => void download(file),
      rename: (item) => setDialog({ type: 'rename', item }),
      move: (items) => setDialog({ type: 'move', items }),
      newFolder: (parentId) => setDialog({ type: 'newFolder', parentId }),
      trash: (items) => setDialog({ type: 'trash', items }),
      purge: (items) => setDialog({ type: 'purge', items }),
      emptyTrash: () => setDialog({ type: 'emptyTrash' }),
      star: async (items, starred) => {
        const r = await each(items, (i) => (i.kind === 'folder' ? folderApi.star(i.id, starred) : fileApi.star(i.id, starred)));
        refresh();
        if (r.failed) report(starred ? 'Starred' : 'Unstarred', r);
      },
      restore: async (items) => {
        const results: boolean[] = [];
        const r = await each(items, async (i) => results.push((await trashApi.restore(i.id)).restoredToRoot));
        refresh();
        report('Restored', r);
        if (results.some(Boolean)) toast({ kind: 'info', message: 'The original folder no longer exists, so some items were restored to My Drive.' });
      },
    }),
    [navigate, download, refresh, report, toast],
  );

  const doTrash = async (items: DriveItem[]) => {
    const r = await each(items, (i) => (i.kind === 'folder' ? folderApi.trash(i.id) : fileApi.trash(i.id)));
    refresh();
    if (r.ok) {
      toast({
        kind: r.failed ? 'error' : 'success',
        message: r.failed ? `${r.failed} item(s) couldn’t be moved: ${errorMessage(r.firstError)}` : `Moved ${r.ok === 1 ? '1 item' : `${r.ok} items`} to Trash`,
        action: { label: 'Undo', onClick: () => actions.restore(items) },
      });
    } else throw r.firstError;
  };

  return (
    <Ctx.Provider value={actions}>
      {children}
      <NameDialog
        open={dialog?.type === 'newFolder'}
        title="New folder"
        initial="Untitled folder"
        confirmLabel="Create"
        onClose={close}
        onSubmit={async (name) => {
          if (dialog?.type !== 'newFolder') return;
          await folderApi.create(name, dialog.parentId);
          refresh();
        }}
      />
      <NameDialog
        open={dialog?.type === 'rename'}
        title="Rename"
        initial={dialog?.type === 'rename' ? dialog.item.name : ''}
        confirmLabel="Rename"
        selectStem={dialog?.type === 'rename' && dialog.item.kind === 'file'}
        onClose={close}
        onSubmit={async (name) => {
          if (dialog?.type !== 'rename') return;
          const it = dialog.item;
          if (it.kind === 'folder') await folderApi.rename(it.id, name);
          else await fileApi.rename(it.id, name);
          refresh();
        }}
      />
      <MoveDialog
        open={dialog?.type === 'move'}
        items={dialog?.type === 'move' ? dialog.items : []}
        onClose={close}
        onMove={async (dest) => {
          if (dialog?.type !== 'move') return;
          const r = await each(dialog.items, (i) => (i.kind === 'folder' ? folderApi.move(i.id, dest) : fileApi.move(i.id, dest)));
          refresh();
          if (r.ok === 0) throw r.firstError;
          report('Moved', r);
        }}
      />
      <ConfirmDialog
        open={dialog?.type === 'trash'}
        title="Move to Trash?"
        body={dialog?.type === 'trash' ? `${dialog.items.length === 1 ? `“${dialog.items[0]!.name}”` : `${dialog.items.length} items`} will move to Trash. Folders go with everything inside them. You can restore them from Trash.` : ''}
        confirmLabel="Move to Trash"
        danger
        onClose={close}
        onConfirm={async () => {
          if (dialog?.type === 'trash') await doTrash(dialog.items);
        }}
      />
      <ConfirmDialog
        open={dialog?.type === 'purge'}
        title="Delete forever?"
        body={dialog?.type === 'purge' ? `${dialog.items.length === 1 ? `“${dialog.items[0]!.name}”` : `${dialog.items.length} items`} will be permanently deleted, including everything inside folders. This can’t be undone.` : ''}
        confirmLabel="Delete forever"
        danger
        onClose={close}
        onConfirm={async () => {
          if (dialog?.type !== 'purge') return;
          let retries = 0;
          const r = await each(dialog.items, async (i) => {
            retries += (await trashApi.purge(i.id)).pendingRetries;
          });
          refresh();
          if (r.ok === 0) throw r.firstError;
          report('Deleted', r);
          if (retries) toast({ kind: 'info', message: `${retries} file(s) are still being removed from storage and will finish automatically.` });
        }}
      />
      <ConfirmDialog
        open={dialog?.type === 'emptyTrash'}
        title="Empty Trash?"
        body="Everything in Trash will be permanently deleted. This can’t be undone."
        confirmLabel="Empty Trash"
        danger
        onClose={close}
        onConfirm={async () => {
          const r = await trashApi.empty();
          refresh();
          toast({ kind: 'success', message: r.pendingRetries ? 'Trash emptied. Some files are still being removed from storage.' : 'Trash emptied' });
        }}
      />
      <PreviewModal file={previewing} onClose={() => setPreviewing(null)} onDownload={(f) => void download(f)} />
    </Ctx.Provider>
  );
}

export function useDriveActions() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDriveActions must be used inside DriveActionsProvider');
  return ctx;
}
