import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Dashboard from './pages/Dashboard.jsx';
// The meeting screen pulls in the whole media SDK, so it loads only when someone opens a meeting.
const MeetingPage = lazy(() => import('./pages/MeetingPage.jsx'));

const Loading = () => (
  <main className="notice"><div className="notice-card"><span className="spinner big" aria-label="Loading" /></div></main>
);

// Invite links can be /join/ABC234 or /meeting/ABC234; both open the meeting.
function JoinRedirect() {
  const { code } = useParams();
  return <Navigate to={`/meeting/${code}`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/meeting/:code" element={<ProtectedRoute><Suspense fallback={<Loading />}><MeetingPage /></Suspense></ProtectedRoute>} />
      <Route path="/join/:code" element={<ProtectedRoute><JoinRedirect /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
