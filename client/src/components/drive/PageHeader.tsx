import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowUpDown, ChevronRight, LayoutGrid, List, Upload, Check } from 'lucide-react';
import type { Crumb, SortKey, SortOrder } from '../../api/types';
import type { ViewMode } from '../../hooks/usePrefs';
import { IconButton, Button } from '../ui/Button';
import { Menu } from '../ui/Menu';

export function Breadcrumbs({ path, rootLabel = 'My Drive' }: { path: Crumb[]; rootLabel?: string }) {
  const items = [{ id: 'root', name: rootLabel }, ...path];
  // On small screens, collapse the middle of long paths.
  const collapsed = items.length > 3;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-0.5 text-lg font-semibold text-slate-900 sm:text-xl">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          const hideOnMobile = collapsed && i > 0 && i < items.length - 2;
          return (
            <li key={c.id} className={`flex min-w-0 items-center ${hideOnMobile ? 'hidden md:flex' : 'flex'} ${last ? 'min-w-0' : 'shrink-0'}`}>
              {i > 0 && <ChevronRight className="mx-0.5 size-4 shrink-0 text-slate-400" aria-hidden />}
              {collapsed && i === items.length - 2 && items.length > 3 && <span className="mr-1 text-slate-400 md:hidden">…</span>}
              {last ? (
                <span aria-current="page" className="truncate px-1.5 py-1">{c.name}</span>
              ) : (
                <Link to={c.id === 'root' ? '/drive' : `/folders/${c.id}`} className="focus-ring max-w-40 truncate rounded-lg px-1.5 py-1 font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800">
                  {c.name}
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
  const sortBtn = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1">{typeof title === 'string' ? <h1 className="truncate text-xl font-semibold text-slate-900">{title}</h1> : title}</div>
      <div className="flex shrink-0 items-center gap-1">
        {extra}
        {onUpload && (
          <Button variant="primary" size="sm" icon={<Upload className="size-4" />} onClick={onUpload} className="mr-1">
            <span className="hidden sm:inline">Upload</span>
            <span className="sr-only sm:hidden">Upload files</span>
          </Button>
        )}
        {onSort && sort && order && (
          <>
            <IconButton
              ref={sortBtn}
              label={`Sort: ${sortLabels[sort]} (${order === 'asc' ? 'ascending' : 'descending'})`}
              aria-haspopup="menu"
              onClick={() => {
                const r = sortBtn.current!.getBoundingClientRect();
                setMenuAt({ x: r.right - 208, y: r.bottom + 4 });
              }}
            >
              <ArrowUpDown className="size-4" />
            </IconButton>
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
          <div className="flex rounded-lg border border-slate-200 p-0.5" role="group" aria-label="View">
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
