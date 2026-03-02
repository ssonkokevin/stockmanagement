import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { usePlatformAuth } from '../hooks/usePlatformAuth';
import type { Mvno, Distributor } from '../types/simcard';

interface StockBalance {
  physical: number;
  esim: number;
  total: number;
}

interface Notification {
  id: string;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  created_at: string;
}

interface StockRequest {
  id: string;
  mvno_id: string;
  mvno_name: string;
  sim_type: string;
  quantity: number;
  status: string;
  requested_at: string;
  notes: string;
}

export function SuperadminDashboard() {
  const { user, logout } = usePlatformAuth();
  const [mvnos, setMvnos] = useState<Mvno[]>([]);
  const [distributors, setDistributors] = useState<Distributor[]>([]);
  const [stockBalances, setStockBalances] = useState<Record<string, StockBalance>>({});
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [pendingRequests, setPendingRequests] = useState<StockRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    setLoading(true);
    try {
      // Load MVNOs
      const { data: mvnosData } = await supabase
        .from('mvnos')
        .select('*')
        .order('name');
      setMvnos(mvnosData || []);

      // Load Distributors
      const { data: distData } = await supabase
        .from('distributors')
        .select('*')
        .order('name');
      setDistributors(distData || []);

      // Load stock balances for each MVNO
      const balances: Record<string, StockBalance> = {};
      for (const mvno of mvnosData || []) {
        // Physical SIMs
        const { count: physicalCount } = await supabase
          .from('boxes')
          .select('*', { count: 'exact', head: true })
          .eq('mvno_id', mvno.id)
          .eq('status', 'AVAILABLE');

        // eSIMs
        const { count: esimCount } = await supabase
          .from('esim_stock')
          .select('*', { count: 'exact', head: true })
          .eq('mvno_id', mvno.id)
          .eq('status', 'AVAILABLE');

        balances[mvno.id] = {
          physical: physicalCount || 0,
          esim: esimCount || 0,
          total: (physicalCount || 0) + (esimCount || 0)
        };
      }
      setStockBalances(balances);

      // Load pending MVNO stock requests
      const { data: requestsData } = await supabase
        .from('mvno_stock_requests')
        .select('*')
        .eq('status', 'PENDING')
        .order('requested_at', { ascending: false });

      // Get MVNO names
      const requestsWithNames = (requestsData || []).map(req => {
        const mvno = mvnosData?.find(m => m.id === req.mvno_id);
        return {
          ...req,
          mvno_name: mvno?.name || 'Unknown'
        };
      });
      setPendingRequests(requestsWithNames);

      // Load notifications
      if (user?.id) {
        const { data: notifData } = await supabase
          .from('notifications')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(10);
        setNotifications(notifData || []);
      }

    } catch (error) {
      console.error('Error loading dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleApproveRequest = async (requestId: string) => {
    try {
      await supabase
        .from('mvno_stock_requests')
        .update({ status: 'APPROVED', updated_at: new Date().toISOString() })
        .eq('id', requestId);

      // Reload data
      loadDashboardData();
    } catch (error) {
      console.error('Error approving request:', error);
    }
  };

  const handleRejectRequest = async (requestId: string) => {
    try {
      await supabase
        .from('mvno_stock_requests')
        .update({ status: 'REJECTED', updated_at: new Date().toISOString() })
        .eq('id', requestId);

      loadDashboardData();
    } catch (error) {
      console.error('Error rejecting request:', error);
    }
  };

  const getUnreadCount = () => notifications.filter(n => !n.is_read).length;

  return (
    <div className="min-vh-100 bg-light">
      {/* Top Navigation */}
      <nav className="navbar navbar-expand-lg navbar-dark bg-dark">
        <div className="container-fluid">
          <a className="navbar-brand fw-bold" href="#">
            <i className="bi bi-shield-check me-2 text-accent"></i>
            SIM Stock Manager - Superadmin
          </a>
          <div className="d-flex align-items-center">
            <span className="text-white-50 me-3">
              Welcome, {user?.full_name}
            </span>
            <div className="dropdown">
              <button className="btn btn-outline-light position-relative" data-bs-toggle="dropdown">
                <i className="bi bi-bell"></i>
                {getUnreadCount() > 0 && (
                  <span className="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger">
                    {getUnreadCount()}
                  </span>
                )}
              </button>
              <ul className="dropdown-menu dropdown-menu-end">
                {notifications.length === 0 ? (
                  <li><span className="dropdown-item-text text-muted">No notifications</span></li>
                ) : (
                  notifications.map(n => (
                    <li key={n.id}>
                      <a className={`dropdown-item ${!n.is_read ? 'fw-bold' : ''}`} href="#">
                        <i className={`bi bi-${n.type === 'WARNING' ? 'exclamation' : 'info'}-circle me-2`}></i>
                        {n.title}
                      </a>
                    </li>
                  ))
                )}
              </ul>
            </div>
            <button className="btn btn-outline-light ms-2" onClick={logout}>
              <i className="bi bi-box-arrow-right"></i> Logout
            </button>
          </div>
        </div>
      </nav>

      <div className="container-fluid py-4">
        {/* Stats Cards */}
        <div className="row mb-4">
          <div className="col-md-3">
            <div className="card border-0 shadow-sm">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-center">
                  <div>
                    <p className="text-muted mb-0">Total MVNOs</p>
                    <h3 className="mb-0 fw-bold">{mvnos.length}</h3>
                  </div>
                  <div className="bg-primary bg-opacity-10 p-3 rounded">
                    <i className="bi bi-building text-primary fs-4"></i>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="col-md-3">
            <div className="card border-0 shadow-sm">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-center">
                  <div>
                    <p className="text-muted mb-0">Distributors</p>
                    <h3 className="mb-0 fw-bold">{distributors.length}</h3>
                  </div>
                  <div className="bg-info bg-opacity-10 p-3 rounded">
                    <i className="bi bi-people text-info fs-4"></i>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="col-md-3">
            <div className="card border-0 shadow-sm">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-center">
                  <div>
                    <p className="text-muted mb-0">Physical SIMs</p>
                    <h3 className="mb-0 fw-bold">
                      {Object.values(stockBalances).reduce((sum, b) => sum + b.physical, 0).toLocaleString()}
                    </h3>
                  </div>
                  <div className="bg-success bg-opacity-10 p-3 rounded">
                    <i className="bi bi-sim text-success fs-4"></i>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="col-md-3">
            <div className="card border-0 shadow-sm">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-center">
                  <div>
                    <p className="text-muted mb-0">eSIMs</p>
                    <h3 className="mb-0 fw-bold">
                      {Object.values(stockBalances).reduce((sum, b) => sum + b.esim, 0).toLocaleString()}
                    </h3>
                  </div>
                  <div className="bg-warning bg-opacity-10 p-3 rounded">
                    <i className="bi bi-phone text-warning fs-4"></i>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <ul className="nav nav-tabs mb-4">
          <li className="nav-item">
            <button 
              className={`nav-link ${activeTab === 'overview' ? 'active' : ''}`}
              onClick={() => setActiveTab('overview')}
            >
              <i className="bi bi-grid me-2"></i>Overview
            </button>
          </li>
          <li className="nav-item">
            <button 
              className={`nav-link ${activeTab === 'mvnos' ? 'active' : ''}`}
              onClick={() => setActiveTab('mvnos')}
            >
              <i className="bi bi-building me-2"></i>MVNOs
            </button>
          </li>
          <li className="nav-item">
            <button 
              className={`nav-link ${activeTab === 'requests' ? 'active' : ''}`}
              onClick={() => setActiveTab('requests')}
            >
              <i className="bi bi-arrow-left-right me-2"></i>Stock Requests
              {pendingRequests.length > 0 && (
                <span className="badge bg-danger ms-2">{pendingRequests.length}</span>
              )}
            </button>
          </li>
          <li className="nav-item">
            <button 
              className={`nav-link ${activeTab === 'reports' ? 'active' : ''}`}
              onClick={() => setActiveTab('reports')}
            >
              <i className="bi bi-file-earmark-text me-2"></i>Reports
            </button>
          </li>
        </ul>

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <div className="row">
            <div className="col-md-6">
              <div className="card border-0 shadow-sm mb-4">
                <div className="card-header bg-white">
                  <h5 className="mb-0">
                    <i className="bi bi-graph-up me-2"></i>Stock by MVNO
                  </h5>
                </div>
                <div className="card-body">
                  <div className="table-responsive">
                    <table className="table table-hover">
                      <thead>
                        <tr>
                          <th>MVNO</th>
                          <th className="text-end">Physical</th>
                          <th className="text-end">eSIM</th>
                          <th className="text-end">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mvnos.map(mvno => (
                          <tr key={mvno.id}>
                            <td>
                              <span className="fw-bold">{mvno.name}</span>
                            </td>
                            <td className="text-end">
                              {stockBalances[mvno.id]?.physical.toLocaleString() || 0}
                            </td>
                            <td className="text-end">
                              {stockBalances[mvno.id]?.esim.toLocaleString() || 0}
                            </td>
                            <td className="text-end fw-bold">
                              {stockBalances[mvno.id]?.total.toLocaleString() || 0}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
            <div className="col-md-6">
              <div className="card border-0 shadow-sm mb-4">
                <div className="card-header bg-white d-flex justify-content-between align-items-center">
                  <h5 className="mb-0">
                    <i className="bi bi-hourglass-split me-2"></i>Pending Stock Requests
                  </h5>
                  <button className="btn btn-sm btn-primary" onClick={() => setActiveTab('requests')}>
                    View All
                  </button>
                </div>
                <div className="card-body p-0">
                  {pendingRequests.length === 0 ? (
                    <div className="text-center py-4 text-muted">
                      <i className="bi bi-check-circle fs-1"></i>
                      <p className="mb-0">No pending requests</p>
                    </div>
                  ) : (
                    <div className="list-group list-group-flush">
                      {pendingRequests.slice(0, 5).map(req => (
                        <div key={req.id} className="list-group-item">
                          <div className="d-flex justify-content-between align-items-start">
                            <div>
                              <h6 className="mb-1">{req.mvno_name}</h6>
                              <p className="mb-1 small text-muted">
                                {req.sim_type} - {req.quantity.toLocaleString()} units
                              </p>
                              <small className="text-muted">
                                {new Date(req.requested_at).toLocaleDateString()}
                              </small>
                            </div>
                            <div className="btn-group btn-group-sm">
                              <button 
                                className="btn btn-success"
                                onClick={() => handleApproveRequest(req.id)}
                              >
                                <i className="bi bi-check"></i>
                              </button>
                              <button 
                                className="btn btn-danger"
                                onClick={() => handleRejectRequest(req.id)}
                              >
                                <i className="bi bi-x"></i>
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'mvnos' && (
          <div className="card border-0 shadow-sm">
            <div className="card-header bg-white d-flex justify-content-between align-items-center">
              <h5 className="mb-0">MVNO Management</h5>
              <button className="btn btn-primary">
                <i className="bi bi-plus me-2"></i>Add MVNO
              </button>
            </div>
            <div className="card-body">
              <div className="table-responsive">
                <table className="table table-hover">
                  <thead>
                    <tr>
                      <th>MVNO Name</th>
                      <th>Code</th>
                      <th className="text-end">Physical SIMs</th>
                      <th className="text-end">eSIMs</th>
                      <th className="text-end">Distributors</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mvnos.map(mvno => {
                      const distCount = distributors.filter(d => d.mvno_id === mvno.id).length;
                      return (
                        <tr key={mvno.id}>
                          <td className="fw-bold">{mvno.name}</td>
                          <td className="text-end">
                            {stockBalances[mvno.id]?.physical.toLocaleString() || 0}
                          </td>
                          <td className="text-end">
                            {stockBalances[mvno.id]?.esim.toLocaleString() || 0}
                          </td>
                          <td className="text-end">{distCount}</td>
                          <td>
                            <button className="btn btn-sm btn-outline-primary me-1">
                              <i className="bi bi-eye"></i>
                            </button>
                            <button className="btn btn-sm btn-outline-secondary">
                              <i className="bi bi-pencil"></i>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'requests' && (
          <div className="card border-0 shadow-sm">
            <div className="card-header bg-white">
              <h5 className="mb-0">MVNO Stock Requests</h5>
            </div>
            <div className="card-body">
              {pendingRequests.length === 0 ? (
                <div className="text-center py-5 text-muted">
                  <i className="bi bi-check-circle fs-1"></i>
                  <h5 className="mt-3">All caught up!</h5>
                  <p>No pending stock requests</p>
                </div>
              ) : (
                <div className="table-responsive">
                  <table className="table table-hover">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>MVNO</th>
                        <th>Type</th>
                        <th className="text-end">Quantity</th>
                        <th>Notes</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingRequests.map(req => (
                        <tr key={req.id}>
                          <td>{new Date(req.requested_at).toLocaleDateString()}</td>
                          <td className="fw-bold">{req.mvno_name}</td>
                          <td>
                            <span className={`badge ${req.sim_type === 'PHYSICAL' ? 'bg-success' : 'bg-warning'}`}>
                              {req.sim_type}
                            </span>
                          </td>
                          <td className="text-end fw-bold">{req.quantity.toLocaleString()}</td>
                          <td>{req.notes || '-'}</td>
                          <td>
                            <button 
                              className="btn btn-sm btn-success me-1"
                              onClick={() => handleApproveRequest(req.id)}
                            >
                              <i className="bi bi-check me-1"></i>Approve
                            </button>
                            <button 
                              className="btn btn-sm btn-danger"
                              onClick={() => handleRejectRequest(req.id)}
                            >
                              <i className="bi bi-x me-1"></i>Reject
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'reports' && (
          <div className="card border-0 shadow-sm">
            <div className="card-header bg-white d-flex justify-content-between align-items-center">
              <h5 className="mb-0">Reports & Exports</h5>
              <div>
                <button className="btn btn-outline-primary me-2">
                  <i className="bi bi-file-earmark-excel me-1"></i>Export CSV
                </button>
                <button className="btn btn-outline-danger">
                  <i className="bi bi-file-earmark-pdf me-1"></i>Export PDF
                </button>
              </div>
            </div>
            <div className="card-body">
              <div className="row">
                <div className="col-md-4">
                  <div className="card bg-light border-0">
                    <div className="card-body text-center">
                      <i className="bi bi-file-earmark-text fs-1 text-muted"></i>
                      <h6 className="mt-3">Stock Summary Report</h6>
                      <button className="btn btn-sm btn-outline-primary mt-2">
                        Generate
                      </button>
                    </div>
                  </div>
                </div>
                <div className="col-md-4">
                  <div className="card bg-light border-0">
                    <div className="card-body text-center">
                      <i className="bi bi-arrow-left-right fs-1 text-muted"></i>
                      <h6 className="mt-3">Stock Movement Report</h6>
                      <button className="btn btn-sm btn-outline-primary mt-2">
                        Generate
                      </button>
                    </div>
                  </div>
                </div>
                <div className="col-md-4">
                  <div className="card bg-light border-0">
                    <div className="card-body text-center">
                      <i className="bi bi-people fs-1 text-muted"></i>
                      <h6 className="mt-3">Distributor Activity</h6>
                      <button className="btn btn-sm btn-outline-primary mt-2">
                        Generate
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
