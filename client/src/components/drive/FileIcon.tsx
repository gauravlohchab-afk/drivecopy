import { File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Presentation } from 'lucide-react';
import clsx from 'clsx';
import type { DriveItem } from '../../api/types';

const styles: Record<string, { icon: typeof File; className: string }> = {
  folder: { icon: Folder, className: 'text-brand-500 bg-brand-50' },
  image: { icon: FileImage, className: 'text-rose-500 bg-rose-50' },
  video: { icon: FileVideo, className: 'text-fuchsia-600 bg-fuchsia-50' },
  audio: { icon: FileAudio, className: 'text-amber-600 bg-amber-50' },
  pdf: { icon: FileText, className: 'text-red-600 bg-red-50' },
  document: { icon: FileText, className: 'text-blue-600 bg-blue-50' },
  spreadsheet: { icon: FileSpreadsheet, className: 'text-emerald-600 bg-emerald-50' },
  presentation: { icon: Presentation, className: 'text-orange-600 bg-orange-50' },
  text: { icon: FileText, className: 'text-slate-600 bg-slate-100' },
  archive: { icon: FileArchive, className: 'text-yellow-700 bg-yellow-50' },
  other: { icon: File, className: 'text-slate-500 bg-slate-100' },
};

export function FileIcon({ item, size = 'md' }: { item: DriveItem; size?: 'sm' | 'md' | 'lg' }) {
  const key = item.kind === 'folder' ? 'folder' : item.category;
  const s = styles[key] ?? styles.other!;
  const Icon = s.icon;
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-lg',
        s.className,
        size === 'sm' && 'size-8 [&>svg]:size-4',
        size === 'md' && 'size-9 [&>svg]:size-5',
        size === 'lg' && 'size-14 rounded-2xl [&>svg]:size-7',
      )}
    >
      <Icon fill={item.kind === 'folder' ? 'currentColor' : 'none'} fillOpacity={item.kind === 'folder' ? 0.18 : 0} />
    </span>
  );
}

export function typeLabel(item: DriveItem) {
  if (item.kind === 'folder') return 'Folder';
  const ext = item.extension?.toUpperCase();
  const names: Record<string, string> = { pdf: 'PDF', image: 'Image', video: 'Video', audio: 'Audio', document: 'Document', spreadsheet: 'Spreadsheet', presentation: 'Presentation', text: 'Text', archive: 'Archive' };
  const kind = names[item.category] ?? 'File';
  return ext && ext !== kind.toUpperCase() ? `${kind} · ${ext}` : kind;
}
