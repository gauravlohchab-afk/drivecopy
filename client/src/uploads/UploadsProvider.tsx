import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UploadManager } from './uploadManager';

const Ctx = createContext<UploadManager | null>(null);

export function UploadsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const manager = useMemo(
    () =>
      new UploadManager(() => {
        // Refresh listings and usage once the server has verified an upload.
        void qc.invalidateQueries({ queryKey: ['contents'] });
        void qc.invalidateQueries({ queryKey: ['folders'] });
        void qc.invalidateQueries({ queryKey: ['recent'] });
        void qc.invalidateQueries({ queryKey: ['search'] });
        void qc.invalidateQueries({ queryKey: ['usage'] });
      }),
    [qc],
  );

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (manager.activeCount > 0) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [manager]);

  return <Ctx.Provider value={manager}>{children}</Ctx.Provider>;
}

export function useUploadManager() {
  const m = useContext(Ctx);
  if (!m) throw new Error('useUploadManager must be used inside UploadsProvider');
  return m;
}

export function useUploadTasks() {
  const m = useUploadManager();
  return useSyncExternalStore(m.subscribe, m.getSnapshot);
}
