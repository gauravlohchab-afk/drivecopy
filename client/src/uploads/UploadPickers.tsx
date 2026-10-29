import { forwardRef, useImperativeHandle, useRef } from 'react';
import { useUploadManager } from './UploadsProvider';
import { useToast } from '../components/ui/Toast';
import { errorMessage } from '../api/client';

export interface UploadPickersHandle {
  pickFiles: () => void;
  pickFolder: () => void;
}

/** Hidden native file inputs. Folder upload uses webkitdirectory where the browser supports it. */
export const UploadPickers = forwardRef<UploadPickersHandle, { parentId: string | null }>(function UploadPickers({ parentId }, ref) {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const manager = useUploadManager();
  const toast = useToast();

  useImperativeHandle(ref, () => ({
    pickFiles: () => files.current?.click(),
    pickFolder: () => folder.current?.click(),
  }));

  return (
    <>
      <input
        ref={files}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(e) => {
          const list = [...(e.target.files ?? [])];
          e.target.value = '';
          if (list.length) manager.add(list, parentId);
        }}
      />
      <input
        ref={(el) => {
          folder.current = el;
          el?.setAttribute('webkitdirectory', '');
        }}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const list = [...(e.target.files ?? [])];
          e.target.value = '';
          if (list.length) manager.addFolder(list, parentId).catch((err) => toast({ kind: 'error', message: errorMessage(err) }));
        }}
      />
    </>
  );
});

export const supportsFolderUpload = () => typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input');
