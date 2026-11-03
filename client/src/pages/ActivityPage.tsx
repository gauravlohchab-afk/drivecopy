import { useInfiniteQuery } from '@tanstack/react-query';
import { Activity as ActivityIcon, ArrowRightLeft, Download, FolderPlus, Pencil, RotateCcw, Share2, Trash2, Upload, UserMinus, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { discoveryApi } from '../api/endpoints';
import type { ActivityEntry } from '../api/types';
import { PageHeader } from '../components/drive/PageHeader';
import { EmptyState, ErrorState, ListSkeleton } from '../components/ui/States';
import { Button } from '../components/ui/Button';

const icons: Record<ActivityEntry['action'], ReactNode> = {
  upload: <Upload />,
  create_folder: <FolderPlus />,
  rename: <Pencil />,
  move: <ArrowRightLeft />,
  trash: <Trash2 />,
  restore: <RotateCcw />,
  delete: <XCircle />,
  share: <Share2 />,
  unshare: <UserMinus />,
  download: <Download />,
};

const B = ({ children }: { children: ReactNode }) => <strong className="font-medium text-slate-900">{children}</strong>;

function describe(e: ActivityEntry): ReactNode {
  const who = e.actor.isYou ? 'You' : e.actor.name;
  const item = <B>{e.item.name}</B>;
  const target = e.target ? (e.target.isYou ? 'you' : e.target.name) : 'someone';
  switch (e.action) {
    case 'upload': return <>{who} uploaded {item}</>;
    case 'create_folder': return <>{who} created the folder {item}</>;
    case 'rename': return <>{who} renamed <B>{e.detail}</B> to {item}</>;
    case 'move': return <>{who} moved {item} to <B>{e.detail}</B></>;
    case 'trash': return <>{who} moved {item} to Trash</>;
    case 'restore': return <>{who} restored {item} from Trash</>;
    case 'delete': return <>{who} permanently deleted {item}</>;
    case 'share': return <>{who} shared {item} with {target}</>;
    case 'unshare': return <>{who} stopped sharing {item} with {target}</>;
    case 'download': return <>{who} downloaded {item}</>;
  }
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return dayFmt.format(d);
}

export function ActivityPage() {
  const q = useInfiniteQuery({
    queryKey: ['activity'],
    queryFn: ({ pageParam }) => discoveryApi.activity(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const groups: { day: string; items: ActivityEntry[] }[] = [];
  for (const e of items) {
    const day = dayLabel(e.at);
    if (groups[groups.length - 1]?.day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1]!.items.push(e);
  }

  return (
    <>
      <PageHeader title="Activity" />
      {q.isLoading ? (
        <ListSkeleton />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={<ActivityIcon />} title="No activity yet" body="Uploads, renames, moves, shares and deletions show up here." />
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.day} aria-label={g.day}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.day}</h2>
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
                {g.items.map((e) => (
                  <li key={e.id} className="flex items-start gap-3 px-4 py-3">
                    <span aria-hidden className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 [&>svg]:size-4">
                      {icons[e.action]}
                    </span>
                    <p className="min-w-0 flex-1 break-words text-sm text-slate-600">{describe(e)}</p>
                    <time dateTime={e.at} className="shrink-0 pt-0.5 text-xs text-slate-500">{timeFmt.format(new Date(e.at))}</time>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {q.hasNextPage && (
            <div className="flex justify-center">
              <Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Load more</Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
