import type { QueryClient } from '@tanstack/react-query';

/** After any mutation, refresh every view that could show the changed item. */
export function invalidateDrive(qc: QueryClient) {
  for (const key of ['contents', 'folders', 'starred', 'recent', 'search', 'trash', 'usage', 's3-stats', 'shared', 'home', 'activity', 'storage', 'workspaces', 'drives']) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}
