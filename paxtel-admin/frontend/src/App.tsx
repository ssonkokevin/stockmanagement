import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { StockRequests } from './pages/StockRequests';
import { ApproveRequests } from './pages/ApproveRequests';
import { useAppStore } from './store/useAppStore';
import { useSocket } from './hooks/useSocket';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useAppStore((s) => s.authToken);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const token = useAppStore((s) => s.authToken);
  const setToken = useAppStore((s) => s.setToken);
  const setUser = useAppStore((s) => s.setUser);

  useSocket();

  // Check token expiry on mount
  useEffect(() => {
    if (token) {
      try {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
            setToken(null);
            setUser(null);
          }
        }
      } catch {
        setToken(null);
        setUser(null);
      }
    }
  }, [token, setToken, setUser]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
        <Route path="/requests"  element={<RequireAuth><StockRequests /></RequireAuth>} />
        <Route path="/approve"   element={<RequireAuth><ApproveRequests /></RequireAuth>} />
        <Route path="*"          element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
