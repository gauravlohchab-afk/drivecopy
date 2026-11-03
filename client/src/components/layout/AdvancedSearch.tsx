import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useCurrentFolderId } from '../../hooks/useCurrentFolder';

export const TYPE_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'folder', label: 'Folders' },
  { value: 'pdf', label: 'PDFs' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'audio', label: 'Audio' },
  { value: 'document', label: 'Documents' },
  { value: 'spreadsheet', label: 'Spreadsheets' },
  { value: 'presentation', label: 'Presentations' },
  { value: 'text', label: 'Text' },
  { value: 'archive', label: 'Archives' },
];

export const DATE_OPTIONS = [
  { value: '', label: 'Any time' },
  { value: '1', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
  { value: 'custom', label: 'Custom range…' },
];

const MB = 1024 * 1024;
export const SIZE_OPTIONS = [
  { value: '', label: 'Any size', min: undefined, max: undefined },
  { value: 'lt1', label: 'Smaller than 1 MB', min: undefined, max: MB - 1 },
  { value: '1-10', label: '1 MB – 10 MB', min: MB, max: 10 * MB },
  { value: '10-100', label: '10 MB – 100 MB', min: 10 * MB, max: 100 * MB },
  { value: 'gt100', label: 'Larger than 100 MB', min: 100 * MB + 1, max: undefined },
  { value: 'custom', label: 'Custom…', min: undefined, max: undefined },
] as const;

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

interface Form {
  q: string;
  type: string;
  owner: 'any' | 'me' | 'others' | 'person';
  ownerEmail: string;
  location: string; // 'anywhere' | 'mydrive' | 'shared' | 'folder'
  trash: boolean;
  starred: boolean;
  days: string;
  after: string;
  before: string;
  size: string;
  minMb: string;
  maxMb: string;
  sharedTo: string;
}

const empty: Form = {
  q: '', type: '', owner: 'any', ownerEmail: '', location: 'anywhere', trash: false, starred: false,
  days: '', after: '', before: '', size: '', minMb: '', maxMb: '', sharedTo: '',
};

/** Reads the current /search URL back into the form, so reopening the dialog shows what's applied. */
function fromParams(p: URLSearchParams, folderId: string | null): Form {
  const owner = p.get('owner') ?? '';
  const min = p.get('min');
  const max = p.get('max');
  const preset = SIZE_OPTIONS.find((o) => o.value && o.value !== 'custom' && String(o.min ?? '') === (min ?? '') && String(o.max ?? '') === (max ?? ''));
  return {
    q: p.get('q') ?? '',
    type: p.get('type') ?? '',
    owner: owner === 'me' || owner === 'others' ? owner : owner ? 'person' : 'any',
    ownerEmail: owner && owner !== 'me' && owner !== 'others' ? owner : '',
    location: p.get('folderId') || folderId ? 'folder' : p.get('location') ?? 'anywhere',
    trash: p.get('trash') === '1',
    starred: p.get('starred') === '1',
    days: p.get('after') || p.get('before') ? 'custom' : p.get('days') ?? '',
    after: p.get('after') ?? '',
    before: p.get('before') ?? '',
    size: preset ? preset.value : min || max ? 'custom' : '',
    minMb: min ? String(Math.round((Number(min) / MB) * 100) / 100) : '',
    maxMb: max ? String(Math.round((Number(max) / MB) * 100) / 100) : '',
    sharedTo: p.get('sharedTo') ?? '',
  };
}

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start sm:gap-4">
      <label htmlFor={htmlFor} className="text-sm font-medium text-slate-700 sm:pt-2.5">{label}</label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const control = 'focus-ring h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 disabled:bg-slate-50 disabled:text-slate-400';
const narrow = `${control} sm:max-w-xs`;

/** Drive-style advanced search. Every field maps to a filter the server applies. */
export function AdvancedSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const routeFolderId = useCurrentFolderId();
  const folderId = location.pathname === '/search' ? params.get('folderId') : routeFolderId;
  const [f, setF] = useState<Form>(empty);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(location.pathname === '/search' ? fromParams(params, folderId) : { ...empty, location: folderId ? 'folder' : 'anywhere' });
    // Only when the dialog opens: later URL changes shouldn't overwrite what the user is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));
  const sharedOnly = f.location === 'shared' || f.owner === 'others' || f.owner === 'person';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (f.owner === 'person' && !isEmail(f.ownerEmail)) return setError('Enter the owner’s email address.');
    if (f.sharedTo && !isEmail(f.sharedTo)) return setError('Enter a valid email address for “Shared to”.');
    if (f.days === 'custom' && f.after && f.before && f.after > f.before) return setError('The start date must be before the end date.');
    if (f.size === 'custom' && f.minMb && f.maxMb && Number(f.minMb) > Number(f.maxMb)) return setError('The minimum size must be smaller than the maximum.');

    const out = new URLSearchParams();
    const put = (k: string, v: string | undefined | null | false) => {
      if (v) out.set(k, v);
    };
    put('q', f.q.trim());
    put('type', f.type);
    put('owner', f.owner === 'person' ? f.ownerEmail.trim().toLowerCase() : f.owner === 'any' ? '' : f.owner);
    if (f.location === 'folder') put('folderId', folderId);
    else if (f.location !== 'anywhere') put('location', f.location);
    if (!sharedOnly) {
      put('trash', f.trash && '1');
      put('starred', f.starred && '1');
    }
    if (f.days === 'custom') {
      put('after', f.after);
      put('before', f.before);
    } else put('days', f.days);
    if (f.size === 'custom') {
      put('min', f.minMb ? String(Math.round(Number(f.minMb) * MB)) : '');
      put('max', f.maxMb ? String(Math.round(Number(f.maxMb) * MB)) : '');
    } else {
      const o = SIZE_OPTIONS.find((s) => s.value === f.size);
      put('min', o?.min !== undefined ? String(o.min) : '');
      put('max', o?.max !== undefined ? String(o.max) : '');
    }
    put('sharedTo', f.sharedTo.trim().toLowerCase());
    if (![...out.keys()].length) return setError('Choose at least one filter or enter a name.');
    onClose();
    navigate(`/search?${out.toString()}`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Advanced search"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => { setF({ ...empty, location: folderId ? 'folder' : 'anywhere' }); setError(null); }}>Reset</Button>
          <Button type="submit" form="advanced-search" variant="primary">Search</Button>
        </>
      }
    >
      <form id="advanced-search" onSubmit={submit} noValidate className="space-y-4">
        <Row label="Type" htmlFor="as-type">
          <select id="as-type" className={narrow} value={f.type} onChange={(e) => set('type', e.target.value)}>
            {TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Row>
        <Row label="Owner" htmlFor="as-owner">
          <select id="as-owner" className={narrow} value={f.owner} onChange={(e) => set('owner', e.target.value as Form['owner'])}>
            <option value="any">Anyone</option>
            <option value="me">Owned by me</option>
            <option value="others">Not owned by me</option>
            <option value="person">Specific person…</option>
          </select>
          {f.owner === 'person' && (
            <input aria-label="Owner email" type="email" className={`${control} mt-2`} placeholder="Owner’s email address" value={f.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)} />
          )}
        </Row>
        <Row label="Item name" htmlFor="as-name">
          <input id="as-name" className={control} placeholder="Enter a term that matches part of the name" maxLength={100} value={f.q} onChange={(e) => set('q', e.target.value)} />
        </Row>
        <Row label="Location" htmlFor="as-location">
          <select id="as-location" className={narrow} value={f.location} onChange={(e) => set('location', e.target.value)}>
            <option value="anywhere">Anywhere</option>
            <option value="mydrive">My Drive</option>
            <option value="shared">Shared with me</option>
            {folderId && <option value="folder">This folder and its subfolders</option>}
          </select>
          <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-2">
            {([['trash', 'In Trash'], ['starred', 'Starred']] as const).map(([k, label]) => (
              <label key={k} className={`flex items-center gap-2 text-sm ${sharedOnly ? 'text-slate-400' : 'text-slate-700'}`}>
                <input type="checkbox" className="size-4 rounded border-slate-300 accent-brand-600" disabled={sharedOnly} checked={f[k] && !sharedOnly} onChange={(e) => set(k, e.target.checked)} />
                {label}
              </label>
            ))}
          </div>
          {sharedOnly && <p className="mt-1 text-xs text-slate-500">Trash and Starred only apply to your own items.</p>}
        </Row>
        <Row label="Date modified" htmlFor="as-date">
          <select id="as-date" className={narrow} value={f.days} onChange={(e) => set('days', e.target.value)}>
            {DATE_OPTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
          {f.days === 'custom' && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input aria-label="Modified after" type="date" className={`${control} w-auto`} value={f.after} max={f.before || undefined} onChange={(e) => set('after', e.target.value)} />
              <span className="text-sm text-slate-500">to</span>
              <input aria-label="Modified before" type="date" className={`${control} w-auto`} value={f.before} min={f.after || undefined} onChange={(e) => set('before', e.target.value)} />
            </div>
          )}
        </Row>
        <Row label="Size" htmlFor="as-size">
          <select id="as-size" className={narrow} value={f.size} onChange={(e) => set('size', e.target.value)}>
            {SIZE_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          {f.size === 'custom' && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input aria-label="Minimum size in MB" type="number" min={0} step="any" placeholder="Min MB" className={`${control} w-28`} value={f.minMb} onChange={(e) => set('minMb', e.target.value)} />
              <span className="text-sm text-slate-500">to</span>
              <input aria-label="Maximum size in MB" type="number" min={0} step="any" placeholder="Max MB" className={`${control} w-28`} value={f.maxMb} onChange={(e) => set('maxMb', e.target.value)} />
            </div>
          )}
          {f.size && <p className="mt-1 text-xs text-slate-500">Folders have no size, so only files are shown.</p>}
        </Row>
        <Row label="Shared to" htmlFor="as-shared-to">
          <input
            id="as-shared-to"
            type="email"
            className={control}
            placeholder="Email address of someone you shared with"
            disabled={sharedOnly}
            value={sharedOnly ? '' : f.sharedTo}
            onChange={(e) => set('sharedTo', e.target.value)}
          />
        </Row>
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </form>
    </Modal>
  );
}
