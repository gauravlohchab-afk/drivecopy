import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { LoaderCircle } from 'lucide-react';
import { AppLayout } from './components/layout/AppLayout';
import { DriveActionsProvider } from './components/drive/DriveActions';
import { UploadsProvider } from './uploads/UploadsProvider';
import { ErrorState } from './components/ui/States';
import { useAuth } from './hooks/useAuth';
import { LoginPage } from './pages/AuthPages';
import { DrivePage } from './pages/DrivePage';
import { RecentPage, StarredPage, TrashPage } from './pages/ListPages';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { SharedPage, SharedFolderPage } from './pages/SharedPages';
import { HomePage } from './pages/HomePage';
import { ActivityPage } from './pages/ActivityPage';
import { StoragePage } from './pages/StoragePage';
import { WorkspacesPage, WorkspacePage } from './pages/WorkspacePages';
import { SharedDrivesPage, DriveTrashPage } from './pages/SharedDrivePages';

/** Client-side guard for UX only. Every API route enforces authentication on the server. */
function RequireAuth() {
  const { user, isLoading, error, refetch } = useAuth();
  const location = useLocation();
  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <LoaderCircle className="size-7 animate-spin text-accent" aria-label="Loading" />
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return (
    <UploadsProvider>
      <DriveActionsProvider>
        <Outlet />
      </DriveActionsProvider>
    </UploadsProvider>
  );
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <Navigate to="/home" replace /> },
          { path: '/home', element: <HomePage /> },
          { path: '/activity', element: <ActivityPage /> },
          { path: '/workspaces', element: <WorkspacesPage /> },
          { path: '/workspaces/:workspaceId', element: <WorkspacePage /> },
          { path: '/storage', element: <StoragePage /> },
          { path: '/drive', element: <DrivePage /> },
          { path: '/folders/:folderId', element: <DrivePage /> },
          { path: '/drives', element: <SharedDrivesPage /> },
          { path: '/drives/:driveId', element: <DrivePage /> },
          { path: '/drives/:driveId/folders/:folderId', element: <DrivePage /> },
          { path: '/drives/:driveId/trash', element: <DriveTrashPage /> },
          { path: '/recent', element: <RecentPage /> },
          { path: '/starred', element: <StarredPage /> },
          { path: '/trash', element: <TrashPage /> },
          { path: '/shared', element: <SharedPage /> },
          { path: '/shared/folders/:folderId', element: <SharedFolderPage /> },
          { path: '/search', element: <SearchPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '*', element: <Navigate to="/home" replace /> },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
