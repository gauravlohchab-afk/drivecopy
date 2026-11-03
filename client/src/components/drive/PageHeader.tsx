import { useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, LayoutGrid, List, Upload, Check } from 'lucide-react';
import type { Crumb, SortKey, SortOrder } from '../../api/types';
import type { ViewMode } from '../../hooks/usePrefs';
import { IconButton, Button } from '../ui/Button';
import { Menu } from '../ui/Menu';

/** `shared` links into the read-only "Shared with me" pages instead of My Drive. */
export function Breadcrumbs({ path, rootLabel = 'My Drive', shared = false, driveId }: { path: Crumb[]; rootLabel?: string; shared?: boolean; driveId?: string }) {
  const rootTo = shared ? '/shared' : driveId ? `/drives/${driveId}` : '/drive';
  const folderTo = (id: string) => (shared ? `/shared/folders/${id}` : driveId ? `/drives/${driveId}/folders/${id}` : `/folders/${id}`);
  const items = [{ id: 'root', name: rootLabel }, ...path];
  // On small screens, collapse the middle of long paths.
  const collapsed = items.length > 3;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-0.5 text-lg font-semibold text-slate-900 sm:text-xl">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          const hideOnMobile = collapsed && i > 0 && i < items.length - 2;
          // The root stays whole; parents truncate before the current folder does.
          const parentAsEllipsis = collapsed && i === items.length - 2;
          const shrink = i === 0 ? 'shrink-0' : last ? 'shrink' : parentAsEllipsis ? 'shrink-0 md:shrink-[4]' : 'shrink-[4]';
          return (
            <li key={c.id} className={`flex min-w-0 items-center ${hideOnMobile ? 'hidden md:flex' : 'flex'} ${shrink}`}>
              {i > 0 && <ChevronRight className="mx-0.5 size-4 shrink-0 text-slate-400" aria-hidden />}
              {last ? (
                <span aria-current="page" className="truncate px-1.5 py-1">{c.name}</span>
              ) : (
                <Link to={c.id === 'root' ? rootTo : folderTo(c.id)} title={c.name} className="focus-ring max-w-40 truncate rounded-lg px-1.5 py-1 font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800">
                  {/* On small screens a collapsed path shows its parent as "…", still linking to it. */}
                  {parentAsEllipsis ? (
                    <>
                      <span className="md:hidden"><span aria-hidden>…</span><span className="sr-only">{c.name}</span></span>
                      <span className="hidden md:inline">{c.name}</span>
                    </>
                  ) : (
                    c.name
                  )}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const sortLabels: Record<SortKey, string> = { name: 'Name', modified: 'Last modified', size: 'File size' };

export function PageHeader({
  title, view, onView, sort, order, onSort, onUpload, extra,
}: {
  title: ReactNode;
  view?: ViewMode;
  onView?: (v: ViewMode) => void;
  sort?: SortKey;
  order?: SortOrder;
  onSort?: (s: SortKey, o: SortOrder) => void;
  onUpload?: () => void;
  extra?: ReactNode;
}) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const sortLabel = sort && order ? `Sort: ${sortLabels[sort]} (${order === 'asc' ? 'ascending' : 'descending'})` : '';
  const openSort = (e: MouseEvent<HTMLButtonElement>, align: 'left' | 'right') => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenuAt({ x: align === 'left' ? r.left : r.right - 208, y: r.bottom + 4 });
  };
  const SortDir = order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 sm:mb-5 sm:gap-y-2">
      {/* Phones: the title gets its own row, with sort and view controls beneath it.
          Larger screens: a title too long to share the row pushes the actions onto their own line. */}
      <div className="min-w-0 flex-auto basis-full sm:basis-auto">{typeof title === 'string' ? <h1 className="truncate text-xl font-semibold text-slate-900">{title}</h1> : title}</div>
      <div className="flex w-full shrink-0 items-center gap-1 sm:ml-auto sm:w-auto">
        {onSort && sort && order && (
          <button
            type="button"
            aria-label={sortLabel}
            aria-haspopup="menu"
            onClick={(e) => openSort(e, 'left')}
            className="focus-ring -ml-2 mr-auto flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-700 hover:bg-slate-100 sm:hidden"
          >
            {sortLabels[sort]}
            <SortDir className="size-4" aria-hidden />
          </button>
        )}
        {extra}
        {/* On phones the floating "New" button handles uploads. */}
        {onUpload && (
          <span className="hidden md:flex">
            <Button variant="primary" size="sm" icon={<Upload className="size-4" />} onClick={onUpload} className="mr-1">
              Upload
            </Button>
          </span>
        )}
        {onSort && sort && order && (
          <>
            <span className="hidden sm:flex">
              <IconButton label={sortLabel} aria-haspopup="menu" onClick={(e) => openSort(e, 'right')}>
                <ArrowUpDown className="size-4" />
              </IconButton>
            </span>
            <Menu
              label="Sort by"
              at={menuAt}
              onClose={() => setMenuAt(null)}
              items={[
                ...(['name', 'modified', 'size'] as SortKey[]).map((k) => ({
                  label: sortLabels[k],
                  icon: sort === k ? <Check /> : undefined,
                  onSelect: () => onSort(k, sort === k ? order : k === 'name' ? 'asc' : 'desc'),
                })),
                'separator' as const,
                { label: 'Ascending', icon: order === 'asc' ? <Check /> : undefined, onSelect: () => onSort(sort, 'asc') },
                { label: 'Descending', icon: order === 'desc' ? <Check /> : undefined, onSelect: () => onSort(sort, 'desc') },
              ]}
            />
          </>
        )}
        {onView && view && (
          <div className={clsx('flex rounded-lg border border-slate-200 p-0.5', !onSort && 'ml-auto sm:ml-0')} role="group" aria-label="View">
            <IconButton label="Grid view" active={view === 'grid'} aria-pressed={view === 'grid'} className="size-8" onClick={() => onView('grid')}>
              <LayoutGrid className="size-4" />
            </IconButton>
            <IconButton label="List view" active={view === 'list'} aria-pressed={view === 'list'} className="size-8" onClick={() => onView('list')}>
              <List className="size-4" />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
}
