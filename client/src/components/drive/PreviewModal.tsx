import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, LoaderCircle } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/States';
import { fileApi } from '../../api/endpoints';
import type { FileItem } from '../../api/types';
import { FileIcon, typeLabel } from './FileIcon';
import { formatBytes, formatDate } from '../../lib/format';

const PREVIEWABLE = new Set(['image', 'video', 'audio', 'pdf', 'text']);
const NO_INLINE = new Set(['image/heic', 'video/x-msvideo', 'application/json']);

export const canPreview = (f: FileItem) => PREVIEWABLE.has(f.category) && !NO_INLINE.has(f.mimeType);

export function PreviewModal({ file, onClose, onDownload }: { file: FileItem | null; onClose: () => void; onDownload: (f: FileItem) => void }) {
  return (
    <Modal open={Boolean(file)} onClose={onClose} title={file?.name ?? ''} size="full" footer={file && (
      <>
        <span className="mr-auto self-center text-xs text-slate-500">{typeLabel(file)} · {formatBytes(file.size)} · Modified {formatDate(file.updatedAt)}</span>
        <Button variant="primary" icon={<Download className="size-4" />} onClick={() => onDownload(file)}>Download</Button>
      </>
    )}>
      {file && <PreviewBody key={file.id} file={file} onDownload={onDownload} />}
    </Modal>
  );
}

function PreviewBody({ file, onDownload }: { file: FileItem; onDownload: (f: FileItem) => void }) {
  const enabled = canPreview(file);
  const q = useQuery({
    queryKey: ['preview', file.id],
    queryFn: () => fileApi.previewUrl(file.id),
    enabled,
    staleTime: 5 * 60_000,
    gcTime: 0,
  });
  const [mediaError, setMediaError] = useState(false);
  const resumeAt = useRef(0);

  if (!enabled) return <NoPreview file={file} onDownload={onDownload} reason="Preview isn’t available for this file type." />;
  if (q.isLoading) return <div className="flex h-full min-h-64 items-center justify-center"><LoaderCircle className="size-6 animate-spin text-brand-500" aria-label="Loading preview" /></div>;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const url = q.data.url;

  switch (file.category) {
    case 'image':
      return <div className="flex h-full items-center justify-center"><img src={url} alt={file.name} className="max-h-full max-w-full rounded-lg object-contain" /></div>;
    case 'pdf':
    case 'text':
      return <iframe title={file.name} src={url} className="h-full min-h-[60vh] w-full rounded-lg border border-slate-200 bg-white" />;
    case 'video':
    case 'audio': {
      if (mediaError) return <NoPreview file={file} onDownload={onDownload} reason="Your browser can’t play this format or codec. Download the file to play it in another app." />;
      const Media = file.category === 'video' ? 'video' : 'audio';
      return (
        <div className="flex h-full items-center justify-center">
          {/* Streams with HTTP range requests straight from storage; never buffered whole in memory. */}
          <Media
            src={url}
            controls
            preload="metadata"
            playsInline
            className={file.category === 'video' ? 'max-h-full w-full rounded-lg bg-black' : 'w-full max-w-xl'}
            onLoadedMetadata={(e) => {
              if (resumeAt.current) e.currentTarget.currentTime = resumeAt.current;
            }}
            onError={async (e) => {
              const el = e.currentTarget;
              // A long session can outlive the short-lived URL: fetch a fresh one and resume.
              if (el.currentTime > 0 && Date.now() > new Date(q.data!.expiresAt).getTime() - 5_000) {
                resumeAt.current = el.currentTime;
                await q.refetch();
              } else {
                setMediaError(true);
              }
            }}
          />
        </div>
      );
    }
    default:
      return <NoPreview file={file} onDownload={onDownload} reason="Preview isn’t available for this file type." />;
  }
}

function NoPreview({ file, reason, onDownload }: { file: FileItem; reason: string; onDownload: (f: FileItem) => void }) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center text-center">
      <FileIcon item={file} size="lg" />
      <p className="mt-4 max-w-sm text-sm text-slate-600">{reason}</p>
      <Button className="mt-4" variant="primary" icon={<Download className="size-4" />} onClick={() => onDownload(file)}>Download</Button>
    </div>
  );
}
