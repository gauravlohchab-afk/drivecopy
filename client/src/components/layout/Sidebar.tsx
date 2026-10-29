import { useRef, useState } from 'react';
import { NavLink } from 'react-router';
import clsx from 'clsx';
import { Clock, FolderPlus, FolderUp, HardDrive, Plus, Settings, Star, Trash2, Upload, LogOut } from 'lucide-react';
import { Logo } from './Logo';
import { StorageMeter } from './StorageMeter';
import { Menu, type MenuEntry } from '../ui/Menu';
import { useDriveActions } from '../drive/DriveActions';
import { UploadPickers, supportsFolderUpload, type UploadPickersHandle } from '../../uploads/UploadPickers';
import { useCurrentFolderId } from '../../hooks/useCurrentFolder';
import { useAuth, useSignOut } from '../../hooks/useAuth';

const nav = [
  { to: '/drive', label: 'My Drive', icon: HardDrive },
  { to: '/recent', label: 'Recent', icon: Clock },
  { to: '/starred', label: 'Starred', icon: Star },
  { to: '/trash', label: 'Trash', icon: Trash2 },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const actions = useDriveActions();
  const folderId = useCurrentFolderId();
  const pickers = useRef<UploadPickersHandle>(null);
  const newBtn = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const { user } = useAuth();
  const signOut = useSignOut();

  const entries: MenuEntry[] = [
    { label: 'New folder', icon: <FolderPlus />, onSelect: () => actions.newFolder(folderId) },
    'separator',
    { label: 'Upload files', icon: <Upload />, onSelect: () => pickers.current?.pickFiles() },
    ...(supportsFolderUpload() ? [{ label: 'Upload folder', icon: <FolderUp />, onSelect: () => pickers.current?.pickFolder() }] : []),
  ];

  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 px-3 py-4">
      <div className="px-2 pb-4">
        <Logo />
      </div>
      <button
        ref={newBtn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={Boolean(menuAt)}
        onClick={() => {
          const r = newBtn.current!.getBoundingClientRect();
          setMenuAt({ x: r.left, y: r.bottom + 6 });
        }}
        className="focus-ring mb-4 inline-flex h-12 w-fit items-center gap-2 rounded-2xl bg-white px-5 text-sm font-semibold text-slate-800 shadow-md shadow-slate-900/10 ring-1 ring-slate-200 transition hover:shadow-lg hover:ring-brand-200"
      >
        <Plus className="size-5 text-brand-600" /> New
      </button>
      <Menu label="Create or upload" at={menuAt} items={entries} onClose={() => setMenuAt(null)} />
      <UploadPickers ref={pickers} parentId={folderId} />

      {nav.map(({ to, label, icon: Icon }) => (
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

      <div className="mt-4 border-t border-slate-200 pt-4">
        <StorageMeter />
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
