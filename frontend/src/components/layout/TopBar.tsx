import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Menu as MenuIcon, Search, X, Settings, LogOut, SlidersHorizontal } from 'lucide-react';
import { AdvancedSearch } from './AdvancedSearch';
import { IconButton } from '../ui/Button';
import { Menu } from '../ui/Menu';
import { useAuth, useSignOut } from '../../hooks/useAuth';
import { Logo } from './Logo';
import { useCurrentFolderId } from '../../hooks/useCurrentFolder';

export function TopBar({ onOpenNav }: { onOpenNav: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [q, setQ] = useState(location.pathname === '/search' ? params.get('q') ?? '' : '');
  const folderId = useCurrentFolderId();
  const { user } = useAuth();
  const signOut = useSignOut();
  const avatar = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (location.pathname !== '/search') setQ('');
  }, [location.pathname]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(location.pathname === '/search' ? params : undefined);
    // Searching from inside a folder scopes the search to that folder (removable on the results page).
    if (folderId) next.set('folderId', folderId);
    if (q.trim()) next.set('q', q.trim());
    else next.delete('q');
    navigate(`/search?${next.toString()}`);
  };

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 px-3 sm:gap-4 sm:px-4">
      <IconButton label="Open navigation" className="lg:hidden" onClick={onOpenNav}>
        <MenuIcon className="size-5" />
      </IconButton>
      <div className="lg:hidden">
        <Logo className="[&>span:last-child]:hidden sm:[&>span:last-child]:inline" />
      </div>
      <form role="search" onSubmit={submit} className="min-w-0 max-w-2xl flex-1">
        <label htmlFor="global-search" className="sr-only">Search your drive</label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
          <input
            id="global-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={100}
            placeholder={folderId ? 'Search in this folder' : 'Search in Drive'}
            className="input focus-ring rounded-full border-transparent bg-surface-hover pl-10 pr-20 focus:border-line focus:bg-surface [&::-webkit-search-cancel-button]:hidden"
          />
          <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">
            {q && (
              <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="icon-btn icon-btn-sm focus-ring rounded-full">
                <X className="size-4" />
              </button>
            )}
            <button type="button" aria-label="Advanced search" title="Advanced search" onClick={() => setAdvanced(true)} className="icon-btn icon-btn-sm focus-ring rounded-full">
              <SlidersHorizontal className="size-4" />
            </button>
          </div>
        </div>
      </form>
      <button
        ref={avatar}
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        onClick={() => {
          const r = avatar.current!.getBoundingClientRect();
          setMenuAt({ x: r.right - 208, y: r.bottom + 6 });
        }}
        className="avatar avatar-solid focus-ring ml-auto"
      >
        {user?.name.slice(0, 1).toUpperCase()}
      </button>
      <Menu
        label="Account"
        at={menuAt}
        onClose={() => setMenuAt(null)}
        items={[
          { label: 'Settings', icon: <Settings />, onSelect: () => navigate('/settings') },
          { label: 'Sign out', icon: <LogOut />, onSelect: () => void signOut() },
        ]}
      />
      <AdvancedSearch open={advanced} onClose={() => setAdvanced(false)} />
    </header>
  );
}
