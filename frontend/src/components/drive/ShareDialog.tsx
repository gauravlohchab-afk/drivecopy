import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { shareApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import type { DriveItem, SharePerson } from '../../api/types';
import { Modal } from '../ui/Modal';
import { Button, IconButton } from '../ui/Button';
import { Field } from '../ui/Field';
import { useAuth } from '../../hooks/useAuth';

function Avatar({ name }: { name: string }) {
  return (
    <span aria-hidden className="avatar">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Owner view of who can see an item: add people by email, remove them again. */
export function ShareDialog({ item, onClose }: { item: DriveItem | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = ['shares', item?.kind, item?.id];
  const q = useQuery({ queryKey: key, queryFn: () => shareApi.people(item!), enabled: Boolean(item) });

  useEffect(() => {
    setEmail('');
    setError(null);
  }, [item?.id]);

  const update = (people: SharePerson[]) => qc.setQueryData(key, { people });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      update((await shareApi.add(item, email.trim())).people);
      setEmail('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: SharePerson) => {
    if (!item) return;
    try {
      update((await shareApi.remove(item, p.userId)).people);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      open={Boolean(item)}
      onClose={onClose}
      title={item ? `Share “${item.name}”` : 'Share'}
      size="md"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <form onSubmit={submit} noValidate className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Field
            id="share-email"
            label="Add people"
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={error ?? undefined}
          />
        </div>
        <Button type="submit" variant="primary" className="mt-[1.625rem] h-11" loading={busy} disabled={!email.trim()}>Share</Button>
      </form>
      <p className="mt-2 text-xs text-ink-muted">
        People you add can view and download {item?.kind === 'folder' ? 'this folder and everything in it' : 'this file'}. They can’t change or delete anything.
      </p>

      <h3 className="mb-2 mt-5 text-sm font-medium text-ink-soft">People with access</h3>
      <ul className="list-box">
        {user && (
          <li className="flex items-center gap-3 px-3 py-2.5">
            <Avatar name={user.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{user.name} (you)</p>
              <p className="truncate text-xs text-ink-muted">{user.email}</p>
            </div>
            <span className="text-xs text-ink-muted">Owner</span>
          </li>
        )}
        {q.isLoading && <li className="px-3 py-3"><div className="skeleton h-9" /></li>}
        {q.data?.people.map((p) => (
          <li key={p.userId} className="flex items-center gap-3 px-3 py-2">
            <Avatar name={p.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{p.name}</p>
              <p className="truncate text-xs text-ink-muted">{p.email}</p>
            </div>
            <span className="text-xs text-ink-muted">Viewer</span>
            <IconButton label={`Remove ${p.name}`} onClick={() => void remove(p)}><X className="size-4" /></IconButton>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
