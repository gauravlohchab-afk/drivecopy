import { Link, useLocation } from 'react-router';
import clsx from 'clsx';
import { Activity, HardDrive, House, Trash2 } from 'lucide-react';

const tabs = [
  { to: '/home', label: 'Home', icon: House },
  { to: '/drive', label: 'Drive', icon: HardDrive },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/trash', label: 'Trash', icon: Trash2 },
];

/** Phone navigation bar. Folder pages count as "Drive". */
export function BottomNav() {
  const { pathname } = useLocation();
  const isActive = (to: string) => pathname === to || (to === '/drive' && pathname.startsWith('/folders/'));
  return (
    <nav aria-label="Sections" className="shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className="grid h-16 grid-cols-4">
        {tabs.map(({ to, label, icon: Icon }) => {
          const active = isActive(to);
          return (
            <li key={to}>
              <Link
                to={to}
                aria-current={active ? 'page' : undefined}
                className="focus-ring flex h-full flex-col items-center justify-center gap-1 text-xs font-medium outline-none"
              >
                <span className={clsx('flex h-8 w-12 items-center justify-center rounded-full transition-colors', active ? 'bg-accent-softer text-accent-ink-strong' : 'text-ink-muted')}>
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className={active ? 'text-ink-strong' : 'text-ink-muted'}>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
