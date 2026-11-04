import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Phones, portrait or landscape: menus open as bottom sheets. Matches the `md` breakpoint. */
export const PHONE_QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px)';

export const useIsPhone = () => useMediaQuery(PHONE_QUERY);
