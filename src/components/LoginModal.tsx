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

  const getRoleIcon = (role: PlatformRole) => {
    const icons: Record<PlatformRole, string> = {
      SUPER_ADMIN: 'bi-shield-check',
      MANAGEMENT: 'bi-briefcase',
      MVNO_ADMIN: 'bi-building',
      DISTRIBUTOR: 'bi-shop',
    };
    return icons[role] || 'bi-person';
  };

  const getRoleDescription = (role: PlatformRole) => {
    const descriptions: Record<PlatformRole, string> = {
      SUPER_ADMIN: 'Manage all MVNOs, approve stock transfers, view all activities',
      MANAGEMENT: 'Manage operations and view reports',
      MVNO_ADMIN: 'Manage distributors, approve requests, distribute SIMs',
      DISTRIBUTOR: 'Request SIM stock from your MVNO',
    };
    return descriptions[role] || '';
  };

  // Group users by role
  const superadminUsers = DEMO_USERS.filter(u => u.role === 'SUPER_ADMIN');
  const mvnoUsers = DEMO_USERS.filter(u => u.role === 'MVNO_ADMIN');
  const managementUsers = DEMO_USERS.filter(u => u.role === 'MANAGEMENT');
  const distributorUsers = DEMO_USERS.filter(u => u.role === 'DISTRIBUTOR');

  return (
    <div className="modal d-block" style={{ backgroundColor: 'rgba(0,0,0,0.85)' }}>
      <div className="modal-dialog modal-dialog-centered modal-xl">
        <div className="modal-content" style={{ borderRadius: '20px', overflow: 'hidden' }}>
          <div className="row g-0">
            {/* Left Side - Portal Selection */}
            <div className="col-lg-5 bg-dark text-white p-5">
              <div className="mb-4">
                <h2 className="fw-bold">
                  <i className="bi bi-sim me-2"></i>
                  Hamilton Telecom
                </h2>
                <p className="text-white-50">SIM Stock Management System</p>
              </div>

              <h5 className="mb-4">Select Your Portal</h5>
              
              {/* Superadmin Portal */}
              <div className="mb-3">
                <h6 className="text-uppercase text-muted-custom mb-2">Administration</h6>
                {superadminUsers.map((user) => (
                  <button
                    key={user.email}
                    className="btn btn-outline-light w-100 mb-2 p-3 text-start d-flex align-items-center"
                    onClick={() => handleQuickLogin(user.email)}
                    disabled={loading}
                  >
                    <i className={`bi ${getRoleIcon(user.role)} fs-4 me-3 text-danger`}></i>
                    <div>
                      <div className="fw-bold">Super Admin Portal</div>
                      <small className="text-white-50">{user.name}</small>
                    </div>
                  </button>
                ))}
              </div>

              {/* MVNO Portal */}
              <div className="mb-3">
                <h6 className="text-uppercase text-muted-custom mb-2">MVNO Portals</h6>
                {mvnoUsers.map((user) => (
                  <button
                    key={user.email}
                    className="btn btn-outline-light w-100 mb-2 p-3 text-start d-flex align-items-center"
                    onClick={() => handleQuickLogin(user.email)}
                    disabled={loading}
                  >
                    <i className={`bi ${getRoleIcon(user.role)} fs-4 me-3 text-primary`}></i>
                    <div>
                      <div className="fw-bold">{(user as any).mvnoName || user.mvno || 'MVNO'} Admin</div>
                      <small className="text-white-50">{user.name}</small>
                    </div>
                  </button>
                ))}
              </div>

              {/* Distributor Portal */}
              <div className="mb-3">
                <h6 className="text-uppercase text-muted-custom mb-2">Distributor Portal</h6>
                {distributorUsers.slice(0, 2).map((user) => (
                  <button
                    key={user.email}
                    className="btn btn-outline-light w-100 mb-2 p-3 text-start d-flex align-items-center"
                    onClick={() => handleQuickLogin(user.email)}
                    disabled={loading}
                  >
                    <i className={`bi ${getRoleIcon(user.role)} fs-4 me-3 text-info`}></i>
                    <div>
                      <div className="fw-bold">Distributor</div>
                      <small className="text-white-50">{user.name}</small>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Right Side - Login Form */}
            <div className="col-lg-7 p-5" style={{ backgroundColor: '#f8f9fa' }}>
              <div className="mx-auto" style={{ maxWidth: '400px' }}>
                <h4 className="fw-bold mb-4">Sign In</h4>
                
                <form onSubmit={handleSubmit}>
                  <div className="mb-3">
                    <label className="form-label">Email</label>
                    <input
                      type="email"
                      className="form-control form-control-lg"
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
                      className="form-control form-control-lg"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                      required
                    />
                  </div>
                  {error && (
                    <div className="alert alert-danger py-2 mb-3">
                      {error}
                    </div>
                  )}
                  <button 
                    type="submit" 
                    className="btn btn-dark btn-lg w-100"
                    disabled={loading}
                  >
                    {loading ? 'Signing in...' : 'Sign In'}
                  </button>
                </form>

                <hr className="my-4" />

                <div className="text-center">
                  <p className="text-muted mb-3">Or use a demo account</p>
                  <div className="d-flex flex-wrap gap-2 justify-content-center">
                    {DEMO_USERS.map((user) => (
                      <button
                        key={user.email}
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => handleQuickLogin(user.email)}
                        disabled={loading}
                      >
                        {user.name}
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 p-2 bg-light rounded">
                    <small className="text-muted">
                      <i className="bi bi-info-circle me-1"></i>
                      Password for all: <code>demo123</code>
                    </small>
                  </div>
                </div>

                <div className="mt-5 p-3 bg-white rounded shadow-sm">
                  <h6 className="fw-bold mb-2">Role Permissions</h6>
                  <ul className="list-unstyled mb-0 small text-muted">
                    <li className="mb-1">
                      <span className="badge bg-danger me-1">Super Admin</span>
                      Full system access, approve MVNO stock requests
                    </li>
                    <li className="mb-1">
                      <span className="badge bg-primary me-1">MVNO Admin</span>
                      Manage distributors, approve requests, distribute SIMs
                    </li>
                    <li>
                      <span className="badge bg-info text-dark me-1">Distributor</span>
                      Request SIM stock from assigned MVNO
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LoginModal;
