import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../services/auth';
import { useAppStore } from '../store/useAppStore';

export function Login() {
  const navigate = useNavigate();
  const setUser = useAppStore((s) => s.setUser);
  const setToken = useAppStore((s) => s.setToken);
  const [email, setEmail]       = useState('admin@paxtel.com');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token, user } = await login(email, password);
      if (user.role !== 'MVNO_ADMIN' && user.role !== 'SUPER_ADMIN') {
        setError('Access denied — this portal is for MVNO Admins only.');
        return;
      }
      setToken(token);
      setUser({
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: user.role,
        tenantId: import.meta.env.VITE_TENANT_SLUG || null,
        mvnoId: user.mvno_id ?? null,
      });
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Invalid email or password');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: '#0D1B2E', fontFamily: 'Outfit, sans-serif' }}
    >
      <div className="bg-white rounded-card shadow-2xl w-full max-w-sm p-8" style={{ borderRadius: 10 }}>
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-white text-lg"
            style={{ background: '#10B981' }}
          >
            P
          </div>
          <div>
            <div className="font-bold text-gray-900 text-lg leading-tight">PAXTEL</div>
            <div className="text-xs leading-tight" style={{ color: '#10B981' }}>Admin Portal</div>
          </div>
        </div>

        <h2 className="text-xl font-bold text-gray-900 mb-1">Welcome back</h2>
        <p className="text-sm text-gray-500 mb-6">Sign in to manage your SIM stock</p>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-btn text-sm text-red-700 bg-red-50 border border-red-200">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Email address</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-btn focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ borderRadius: 6 }}
              placeholder="admin@paxtel.com"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-btn focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ borderRadius: 6 }}
              placeholder="Enter your password"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 text-sm font-semibold text-white rounded-btn transition-opacity disabled:opacity-60"
            style={{ background: '#10B981', borderRadius: 6 }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
