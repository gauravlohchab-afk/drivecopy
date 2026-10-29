import { useLocation } from 'react-router';

/** The folder new items go into: the open folder, or the root of My Drive elsewhere. */
export function useCurrentFolderId(): string | null {
  const { pathname } = useLocation();
  const m = /^\/folders\/([a-f\d]{24})/i.exec(pathname);
  return m?.[1] ?? null;
}
