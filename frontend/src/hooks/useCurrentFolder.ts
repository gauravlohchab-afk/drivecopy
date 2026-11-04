import { useLocation } from 'react-router';

/** The folder new items go into: the open folder, or the root of My Drive elsewhere. */
export function useCurrentFolderId(): string | null {
  const { pathname } = useLocation();
  const m = /^\/folders\/([a-f\d]{24})/i.exec(pathname);
  return m?.[1] ?? null;
}

/** Inside a shared drive (/drives/:driveId[/folders/:folderId]): the drive and open folder. */
export function useCurrentDrive(): { driveId: string; folderId: string | null } | null {
  const { pathname } = useLocation();
  const m = /^\/drives\/([a-f\d]{24})(?:\/folders\/([a-f\d]{24}))?\/?$/i.exec(pathname);
  return m ? { driveId: m[1]!, folderId: m[2] ?? null } : null;
}
