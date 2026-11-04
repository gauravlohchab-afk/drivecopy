import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderPlus, Upload } from 'lucide-react';
import { discoveryApi } from '../api/endpoints';
import { FileBrowser } from '../components/drive/FileBrowser';
import { PageHeader } from '../components/drive/PageHeader';
import { EmptyState } from '../components/ui/States';
import { Button } from '../components/ui/Button';
import { useViewPrefs } from '../hooks/usePrefs';
import { useDriveActions } from '../components/drive/DriveActions';
import { UploadPickers, type UploadPickersHandle } from '../uploads/UploadPickers';
import { Logo } from '../components/layout/Logo';

/** Suggested folders and files: what the user worked on lately, plus things recently shared with them. */
export function HomePage() {
  const prefs = useViewPrefs();
  const actions = useDriveActions();
  const pickers = useRef<UploadPickersHandle>(null);
  const q = useQuery({ queryKey: ['home'], queryFn: discoveryApi.home });

  return (
    <>
      <PageHeader title="Welcome to Ageless Datahub" view={prefs.view} onView={prefs.setView} />
      <UploadPickers ref={pickers} parentId={null} />
      <FileBrowser
        folders={q.data?.folders ?? []}
        files={q.data?.files ?? []}
        view={prefs.view}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        sectionTitles={{ folders: 'Suggested folders', files: 'Suggested files' }}
        empty={
          <EmptyState
            icon={<Logo className="[&>span:last-child]:hidden" />}
            title="Nothing here yet"
            body="Files and folders you upload, open or are shared with you will be suggested here."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => pickers.current?.pickFiles()}>Upload files</Button>
                <Button icon={<FolderPlus className="size-4" />} onClick={() => actions.newFolder(null)}>New folder</Button>
              </div>
            }
          />
        }
      />
    </>
  );
}
