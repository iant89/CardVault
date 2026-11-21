import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { useSession } from '../stores/session';
import { setUnauthorizedHandler } from '../services/api';
import { LoginPage } from '../features/auth/LoginPage';
import { Shell } from './Shell';
import { Loading } from '../components/ui';

const HomePage = lazy(() => import('../features/home/HomePage'));
const CollectionPage = lazy(() => import('../features/collection/CollectionPage'));
const ScanPage = lazy(() => import('../features/scanner/ScanPage'));
const QueuePage = lazy(() => import('../features/queue/QueuePage'));
const ReviewPage = lazy(() => import('../features/manual-review/ReviewPage'));
const SearchPage = lazy(() => import('../features/search/SearchPage'));
const UsersPage = lazy(() => import('../features/admin/UsersPage'));
const SystemPage = lazy(() => import('../features/admin/SystemPage'));
const ProfilePage = lazy(() => import('../features/auth/ProfilePage'));

export function App() {
  const { user, loading, load } = useSession();
  useEffect(() => {
    void load();
    setUnauthorizedHandler(() => useSession.setState({ user: null }));
  }, [load]);

  if (loading) return <Loading label="Opening the vault…" />;
  if (!user) return <LoginPage />;
  const admin = user.role === 'ADMIN';

  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/collection" element={<CollectionPage />} />
          <Route path="/scan" element={<ScanPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          {admin && <Route path="/admin/users" element={<UsersPage />} />}
          {admin && <Route path="/admin/system" element={<SystemPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
