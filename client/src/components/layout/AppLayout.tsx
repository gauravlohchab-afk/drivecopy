import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import clsx from 'clsx';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { UploadPanel } from './UploadPanel';

export function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className="flex h-dvh overflow-hidden bg-slate-50">
      <aside className="hidden w-64 shrink-0 lg:block">
        <Sidebar />
      </aside>
      {/* Mobile / tablet navigation drawer */}
      <div className={clsx('fixed inset-0 z-50 lg:hidden', navOpen ? 'pointer-events-auto' : 'pointer-events-none')} aria-hidden={!navOpen}>
        <div className={clsx('absolute inset-0 bg-slate-900/40 transition-opacity', navOpen ? 'opacity-100' : 'opacity-0')} onClick={() => setNavOpen(false)} />
        <aside
          className={clsx('absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-slate-50 shadow-xl transition-transform', navOpen ? 'translate-x-0' : '-translate-x-full')}
          inert={!navOpen}
        >
          <Sidebar onNavigate={() => setNavOpen(false)} />
        </aside>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenNav={() => setNavOpen(true)} />
        <main className="min-h-0 flex-1 overflow-y-auto px-2 pb-24 sm:px-4 lg:pr-4">
          <div className="min-h-full rounded-t-2xl bg-white px-3 py-4 shadow-sm ring-1 ring-slate-200/70 sm:px-6 sm:py-5">
            <Outlet />
          </div>
        </main>
      </div>
      <UploadPanel />
    </div>
  );
}
