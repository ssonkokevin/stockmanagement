import { useState, useEffect } from 'react';
import { usePlatformAuth } from '../hooks/usePlatformAuth';
import { DEMO_USERS } from '../hooks/usePlatformAuth';
import type { PlatformRole } from '../types/simcard';

interface LoginPageProps {
  onLoginSuccess?: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const { login, isAuthenticated, user } = usePlatformAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Get unique roles for filtering
  const getUsersByRole = (role: PlatformRole) => {
    return DEMO_USERS.filter(u => u.role === role);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await login(email, password);
    
    if (result.success) {
      onLoginSuccess?.();
    } else {
      setError(result.message);
    }
    
    setLoading(false);
  };

  const handleQuickLogin = async (userEmail: string, userPassword: string = 'demo123') => {
    setEmail(userEmail);
    setPassword(userPassword);
    setError('');
    setLoading(true);

    const result = await login(userEmail, userPassword);
    
    if (result.success) {
      onLoginSuccess?.();
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

  const getRoleDescription = (role: PlatformRole) => {
    const descriptions: Record<PlatformRole, string> = {
      SUPER_ADMIN: 'Full system access, can manage all MVNOs and view all data',
      MANAGEMENT: 'Operational oversight, can approve requests and view reports',
      MVNO_ADMIN: 'Manage own stock, approve distributors, generate reports',
      DISTRIBUTOR: 'Request stock from MVNO, view own transaction history',
    };
    return descriptions[role];
  };

  return (
    <div className="min-vh-100 d-flex align-items-center justify-content-center" 
         style={{ background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' }}>
      <div className="container">
        <div className="row justify-content-center">
          <div className="col-12 col-lg-10">
            <div className="card border-0 shadow-lg" style={{ borderRadius: '20px', overflow: 'hidden' }}>
              <div className="row g-0">
                {/* Left Side - Login Form */}
                <div className="col-lg-5 bg-dark text-white p-5">
                  <div className="text-center mb-4">
                    <i className="bi bi-shield-lock display-1 text-accent"></i>
                    <h2 className="mt-3 fw-bold">SIM Stock Manager</h2>
                    <p className="text-muted">MVNE Platform</p>
                  </div>

                  <form onSubmit={handleSubmit}>
                    <div className="mb-4">
                      <label className="form-label text-white-50">Email Address</label>
                      <div className="input-group">
                        <span className="input-group-text bg-dark border-secondary">
                          <i className="bi bi-envelope text-muted"></i>
                        </span>
                        <input
                          type="email"
                          className="form-control bg-dark border-secondary text-white"
                          placeholder="Enter your email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                        />
                      </div>
                    </div>

                    <div className="mb-4">
                      <label className="form-label text-white-50">Password</label>
                      <div className="input-group">
                        <span className="input-group-text bg-dark border-secondary">
                          <i className="bi bi-lock text-muted"></i>
                        </span>
                        <input
                          type={showPassword ? "text" : "password"}
                          className="form-control bg-dark border-secondary text-white"
                          placeholder="Enter your password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                        />
                        <button
                          type="button"
                          className="btn btn-outline-secondary border-secondary"
                          onClick={() => setShowPassword(!showPassword)}
                        >
                          <i className={`bi bi-eye${showPassword ? '-slash' : ''} text-white`}></i>
                        </button>
                      </div>
                    </div>

                    {error && (
                      <div className="alert alert-danger bg-danger bg-opacity-25 border-danger text-white py-2 mb-3">
                        <i className="bi bi-exclamation-triangle me-2"></i>
                        {error}
                      </div>
                    )}

                    <button 
                      type="submit" 
                      className="btn btn-accent w-100 py-2 fw-bold"
                      disabled={loading}
                    >
                      {loading ? (
                        <>
                          <span className="spinner-border spinner-border-sm me-2" role="status"></span>
                          Signing in...
                        </>
                      ) : (
                        <>
                          <i className="bi bi-box-arrow-in-right me-2"></i>
                          Sign In
                        </>
                      )}
                    </button>
                  </form>

                  <div className="mt-4 p-3 bg-dark-subtle rounded">
                    <small className="text-white-50">
                      <i className="bi bi-info-circle me-1"></i>
                      Demo password: <code className="text-warning">demo123</code>
                    </small>
                  </div>
                </div>

                {/* Right Side - Demo Users */}
                <div className="col-lg-7 bg-light p-5">
                  <h4 className="mb-4 fw-bold text-dark">
                    <i className="bi bi-people me-2"></i>
                    Select a Role to Login
                  </h4>

                  {/* SUPER_ADMIN */}
                  <div className="mb-4">
                    <div className="d-flex align-items-center mb-2">
                      <span className="badge bg-danger me-2">SUPERADMIN</span>
                      <span className="text-muted small">Hamilton Management</span>
                    </div>
                    <p className="small text-muted mb-2">{getRoleDescription('SUPER_ADMIN')}</p>
                    <div className="d-flex flex-wrap gap-2">
                      {getUsersByRole('SUPER_ADMIN').map(user => (
                        <button
                          key={user.email}
                          className="btn btn-sm btn-outline-danger"
                          onClick={() => handleQuickLogin(user.email)}
                          disabled={loading}
                        >
                          <i className="bi bi-person-badge me-1"></i>
                          {user.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* MANAGEMENT */}
                  <div className="mb-4">
                    <div className="d-flex align-items-center mb-2">
                      <span className="badge bg-warning text-dark me-2">MANAGEMENT</span>
                      <span className="text-muted small">Operations Team</span>
                    </div>
                    <p className="small text-muted mb-2">{getRoleDescription('MANAGEMENT')}</p>
                    <div className="d-flex flex-wrap gap-2">
                      {getUsersByRole('MANAGEMENT').map(user => (
                        <button
                          key={user.email}
                          className="btn btn-sm btn-outline-warning"
                          onClick={() => handleQuickLogin(user.email)}
                          disabled={loading}
                        >
                          <i className="bi bi-person-badge me-1"></i>
                          {user.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* MVNO_ADMIN */}
                  <div className="mb-4">
                    <div className="d-flex align-items-center mb-2">
                      <span className="badge bg-primary me-2">MVNO ADMIN</span>
                      <span className="text-muted small">Telecom Partners</span>
                    </div>
                    <p className="small text-muted mb-2">{getRoleDescription('MVNO_ADMIN')}</p>
                    <div className="d-flex flex-wrap gap-2">
                      {getUsersByRole('MVNO_ADMIN').map(user => (
                        <button
                          key={user.email}
                          className="btn btn-sm btn-outline-primary"
                          onClick={() => handleQuickLogin(user.email)}
                          disabled={loading}
                        >
                          <i className="bi bi-person-badge me-1"></i>
                          {user.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* DISTRIBUTOR */}
                  <div className="mb-4">
                    <div className="d-flex align-items-center mb-2">
                      <span className="badge bg-info text-dark me-2">DISTRIBUTOR</span>
                      <span className="text-muted small">Channel Partners</span>
                    </div>
                    <p className="small text-muted mb-2">{getRoleDescription('DISTRIBUTOR')}</p>
                    <div className="d-flex flex-wrap gap-2">
                      {getUsersByRole('DISTRIBUTOR').map(user => (
                        <button
                          key={user.email}
                          className="btn btn-sm btn-outline-info"
                          onClick={() => handleQuickLogin(user.email)}
                          disabled={loading}
                        >
                          <i className="bi bi-person-badge me-1"></i>
                          {user.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  <hr className="my-4" />

                  <div className="text-center">
                    <a href="/distributor-request" className="text-decoration-none">
                      <button className="btn btn-outline-dark">
                        <i className="bi bi-box-arrow-up-right me-2"></i>
                        Distributor Stock Request Form
                      </button>
                    </a>
                    <p className="small text-muted mt-2">
                      External distributors can request stock via unique links
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="text-center mt-4 text-white-50">
              <small>© 2026 SIM Stock Manager - MVNE Platform</small>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
