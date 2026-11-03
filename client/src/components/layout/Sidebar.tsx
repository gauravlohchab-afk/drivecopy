import { NavLink } from 'react-router';
import clsx from 'clsx';
import { Activity, Clock, Cloud, HardDrive, House, Network, Settings, Shapes, Star, Trash2, LogOut, Users } from 'lucide-react';
import { Logo } from './Logo';
import { StorageMeter } from './StorageMeter';
import { NewButton } from './NewButton';
import { useAuth, useSignOut } from '../../hooks/useAuth';

export const navGroups = [
  [
    { to: '/home', label: 'Home', icon: House },
    { to: '/activity', label: 'Activity', icon: Activity },
    { to: '/workspaces', label: 'Workspaces', icon: Shapes },
  ],
  [
    { to: '/drive', label: 'My Drive', icon: HardDrive },
    { to: '/drives', label: 'Shared drives', icon: Network },
    { to: '/shared', label: 'Shared with me', icon: Users },
  ],
  [
    { to: '/recent', label: 'Recent', icon: Clock },
    { to: '/starred', label: 'Starred', icon: Star },
  ],
  [
    { to: '/trash', label: 'Trash', icon: Trash2 },
    { to: '/storage', label: 'Storage', icon: Cloud },
  ],
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const signOut = useSignOut();

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 px-3 py-4">
      <div className="px-2 pb-4">
        <Logo />
      </div>
      {/* In the phone/tablet drawer the floating button provides "New" instead. */}
      {!onNavigate && <NewButton variant="sidebar" />}

      <div className="min-h-0 space-y-3 overflow-y-auto">
        {navGroups.map((group, i) => (
          <div key={i} className="space-y-0.5">
            {group.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  clsx(
                    'focus-ring flex items-center gap-3 rounded-full px-4 py-2 text-sm font-medium transition-colors',
                    isActive ? 'bg-brand-100 text-brand-800' : 'text-slate-600 hover:bg-slate-200/60',
                  )
                }
              >
                <Icon className="size-[18px]" /> {label}
              </NavLink>
            ))}
          </div>
        ))}
        <div className="px-3 pt-1">
          <StorageMeter />
        </div>
      </div>

      <div className="mt-auto space-y-1 pt-4">
        <NavLink
          to="/settings"
          onClick={onNavigate}
          className={({ isActive }) =>
            clsx('focus-ring flex items-center gap-3 rounded-full px-4 py-2 text-sm font-medium', isActive ? 'bg-brand-100 text-brand-800' : 'text-slate-600 hover:bg-slate-200/60')
          }
        >
          <Settings className="size-[18px]" /> Settings
        </NavLink>
        <div className="flex items-center gap-3 rounded-xl px-3 py-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white" aria-hidden>
            {user?.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-800">{user?.name}</p>
            <p className="truncate text-xs text-slate-500">{user?.email}</p>
          </div>
          <button type="button" onClick={() => void signOut()} aria-label="Sign out" title="Sign out" className="focus-ring rounded-lg p-2 text-slate-500 hover:bg-slate-200/60 hover:text-slate-800">
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </nav>
  );
}
