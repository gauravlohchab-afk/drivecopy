import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Check, Download, Eye, FolderInput, FolderOpen, MoreVertical, Pencil, RotateCcw, Star, StarOff, Trash2, X, ArrowUp, ArrowDown,
} from 'lucide-react';
import type { DriveItem, FileItem, FolderItem, SortKey, SortOrder } from '../../api/types';
import { formatBytes, formatDate } from '../../lib/format';
import { Menu, anchorBelow, type MenuEntry } from '../ui/Menu';
import { IconButton, Button } from '../ui/Button';
import { GridSkeleton, ListSkeleton, ErrorState } from '../ui/States';
import { FileIcon, typeLabel } from './FileIcon';
import { useDriveActions } from './DriveActions';
import { canPreview } from './PreviewModal';
import type { ViewMode } from '../../hooks/usePrefs';
import { useThumbnails } from '../../hooks/useThumbnails';

export type BrowserMode = 'drive' | 'trash';

interface Props {
  folders: FolderItem[];
  files: FileItem[];
  view: ViewMode;
  mode?: BrowserMode;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  empty: ReactNode;
  sort?: SortKey;
  order?: SortOrder;
  onSort?: (s: SortKey, o: SortOrder) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

const isCoarse = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

export function FileBrowser(props: Props) {
  const { folders, files, view, mode = 'drive', isLoading, error, onRetry, empty } = props;
  const actions = useDriveActions();
  const items = useMemo<DriveItem[]>(() => [...folders, ...files], [folders, files]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; targets: DriveItem[] } | null>(null);
  const thumbs = useThumbnails(files, view === 'grid' && mode === 'drive');
  const containerRef = useRef<HTMLDivElement>(null);

  // Drop selections that disappeared after a refresh.
  useEffect(() => {
    setSelected((s) => {
      const ids = new Set(items.map((i) => i.id));
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [items]);

  const selectedItems = items.filter((i) => selected.has(i.id));
  const clear = useCallback(() => setSelected(new Set()), []);

  const onItemClick = (e: React.MouseEvent, item: DriveItem) => {
    if (isCoarse() && selected.size === 0) return actions.open(item);
    if (e.shiftKey && anchor) {
      const a = items.findIndex((i) => i.id === anchor);
      const b = items.findIndex((i) => i.id === item.id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(items.slice(lo, hi + 1).map((i) => i.id)));
      return;
    }
    if (e.metaKey || e.ctrlKey || (isCoarse() && selected.size > 0)) {
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(item.id)) n.delete(item.id);
        else n.add(item.id);
        return n;
      });
    } else {
      setSelected(new Set([item.id]));
    }
    setAnchor(item.id);
  };

  const toggle = (item: DriveItem) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(item.id)) n.delete(item.id);
      else n.add(item.id);
      return n;
    });
    setAnchor(item.id);
  };

  const targetsFor = (item: DriveItem) => (selected.has(item.id) && selected.size > 1 ? selectedItems : [item]);

  const openMenu = (at: { x: number; y: number }, item: DriveItem) => {
    if (!selected.has(item.id)) setSelected(new Set([item.id]));
    setMenu({ at, targets: targetsFor(item) });
  };

  const menuEntries = (targets: DriveItem[]): MenuEntry[] => {
    if (mode === 'trash') {
      return [
        { label: 'Restore', icon: <RotateCcw />, onSelect: () => actions.restore(targets) },
        'separator',
        { label: 'Delete forever', icon: <Trash2 />, danger: true, onSelect: () => actions.purge(targets) },
      ];
    }
    const single = targets.length === 1 ? targets[0]! : null;
    const allStarred = targets.every((t) => t.isStarred);
    const entries: MenuEntry[] = [];
    if (single?.kind === 'folder') entries.push({ label: 'Open', icon: <FolderOpen />, onSelect: () => actions.open(single) });
    if (single?.kind === 'file') {
      entries.push({ label: 'Preview', icon: <Eye />, onSelect: () => actions.preview(single), disabled: !canPreview(single) });
      entries.push({ label: 'Download', icon: <Download />, onSelect: () => actions.download(single) });
    }
    if (single) entries.push({ label: 'Rename', icon: <Pencil />, onSelect: () => actions.rename(single) });
    entries.push({ label: 'Move', icon: <FolderInput />, onSelect: () => actions.move(targets) });
    entries.push(
      allStarred
        ? { label: 'Remove from Starred', icon: <StarOff />, onSelect: () => actions.star(targets, false) }
        : { label: 'Add to Starred', icon: <Star />, onSelect: () => actions.star(targets, true) },
    );
    entries.push('separator', { label: 'Move to Trash', icon: <Trash2 />, danger: true, onSelect: () => actions.trash(targets) });
    return entries;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    if (e.key === 'Escape') clear();
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(items.map((i) => i.id)));
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedItems.length) {
      e.preventDefault();
      if (mode === 'trash') actions.purge(selectedItems);
      else actions.trash(selectedItems);
    } else if (e.key === 'F2' && selectedItems.length === 1 && mode === 'drive') {
      e.preventDefault();
      actions.rename(selectedItems[0]!);
    }
  };

  if (isLoading) return view === 'grid' ? <GridSkeleton /> : <ListSkeleton />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (items.length === 0) return <>{empty}</>;

  const itemProps = (item: DriveItem) => ({
    item,
    mode,
    selected: selected.has(item.id),
    thumb: item.kind === 'file' ? thumbs[item.id] : undefined,
    onClick: (e: React.MouseEvent) => onItemClick(e, item),
    onToggle: () => toggle(item),
    onOpen: () => (mode === 'trash' ? undefined : actions.open(item)),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      openMenu({ x: e.clientX, y: e.clientY }, item);
    },
    onMenuButton: (el: HTMLElement) => openMenu(anchorBelow(el), item),
  });

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="relative select-none">
      {selectedItems.length === 0 ? (
        <div className="mb-3 flex h-11 items-center px-1 text-xs text-slate-500" aria-live="polite">
          {[folders.length && `${folders.length} folder${folders.length === 1 ? '' : 's'}`, files.length && `${files.length}${props.hasMore ? '+' : ''} file${files.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
        </div>
      ) : (
        <SelectionBar count={selectedItems.length} onClear={clear}>
          {mode === 'trash' ? (
            <>
              <IconButton label="Restore" onClick={() => actions.restore(selectedItems)}><RotateCcw className="size-4" /></IconButton>
              <IconButton label="Delete forever" onClick={() => actions.purge(selectedItems)}><Trash2 className="size-4" /></IconButton>
            </>
          ) : (
            <>
              {selectedItems.length === 1 && selectedItems[0]!.kind === 'file' && (
                <IconButton label="Download" onClick={() => actions.download(selectedItems[0] as FileItem)}><Download className="size-4" /></IconButton>
              )}
              <IconButton label="Move" onClick={() => actions.move(selectedItems)}><FolderInput className="size-4" /></IconButton>
              <IconButton
                label={selectedItems.every((i) => i.isStarred) ? 'Remove from Starred' : 'Add to Starred'}
                onClick={() => actions.star(selectedItems, !selectedItems.every((i) => i.isStarred))}
              >
                {selectedItems.every((i) => i.isStarred) ? <StarOff className="size-4" /> : <Star className="size-4" />}
              </IconButton>
              <IconButton label="Move to Trash" onClick={() => actions.trash(selectedItems)}><Trash2 className="size-4" /></IconButton>
            </>
          )}
        </SelectionBar>
      )}

      {view === 'grid' ? (
        <div className="space-y-6">
          {folders.length > 0 && (
            <section aria-label="Folders">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Folders</h3>
              <ul role="listbox" aria-multiselectable="true" aria-label="Folders" className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
                {folders.map((f) => <FolderTile key={f.id} {...itemProps(f)} />)}
              </ul>
            </section>
          )}
          {files.length > 0 && (
            <section aria-label="Files">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Files</h3>
              <ul role="listbox" aria-multiselectable="true" aria-label="Files" className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]">
                {files.map((f) => <FileCard key={f.id} {...itemProps(f)} />)}
              </ul>
            </section>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="hidden grid-cols-[minmax(0,1fr)_9rem_6rem_2.5rem] items-center gap-4 border-b border-slate-100 px-4 py-2 text-xs font-semibold text-slate-500 md:grid">
            <SortHeader label="Name" k="name" {...props} />
            <SortHeader label={mode === 'trash' ? 'Trashed' : 'Modified'} k="modified" {...props} />
            <SortHeader label="Size" k="size" {...props} />
            <span />
          </div>
          <ul role="listbox" aria-multiselectable="true" aria-label="Items" className="divide-y divide-slate-100">
            {items.map((i) => <Row key={i.id} {...itemProps(i)} />)}
          </ul>
        </div>
      )}

      {props.hasMore && (
        <div className="mt-6 flex justify-center">
          <Button loading={props.loadingMore} onClick={props.onLoadMore}>Load more</Button>
        </div>
      )}

      <Menu label="Item actions" at={menu?.at ?? null} items={menu ? menuEntries(menu.targets) : []} onClose={() => setMenu(null)} />
    </div>
  );
}

function SelectionBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 mb-3 flex h-11 animate-fade-in items-center gap-1 rounded-xl border border-brand-100 bg-brand-50/95 px-1 backdrop-blur">
      <IconButton label="Clear selection" onClick={onClear}><X className="size-4" /></IconButton>
      <span className="mr-auto text-sm font-medium text-brand-900">{count} selected</span>
      {children}
    </div>
  );
}

function SortHeader({ label, k, sort, order, onSort }: { label: string; k: SortKey } & Pick<Props, 'sort' | 'order' | 'onSort'>) {
  if (!onSort) return <span>{label}</span>;
  const active = sort === k;
  return (
    <button
      type="button"
      className="focus-ring flex items-center gap-1 rounded text-left hover:text-slate-800"
      onClick={() => onSort(k, active && order === 'asc' ? 'desc' : 'asc')}
      aria-label={`Sort by ${label}`}
    >
      {label}
      {active && (order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
    </button>
  );
}

interface ItemProps {
  item: DriveItem;
  mode: BrowserMode;
  selected: boolean;
  thumb?: string;
  onClick: (e: React.MouseEvent) => void;
  onToggle: () => void;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onMenuButton: (el: HTMLElement) => void;
}

function useItemHandlers(p: ItemProps) {
  return {
    role: 'option' as const,
    'aria-selected': p.selected,
    tabIndex: 0,
    onClick: p.onClick,
    onDoubleClick: p.onOpen,
    onContextMenu: p.onContextMenu,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter') p.onOpen();
      else if (e.key === ' ') {
        e.preventDefault();
        p.onToggle();
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        p.onMenuButton(e.currentTarget as HTMLElement);
      }
    },
  };
}

/** File-type icon that turns into a selection checkbox on hover, focus or when selected. */
function IconSelect({ item, selected, onToggle }: { item: DriveItem; selected: boolean; onToggle: () => void }) {
  return (
    <span className="relative inline-flex shrink-0">
      <span className={clsx('transition-opacity', selected ? 'opacity-0' : 'group-hover:opacity-0 group-focus-within:opacity-0 [@media(pointer:coarse)]:opacity-100')}>
        <FileIcon item={item} size="sm" />
      </span>
      <span className="absolute inset-0 flex items-center justify-center">
        <SelectBox selected={selected} onToggle={onToggle} name={item.name} overlay />
      </span>
    </span>
  );
}

function SelectBox({ selected, onToggle, name, overlay }: { selected: boolean; onToggle: () => void; name: string; overlay?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={`Select ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={clsx(
        'focus-ring flex size-5 shrink-0 items-center justify-center rounded-md border transition-opacity',
        selected
          ? 'border-brand-600 bg-brand-600 text-white opacity-100'
          : overlay
            ? 'border-slate-300 bg-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:hidden'
            : 'border-slate-300 bg-white/90 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100',
      )}
    >
      {selected && <Check className="size-3.5" strokeWidth={3} />}
    </button>
  );
}

function MoreButton({ onMenuButton, name }: { onMenuButton: (el: HTMLElement) => void; name: string }) {
  return (
    <IconButton
      label={`More actions for ${name}`}
      className="size-8"
      onClick={(e) => {
        e.stopPropagation();
        onMenuButton(e.currentTarget);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <MoreVertical className="size-4" />
    </IconButton>
  );
}

function FolderTile(p: ItemProps) {
  return (
    <li
      {...useItemHandlers(p)}
      className={clsx(
        'group focus-ring flex cursor-pointer select-none items-center gap-2.5 rounded-xl border bg-white py-2 pl-2.5 pr-1 transition-colors',
        p.selected ? 'border-brand-300 bg-brand-50 ring-1 ring-brand-300' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
      )}
    >
      <IconSelect item={p.item} selected={p.selected} onToggle={p.onToggle} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800" title={p.item.name}>{p.item.name}</span>
      {p.item.isStarred && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />}
      <MoreButton onMenuButton={p.onMenuButton} name={p.item.name} />
    </li>
  );
}

function FileCard(p: ItemProps) {
  const f = p.item as FileItem;
  const [broken, setBroken] = useState(false);
  return (
    <li
      {...useItemHandlers(p)}
      className={clsx(
        'group focus-ring flex cursor-pointer select-none flex-col overflow-hidden rounded-xl border bg-white transition-all',
        p.selected ? 'border-brand-300 ring-1 ring-brand-300' : 'border-slate-200 hover:border-slate-300 hover:shadow-md hover:shadow-slate-900/5',
      )}
    >
      <div className="relative flex aspect-[4/3] items-center justify-center bg-slate-50">
        {p.thumb && !broken ? (
          <img src={p.thumb} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="size-full object-cover" />
        ) : (
          <FileIcon item={f} size="lg" />
        )}
        <div className="absolute left-2 top-2"><SelectBox selected={p.selected} onToggle={p.onToggle} name={f.name} /></div>
        {f.isStarred && <Star className="absolute right-2 top-2 size-4 fill-amber-400 text-amber-400 drop-shadow" aria-label="Starred" />}
      </div>
      <div className="flex items-center gap-2 border-t border-slate-100 py-1.5 pl-3 pr-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-800" title={f.name}>{f.name}</p>
          <p className="truncate text-xs text-slate-500">{formatBytes(f.size)} · {formatDate(p.mode === 'trash' ? f.deletedAt : f.updatedAt)}</p>
        </div>
        <MoreButton onMenuButton={p.onMenuButton} name={f.name} />
      </div>
    </li>
  );
}

function Row(p: ItemProps) {
  const it = p.item;
  return (
    <li
      {...useItemHandlers(p)}
      className={clsx(
        'group focus-ring grid cursor-pointer select-none grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-4 px-4 py-2 md:grid-cols-[minmax(0,1fr)_9rem_6rem_2.5rem]',
        p.selected ? 'bg-brand-50' : 'hover:bg-slate-50',
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <IconSelect item={it} selected={p.selected} onToggle={p.onToggle} />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-800" title={it.name}>
            <span className="truncate">{it.name}</span>
            {it.isStarred && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />}
          </p>
          <p className="truncate text-xs text-slate-500 md:hidden">
            {typeLabel(it)} · {formatDate(p.mode === 'trash' ? it.deletedAt : it.updatedAt)}
            {it.kind === 'file' && ` · ${formatBytes(it.size)}`}
          </p>
        </div>
      </div>
      <span className="hidden text-sm text-slate-500 md:block">{formatDate(p.mode === 'trash' ? it.deletedAt : it.updatedAt)}</span>
      <span className="hidden text-sm text-slate-500 md:block">{it.kind === 'file' ? formatBytes(it.size) : '—'}</span>
      <MoreButton onMenuButton={p.onMenuButton} name={it.name} />
    </li>
  );
}
