import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { LoaderCircle } from 'lucide-react';
import { AppLayout } from './components/layout/AppLayout';
import { DriveActionsProvider } from './components/drive/DriveActions';
import { UploadsProvider } from './uploads/UploadsProvider';
import { ErrorState } from './components/ui/States';
import { useAuth } from './hooks/useAuth';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { DrivePage } from './pages/DrivePage';
import { RecentPage, StarredPage, TrashPage } from './pages/ListPages';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';

/** Client-side guard for UX only. Every API route enforces authentication on the server. */
function RequireAuth() {
  const { user, isLoading, error, refetch } = useAuth();
  const location = useLocation();
  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <LoaderCircle className="size-7 animate-spin text-brand-500" aria-label="Loading" />
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
  { path: '/register', element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <Navigate to="/drive" replace /> },
          { path: '/drive', element: <DrivePage /> },
          { path: '/folders/:folderId', element: <DrivePage /> },
          { path: '/recent', element: <RecentPage /> },
          { path: '/starred', element: <StarredPage /> },
          { path: '/trash', element: <TrashPage /> },
          { path: '/search', element: <SearchPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '*', element: <Navigate to="/drive" replace /> },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
