import { NavLink } from 'react-router';
import { Activity, HardDrive, House, Settings, Trash2, LogOut } from 'lucide-react';
import { Logo } from './Logo';
import { StorageInfo } from './StorageInfo';
import { NewButton } from './NewButton';
import { useAuth, useSignOut } from '../../hooks/useAuth';

const navItems = [
  { to: '/home', label: 'Home', icon: House },
  { to: '/drive', label: 'My Drive', icon: HardDrive },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/trash', label: 'Trash', icon: Trash2 },
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
        <div className="space-y-0.5">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={onNavigate}
              className="nav-link focus-ring"
            >
              <Icon className="size-[18px]" /> {label}
            </NavLink>
          ))}
        </div>
        <div className="px-3 pt-1">
          <StorageInfo />
        </div>
      </div>

      <div className="mt-auto space-y-1 pt-4">
        <NavLink
          to="/settings"
          onClick={onNavigate}
          className="nav-link focus-ring"
        >
          <Settings className="size-[18px]" /> Settings
        </NavLink>
        <div className="flex items-center gap-3 px-3 py-2">
          <span className="avatar avatar-solid avatar-sm" aria-hidden>
            {user?.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user?.name}</p>
            <p className="truncate text-xs text-ink-muted">{user?.email}</p>
          </div>
          <button type="button" onClick={() => void signOut()} aria-label="Sign out" title="Sign out" className="icon-btn icon-btn-sm focus-ring">
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </nav>
  );
}
