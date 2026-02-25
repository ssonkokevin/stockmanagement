import { useState } from 'react';
import { usePlatformAuth, DEMO_USERS } from '../hooks/usePlatformAuth';
import type { PlatformRole } from '../types/simcard';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const { login } = usePlatformAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await login(email, password);
    
    if (result.success) {
      onClose();
      // Force page refresh to update UI with new auth state
      window.location.reload();
    } else {
      setError(result.message);
    }
    
    setLoading(false);
  };

  const handleQuickLogin = async (userEmail: string) => {
    setEmail(userEmail);
    setPassword('demo123');
    setError('');
    setLoading(true);

    const result = await login(userEmail, 'demo123');
    
    if (result.success) {
      onClose();
      window.location.reload();
    } else {
      setError(result.message);
    }
    
    setLoading(false);
  };

  const getRoleBadge = (role: PlatformRole) => {
    const colors: Record<PlatformRole, string> = {
      SUPER_ADMIN: 'bg-danger',
      MANAGEMENT: 'bg-warning text-dark',
      MVNO_ADMIN: 'bg-primary',
      DISTRIBUTOR: 'bg-info text-dark',
    };
    return colors[role] || 'bg-secondary';
  };

  return (
    <div className="modal d-block" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
      <div className="modal-dialog modal-dialog-centered modal-lg">
        <div className="modal-content card card-custom">
          <div className="modal-header card-header card-header-custom">
            <h5 className="modal-title">
              <i className="bi bi-shield-lock me-2"></i>
              MVNE Platform Login
            </h5>
            <button 
              type="button" 
              className="btn-close btn-close-white"
              onClick={onClose}
            ></button>
          </div>
          <div className="modal-body">
            <div className="row">
              {/* Login Form */}
              <div className="col-md-5 border-end">
                <h6 className="mb-3">Sign In</h6>
                <form onSubmit={handleSubmit}>
                  <div className="mb-3">
                    <label className="form-label">Email</label>
                    <input
                      type="email"
                      className="form-control form-control-custom"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="Enter your email"
                      required
                    />
                  </div>
                  <div className="mb-3">
                    <label className="form-label">Password</label>
                    <input
                      type="password"
                      className="form-control form-control-custom"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                      required
                    />
                  </div>
                  {error && (
                    <div className="alert alert-danger-custom py-2 mb-3">
                      {error}
                    </div>
                  )}
                  <button 
                    type="submit" 
                    className="btn btn-accent w-100"
                    disabled={loading}
                  >
                    {loading ? 'Signing in...' : 'Sign In'}
                  </button>
                </form>
              </div>

              {/* Demo Users */}
              <div className="col-md-7">
                <h6 className="mb-3">Demo Users (Click to Quick Login)</h6>
                <div className="d-flex flex-column gap-2">
                  {DEMO_USERS.map((user) => (
                    <button
                      key={user.email}
                      className="btn btn-outline-custom d-flex justify-content-between align-items-center p-3"
                      onClick={() => handleQuickLogin(user.email)}
                      disabled={loading}
                    >
                      <div className="text-start">
                        <div className="fw-bold">{user.name}</div>
                        <small className="text-muted-custom">{user.email}</small>
                      </div>
                      <span className={`badge ${getRoleBadge(user.role)}`}>
                        {user.role.replace('_', ' ')}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="mt-3 p-2 bg-dark-subtle rounded">
                  <small className="text-muted-custom">
                    <i className="bi bi-info-circle me-1"></i>
                    Password for all demo users: <code>demo123</code>
                  </small>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
