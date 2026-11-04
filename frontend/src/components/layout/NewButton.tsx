import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { FolderPlus, FolderUp, Plus, Upload } from 'lucide-react';
import { Menu, type MenuEntry } from '../ui/Menu';
import { useDriveActions } from '../drive/DriveActions';
import { UploadPickers, supportsFolderUpload, type UploadPickersHandle } from '../../uploads/UploadPickers';
import { useCurrentDrive, useCurrentFolderId } from '../../hooks/useCurrentFolder';
import { driveApi } from '../../api/endpoints';

/** "New" (create folder / upload) as the sidebar button, or as the floating action button on phones and tablets. */
export function NewButton({ variant, className }: { variant: 'sidebar' | 'fab'; className?: string }) {
  const actions = useDriveActions();
  const drive = useCurrentDrive();
  const myDriveFolderId = useCurrentFolderId();
  // Inside a shared drive, New creates there; viewers can't add anything.
  const driveId = drive?.driveId ?? null;
  const folderId = drive ? drive.folderId : myDriveFolderId;
  const info = useQuery({ queryKey: ['drives', driveId, 'info'], queryFn: () => driveApi.get(driveId!), enabled: Boolean(driveId) });
  const pickers = useRef<UploadPickersHandle>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  const entries: MenuEntry[] = [
    { label: 'New folder', icon: <FolderPlus />, onSelect: () => actions.newFolder(folderId, driveId) },
    'separator',
    { label: 'Upload files', icon: <Upload />, onSelect: () => pickers.current?.pickFiles() },
    ...(supportsFolderUpload() ? [{ label: 'Upload folder', icon: <FolderUp />, onSelect: () => pickers.current?.pickFolder() }] : []),
  ];

  const open = () => {
    const r = button.current!.getBoundingClientRect();
    // The FAB sits at the bottom right, so its menu opens above it, right-aligned.
    setMenuAt(variant === 'fab' ? { x: r.right - 208, y: r.top - 8 } : { x: r.left, y: r.bottom + 6 });
  };

  if (driveId && (!info.data || info.data.drive.role === 'viewer')) return null;

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={Boolean(menuAt)}
        aria-label={variant === 'fab' ? 'New' : undefined}
        onClick={open}
        className={clsx(
          variant === 'fab'
            ? 'btn btn-primary focus-ring size-14 rounded-card p-0 shadow-pop'
            : 'btn btn-secondary focus-ring mb-4 h-11 w-fit px-5 font-semibold shadow-card',
          className,
        )}
      >
        {variant === 'fab' ? <Plus className="size-7" /> : <><Plus className="size-5 text-accent" /> New</>}
      </button>
      <Menu label="Create or upload" title={variant === 'fab' ? 'Create new' : undefined} at={menuAt} items={entries} onClose={() => setMenuAt(null)} />
      <UploadPickers ref={pickers} parentId={folderId} driveId={driveId} />
    </>
  );
}
