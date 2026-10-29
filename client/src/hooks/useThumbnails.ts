import { useQuery } from '@tanstack/react-query';
import { fileApi } from '../api/endpoints';
import type { FileItem } from '../api/types';

/** Short-lived presigned thumbnail URLs for the image files currently on screen. */
export function useThumbnails(files: FileItem[], enabled: boolean) {
  const ids = files.filter((f) => f.category === 'image').map((f) => f.id).slice(0, 100);
  const query = useQuery({
    queryKey: ['thumbs', ids],
    queryFn: () => fileApi.thumbnailUrls(ids),
    enabled: enabled && ids.length > 0,
    // URLs live for the configured TTL (default 15 min); refresh well before they expire.
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
  return query.data?.urls ?? {};
}
