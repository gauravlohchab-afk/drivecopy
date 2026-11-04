import { useLayoutEffect, useCallback, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Folder, HardDrive, ArrowLeft } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { folderApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import type { DriveItem } from '../../api/types';

const nameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter a name')
    .max(255, 'Name must be at most 255 characters')
    .refine((n) => !/[/\\]/.test(n), 'Names cannot contain / or \\')
    .refine((n) => n !== '.' && n !== '..', 'That name is not allowed'),
});

export function NameDialog({
  open, title, initial, confirmLabel, onClose, onSubmit, selectStem,
}: {
  open: boolean;
  title: string;
  initial: string;
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
  selectStem?: boolean;
}) {
  const { register, handleSubmit, reset, setError, formState } = useForm<{ name: string }>({ resolver: zodResolver(nameSchema), defaultValues: { name: initial } });
  const { ref: fieldRef, ...field } = register('name');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setRefs = useCallback(
    (el: HTMLInputElement | null) => {
      fieldRef(el);
      inputRef.current = el;
    },
    [fieldRef],
  );

  // Layout effect: the field must hold the starting name before the dialog becomes visible, or
  // text typed or pasted in the first frame would be overwritten.
  useLayoutEffect(() => {
    if (!open) return;
    reset({ name: initial });
    // Focus once per opening and pre-select the name (without the extension for files).
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = el.value.lastIndexOf('.');
      if (selectStem && dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open, initial, reset, selectStem]);

  const submit = handleSubmit(async ({ name }) => {
    try {
      await onSubmit(name);
      onClose();
    } catch (err) {
      setError('name', { message: errorMessage(err) });
    }
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={formState.isSubmitting} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate>
        <label htmlFor="item-name" className="sr-only">Name</label>
        <input
          id="item-name"
          {...field}
          ref={setRefs}
          aria-invalid={Boolean(formState.errors.name)}
          aria-describedby="item-name-error"
          autoComplete="off"
          className="input focus-ring"
        />
        <p id="item-name-error" className="field-error min-h-5">{formState.errors.name?.message}</p>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({
  open, title, body, confirmLabel, danger, onClose, onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-soft">{body}</p>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </Modal>
  );
}

/** Folder picker for moves. Folders being moved (and therefore their subtrees) are not selectable. */
export function MoveDialog({ open, items, onClose, onMove }: { open: boolean; items: DriveItem[]; onClose: () => void; onMove: (destination: string | null) => Promise<void> }) {
  // Items move within their own place: My Drive, or the shared drive they're in.
  const driveId = items[0]?.driveId ?? null;
  const rootName = driveId ? items[0]?.driveName ?? 'Shared drive' : 'My Drive';
  const [trail, setTrail] = useState<{ id: string | null; name: string }[]>([{ id: null, name: rootName }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = trail[trail.length - 1]!;
  const movingIds = new Set(items.filter((i) => i.kind === 'folder').map((i) => i.id));

  useEffect(() => {
    if (open) {
      setTrail([{ id: null, name: rootName }]);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const q = useQuery({ queryKey: ['folders', driveId, current.id], queryFn: () => folderApi.list(current.id, driveId), enabled: open });
  const title = items.length === 1 ? `Move “${items[0]!.name}”` : `Move ${items.length} items`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onMove(current.id);
                onClose();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Move here
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2 text-sm">
        {trail.length > 1 && (
          <button type="button" aria-label="Back" className="focus-ring rounded p-1 text-ink-muted hover:bg-surface-hover" onClick={() => setTrail((t) => t.slice(0, -1))}>
            <ArrowLeft className="size-4" />
          </button>
        )}
        <span className="flex min-w-0 items-center gap-1 font-medium text-ink-soft">
          {trail.length === 1 && <HardDrive className="size-4 text-ink-faint" />}
          <span className="truncate">{current.name}</span>
        </span>
      </div>
      <div className="max-h-72 min-h-40 overflow-auto rounded-lg border border-line">
        {q.isLoading && <p className="p-4 text-sm text-ink-muted">Loading folders…</p>}
        {q.isError && <p className="p-4 text-sm text-danger">{errorMessage(q.error)}</p>}
        {q.data && q.data.items.length === 0 && <p className="p-4 text-sm text-ink-muted">No subfolders. Move items here or go back.</p>}
        <ul>
          {q.data?.items.map((f) => {
            const blocked = movingIds.has(f.id);
            return (
              <li key={f.id}>
                <button
                  type="button"
                  disabled={blocked}
                  onClick={() => setTrail((t) => [...t, { id: f.id, name: f.name }])}
                  className="focus-ring flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Folder className="size-4 text-accent" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  {blocked ? <span className="text-xs text-ink-faint">Being moved</span> : <ChevronRight className="size-4 text-ink-faint" />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </Modal>
  );
}
