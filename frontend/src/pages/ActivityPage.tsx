import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Activity as ActivityIcon, AlertTriangle, ArrowRightLeft, Download, Eye, FolderPlus, LogIn, LogOut, Pencil, RotateCcw, Search, Share2, ShieldAlert, Trash2, Upload, UserCog, UserMinus, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { discoveryApi, type ActivityParams } from '../api/endpoints';
import type { ActivityCategory, ActivityEntry } from '../api/types';
import { PageHeader } from '../components/drive/PageHeader';
import { EmptyState, ErrorState, ListSkeleton } from '../components/ui/States';
import { Button } from '../components/ui/Button';

const EVENT_ICONS: [RegExp, ReactNode][] = [
  [/LOGIN_FAILED/, <ShieldAlert key="f" />],
  [/LOGIN/, <LogIn key="i" />],
  [/LOGOUT/, <LogOut key="o" />],
  [/UPLOADED/, <Upload key="u" />],
  [/DOWNLOADED/, <Download key="d" />],
  [/PREVIEWED/, <Eye key="p" />],
  [/CREATED/, <FolderPlus key="c" />],
  [/RENAMED/, <Pencil key="r" />],
  [/MOVED/, <ArrowRightLeft key="m" />],
  [/PERMANENTLY/, <XCircle key="x" />],
  [/RESTORED/, <RotateCcw key="s" />],
  [/DELETED/, <Trash2 key="t" />],
  [/PERMISSIONS/, <UserCog key="g" />],
  [/REVOKED/, <UserMinus key="v" />],
  [/SHARED/, <Share2 key="h" />],
];

const iconFor = (eventType: string) => EVENT_ICONS.find(([pattern]) => pattern.test(eventType))?.[1] ?? <ActivityIcon />;

const typeLabel = (eventType: string) => {
  const text = eventType.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** The specifics that make an entry useful, such as where something was moved to. */
function extra(e: ActivityEntry): string | null {
  const { previousName, destination, role } = e.details;
  if (typeof previousName === 'string') return `was ${previousName}`;
  if (typeof destination === 'string') return `to ${destination}`;
  if (e.target) return `${typeof role === 'string' ? `${e.target.name} is now ${role.replace('_', ' ')}` : e.target.name}`;
  return null;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return dayFmt.format(d);
}

const CATEGORIES: { value: ActivityCategory | ''; label: string }[] = [
  { value: '', label: 'All activity' },
  { value: 'file', label: 'Files' },
  { value: 'folder', label: 'Folders' },
  { value: 'sharing', label: 'Sharing' },
  { value: 'auth', label: 'Sign-ins' },
];

function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** A date picker's value is a local day, so it covers that day in the viewer's timezone. */
const localDayStart = (day: string) => (day ? new Date(`${day}T00:00:00`).toISOString() : undefined);
const localDayEnd = (day: string) => (day ? new Date(`${day}T23:59:59.999`).toISOString() : undefined);

export function ActivityPage() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ActivityCategory | ''>('');
  const [status, setStatus] = useState<'' | 'SUCCESS' | 'FAILED'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useDebounced(search.trim(), 300);
  const filtered = Boolean(q || category || status || from || to);

  const params: ActivityParams = { q, category, status, from: localDayStart(from), to: localDayEnd(to) };
  const feed = useInfiniteQuery({
    queryKey: ['activity', params],
    queryFn: ({ pageParam }) => discoveryApi.activity({ ...params, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });

  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const logStorage = feed.data?.pages[feed.data.pages.length - 1]?.logStorage;
  const groups: { day: string; items: ActivityEntry[] }[] = [];
  for (const e of items) {
    const day = dayLabel(e.at);
    if (groups[groups.length - 1]?.day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1]!.items.push(e);
  }

  return (
    <>
      <PageHeader title="Activity" />
      <div role="search" aria-label="Filter activity" className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted" aria-hidden />
          <label htmlFor="activity-search" className="sr-only">Search activity</label>
          <input
            id="activity-search"
            type="search"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or action"
            className="input input-sm focus-ring pl-9"
          />
        </div>
        <label htmlFor="activity-category" className="sr-only">Activity type</label>
        <select id="activity-category" value={category} onChange={(e) => setCategory(e.target.value as ActivityCategory | '')} className="input input-sm focus-ring w-auto">
          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <label htmlFor="activity-status" className="sr-only">Status</label>
        <select id="activity-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="input input-sm focus-ring w-auto">
          <option value="">Any status</option>
          <option value="SUCCESS">Success</option>
          <option value="FAILED">Failed</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-ink-muted">
          From
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="input input-sm focus-ring w-auto" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-muted">
          To
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="input input-sm focus-ring w-auto" />
        </label>
      </div>

      {logStorage?.status === 'degraded' && (
        <p role="status" className="alert alert-info mb-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Activity can’t reach its log storage in S3 right now, so older entries may be missing.
            {logStorage.pendingEvents > 0 && ` ${logStorage.pendingEvents.toLocaleString()} recent ${logStorage.pendingEvents === 1 ? 'event is' : 'events are'} saved and will be written when access returns.`}
          </span>
        </p>
      )}

      {feed.isLoading ? (
        <ListSkeleton />
      ) : feed.error ? (
        <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />
      ) : items.length === 0 && !feed.hasNextPage ? (
        filtered ? (
          <EmptyState icon={<Search />} title="No matching activity" body="Try a different search, or remove some filters." />
        ) : (
          <EmptyState icon={<ActivityIcon />} title="No activity yet" body="Uploads, downloads, renames, moves, shares and sign-ins show up here." />
        )
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.day} aria-label={g.day}>
              <h2 className="section-label mb-2">{g.day}</h2>
              <ul className="list-box">
                {g.items.map((e) => (
                  <ActivityRow key={e.id} entry={e} />
                ))}
              </ul>
            </section>
          ))}
          {feed.hasNextPage && (
            <div className="flex justify-center">
              <Button loading={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                {items.length === 0 ? 'Keep searching older activity' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ActivityRow({ entry: e }: { entry: ActivityEntry }) {
  const failed = e.status === 'FAILED';
  const more = extra(e);
  const by = e.actor && !e.actor.isYou ? e.actor.name : null;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span aria-hidden className={clsx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full [&>svg]:size-4', failed ? 'bg-danger-soft text-danger' : 'bg-surface-hover text-ink-soft')}>
        {iconFor(e.eventType)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm text-ink-soft">
          {e.action}
          {e.item && <> <strong className="font-medium text-ink-strong">{e.item.name}</strong></>}
          {more && <span className="text-ink-muted"> ({more})</span>}
        </p>
        <p className="mt-0.5 text-xs text-ink-muted">
          {typeLabel(e.eventType)}
          {by && ` · by ${by}`}
          {' · '}
          <span className={failed ? 'font-medium text-danger' : undefined}>{failed ? 'Failed' : 'Success'}</span>
        </p>
      </div>
      <time dateTime={e.at} title={fullFmt.format(new Date(e.at))} className="shrink-0 pt-0.5 text-xs text-ink-muted">
        {timeFmt.format(new Date(e.at))}
      </time>
    </li>
  );
}
