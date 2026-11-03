import { Link, useLocation } from 'react-router';
import clsx from 'clsx';
import { HardDrive, House, Star, Trash2, Users } from 'lucide-react';

const tabs = [
  { to: '/home', label: 'Home', icon: House },
  { to: '/drive', label: 'Drive', icon: HardDrive },
  { to: '/starred', label: 'Starred', icon: Star },
  { to: '/shared', label: 'Shared', icon: Users },
  { to: '/trash', label: 'Trash', icon: Trash2 },
];

/** Phone navigation bar. Folder pages count as "Drive", shared folders as "Shared". */
export function BottomNav() {
  const { pathname } = useLocation();
  const isActive = (to: string) =>
    pathname === to || (to === '/drive' && pathname.startsWith('/folders/')) || (to === '/shared' && pathname.startsWith('/shared/'));
  return (
    <nav aria-label="Sections" className="shrink-0 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className="grid h-16 grid-cols-5">
        {tabs.map(({ to, label, icon: Icon }) => {
          const active = isActive(to);
          return (
            <li key={to}>
              <Link
                to={to}
                aria-current={active ? 'page' : undefined}
                className="focus-ring flex h-full flex-col items-center justify-center gap-1 text-xs font-medium outline-none"
              >
                <span className={clsx('flex h-8 w-12 items-center justify-center rounded-full transition-colors', active ? 'bg-brand-100 text-brand-800' : 'text-slate-500')}>
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className={active ? 'text-slate-900' : 'text-slate-500'}>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
