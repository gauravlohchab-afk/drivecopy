import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, setCsrfToken } from '../api/client';
import { authApi } from '../api/endpoints';

export function useAuth() {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const res = await authApi.me();
        setCsrfToken(res.csrfToken);
        return res.user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
  return { user: query.data ?? null, isLoading: query.isLoading, error: query.error, refetch: query.refetch };
}

export function useSignOut() {
  const qc = useQueryClient();
  return async () => {
    try {
      await authApi.logout();
    } finally {
      setCsrfToken(null);
      // Keep the ['me'] query (its observers drive the redirect) and drop everything else.
      qc.setQueryData(['me'], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    }
  };
}
