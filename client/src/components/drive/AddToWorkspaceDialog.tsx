import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Shapes } from 'lucide-react';
import { workspaceApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import type { DriveItem, WorkspaceSummary } from '../../api/types';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { useToast } from '../ui/Toast';

const MAX_ITEMS = 25;

/** Pick a workspace for the given items, or create a new one containing them. */
export function AddToWorkspaceDialog({ items, onClose }: { items: DriveItem[] | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['workspaces'], queryFn: workspaceApi.list, enabled: Boolean(items) });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName('');
    setError(null);
    setBusy(null);
  }, [items]);

  const refs = (items ?? []).map((i) => ({ id: i.id, kind: i.kind }));
  const what = items?.length === 1 ? `“${items[0]!.name}”` : `${items?.length ?? 0} items`;

  const done = (w: { name: string }) => {
    void qc.invalidateQueries({ queryKey: ['workspaces'] });
    toast({ kind: 'success', message: `Added ${what} to ${w.name}` });
    onClose();
  };

  const add = async (w: WorkspaceSummary) => {
    setBusy(w.id);
    setError(null);
    try {
      done((await workspaceApi.addItems(w.id, refs)).workspace);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy('new');
    setError(null);
    try {
      done((await workspaceApi.create(name.trim(), refs)).workspace);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  };

  const workspaces = [...(q.data?.workspaces ?? [])].sort((a, b) => Number(a.hidden) - Number(b.hidden));

  return (
    <Modal open={Boolean(items)} onClose={onClose} title="Add to workspace" size="md">
      <p className="mb-3 text-sm text-slate-600">Choose a workspace for {what}. The files stay where they are.</p>
      {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {q.isLoading ? (
        <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
      ) : workspaces.length > 0 ? (
        <ul className="mb-4 max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">
          {workspaces.map((w) => {
            const full = w.itemCount + refs.length > MAX_ITEMS;
            return (
              <li key={w.id}>
                <button
                  type="button"
                  disabled={Boolean(busy) || full}
                  onClick={() => void add(w)}
                  className="focus-ring flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Shapes className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">{w.name}{w.hidden && <span className="ml-2 text-xs font-normal text-slate-500">Hidden</span>}</span>
                    <span className="block text-xs text-slate-500">{full ? 'Full' : `${w.itemCount} of ${MAX_ITEMS} items`}</span>
                  </span>
                  {busy === w.id && <span className="text-xs text-slate-500">Adding…</span>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <form onSubmit={create} noValidate className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Field id="new-workspace-name" label="New workspace" placeholder="Workspace name" maxLength={255} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button type="submit" variant="primary" className="mt-[1.625rem] h-11" icon={<Plus className="size-4" />} loading={busy === 'new'} disabled={!name.trim() || Boolean(busy)}>
          Create
        </Button>
      </form>
    </Modal>
  );
}
