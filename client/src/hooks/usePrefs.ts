import { useState } from 'react';
import type { SortKey, SortOrder } from '../api/types';
import { readPref, writePref } from '../lib/storage';

export type ViewMode = 'grid' | 'list';

export function useViewPrefs() {
  const [view, setViewState] = useState<ViewMode>(() => readPref('view', ['grid', 'list'] as const, 'grid'));
  const [sort, setSortState] = useState<SortKey>(() => readPref('sort', ['name', 'modified', 'size'] as const, 'name'));
  const [order, setOrderState] = useState<SortOrder>(() => readPref('order', ['asc', 'desc'] as const, 'asc'));
  return {
    view,
    sort,
    order,
    setView: (v: ViewMode) => {
      setViewState(v);
      writePref('view', v);
    },
    setSort: (s: SortKey, o: SortOrder) => {
      setSortState(s);
      setOrderState(o);
      writePref('sort', s);
      writePref('order', o);
    },
  };
}
