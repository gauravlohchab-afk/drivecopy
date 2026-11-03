import { useQuery } from '@tanstack/react-query';
import { fileApi } from '../api/endpoints';
import type { FileItem } from '../api/types';

/** Short-lived presigned thumbnail URLs for the image files currently on screen. */
export function useThumbnails(files: FileItem[], enabled: boolean) {
  // One request covers one place: a single shared drive, or everything outside drives.
  const drives = new Set(files.map((f) => f.driveId ?? null));
  const driveId = drives.size === 1 ? [...drives][0]! : null;
  const ids = files.filter((f) => f.category === 'image' && (f.driveId ?? null) === driveId).map((f) => f.id).slice(0, 100);
  const query = useQuery({
    queryKey: ['thumbs', driveId, ids],
    queryFn: () => fileApi.thumbnailUrls(ids, driveId),
    enabled: enabled && ids.length > 0,
    // URLs live for the configured TTL (default 15 min); refresh well before they expire.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
  return query.data?.urls ?? {};
}
