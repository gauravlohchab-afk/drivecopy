import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UploadManager } from './uploadManager';
import { invalidateDrive } from '../lib/invalidate';

const Ctx = createContext<UploadManager | null>(null);

export function UploadsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const manager = useMemo(
    () =>
      // Refresh every view that can show the new file (My Drive, shared drives, Home, Activity, storage)
      // once the server has verified an upload.
      new UploadManager(() => invalidateDrive(qc)),
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
