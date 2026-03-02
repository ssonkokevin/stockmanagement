import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { Distributor, BoxStockSummary, StockIssuanceRequest, Mvno, PlatformUser } from '../types/simcard';

interface MVNOAdminDashboardProps {
  user: PlatformUser;
}

interface StockProfile {
  totalSims: number;           // Total SIMs allocated to this MVNO
  stockFromHamilton: number;   // SIMs received from Hamilton
  stockDistributed: number;    // SIMs given to distributors
  activatedCount: number;      // SIMs that have been activated
  availableStock: number;      // Remaining stock available for distribution
}

interface PendingRequest {
  id: string;
  distributor_name: string;
  sim_type: string;
  quantity: number;
  status: string;
  created_at: string;
}

export function MVNOAdminDashboard({ user }: MVNOAdminDashboardProps) {
  const [loading, setLoading] = useState(true);
  const [stockProfile, setStockProfile] = useState<StockProfile>({
    totalSims: 0,
    stockFromHamilton: 0,
    stockDistributed: 0,
    activatedCount: 0,
    availableStock: 0,
  });
  const [distributors, setDistributors] = useState<Distributor[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [recentDistributions, setRecentDistributions] = useState<any[]>([]);
  const [boxes, setBoxes] = useState<any[]>([]);
  const [currentMvnoName, setCurrentMvnoName] = useState<string>('');

  // Get MVNO info from user
  const mvnoId = user.mvno_id;
  const mvnoName = useMemo(() => {
    // Try to get MVNO name from mvno_id or use email to determine
    if (mvnoId) return mvnoId; // Will be resolved to name below
    // Fallback: extract from email (e.g., paxtel@paxtel.com -> PAXTEL)
    const email = user.email || '';
    const domain = email.split('@')[1]?.split('.')[0] || '';
    return domain.toUpperCase();
  }, [mvnoId, user.email]);

  // Load data on mount
  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      setLoading(true);

      // Use mvno_id directly if available, otherwise fallback to email domain
      let mvnoIdToUse = mvnoId;
      
      if (!mvnoIdToUse) {
        // Fallback: extract from email (e.g., paxtel@paxtel.com -> PAXTEL)
        const email = user.email || '';
        const domain = email.split('@')[1]?.split('.')[0] || '';
        const mvnoName = domain.toUpperCase();
        
        // Try to find MVNO by name
        const { data: mvnoData } = await supabase
          .from('mvnos')
          .select('id, name')
          .ilike('name', mvnoName)
          .single();
        
        if (mvnoData) {
          mvnoIdToUse = mvnoData.id;
        } else {
          console.error('MVNO not found for:', mvnoName);
          setLoading(false);
          return;
        }
      }

      // Fetch MVNO name
      const { data: mvnoInfo } = await supabase
        .from('mvnos')
        .select('id, name')
        .eq('id', mvnoIdToUse)
        .single();

      const currentMvnoName = mvnoInfo?.name || 'Unknown';
      setCurrentMvnoName(currentMvnoName);

      // Fetch boxes for this MVNO
      const { data: boxesData } = await supabase
        .from('boxes')
        .select('*')
        .eq('mvno_id', mvnoIdToUse);

      // Fetch distributors for this MVNO
      const { data: distributorsData } = await supabase
        .from('distributors')
        .select('*')
        .eq('mvno_id', mvnoId)
        .eq('is_active', true)
        .order('name');

      // Fetch pending stock requests for this MVNO's distributors
      const { data: requestsData } = await supabase
        .from('distributor_stock_requests')
        .select('*')
        .eq('mvno_id', mvnoId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      // Fetch recent pick/distribution history
      const { data: historyData } = await supabase
        .from('pick_records')
        .select('*')
        .eq('mvno_id', mvnoId)
        .order('pick_date', { ascending: false })
        .limit(10);

      setBoxes(boxesData || []);
      setDistributors(distributorsData || []);
      setPendingRequests(requestsData || []);
      setRecentDistributions(historyData || []);

      // Calculate stock profile
      const totalSims = (boxesData || []).reduce((sum, b) => sum + (b.total_sims || 0), 0);
      const stockFromHamilton = totalSims; // All stock comes from Hamilton initially
      const stockDistributed = (boxesData || []).reduce((sum, b) => sum + (b.issued_sims || 0), 0);
      const availableStock = (boxesData || []).reduce((sum, b) => sum + (b.remaining_sims || 0), 0);
      
      // Calculate activated (placeholder - would need activation_records table)
      const activatedCount = Math.floor(stockDistributed * 0.75); // Placeholder

      setStockProfile({
        totalSims,
        stockFromHamilton,
        stockDistributed,
        activatedCount,
        availableStock,
      });

    } catch (error) {
      console.error('Error loading MVNO dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  // Calculate distribution by SIM type
  const stockByType = useMemo(() => {
    const physical = boxes.filter(b => (b.sim_type || '').toLowerCase().includes('physical'));
    const esim = boxes.filter(b => (b.sim_type || '').toLowerCase().includes('esim'));
    
    return {
      physical: {
        total: physical.reduce((sum, b) => sum + (b.total_sims || 0), 0),
        distributed: physical.reduce((sum, b) => sum + (b.issued_sims || 0), 0),
        available: physical.reduce((sum, b) => sum + (b.remaining_sims || 0), 0),
      },
      esim: {
        total: esim.reduce((sum, b) => sum + (b.total_sims || 0), 0),
        distributed: esim.reduce((sum, b) => sum + (b.issued_sims || 0), 0),
        available: esim.reduce((sum, b) => sum + (b.remaining_sims || 0), 0),
      }
    };
  }, [boxes]);

  if (loading) {
    return (
      <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '400px' }}>
        <div className="spinner-border text-primary" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid p-4">
      {/* Header */}
      <div className="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h4 className="mb-1">
            <i className="bi bi-building me-2"></i>
            {currentMvnoName || mvnoName} Admin Dashboard
          </h4>
          <small className="text-muted">Welcome back, {user.full_name}</small>
        </div>
        <div className="d-flex gap-2">
          <button className="btn btn-outline-custom btn-sm" onClick={loadDashboardData}>
            <i className="bi bi-arrow-clockwise me-1"></i>
            Refresh
          </button>
        </div>
      </div>

      {/* Stock Profile Cards */}
      <div className="row g-3 mb-4">
        <div className="col-12 col-sm-6 col-lg">
          <div className="card card-custom h-100">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <small className="text-muted-custom text-uppercase fw-bold">Total SIMs</small>
                  <h3 className="mb-0 mt-1">{stockProfile.totalSims.toLocaleString()}</h3>
                </div>
                <div className="bg-primary bg-opacity-10 p-2 rounded">
                  <i className="bi bi-sim text-primary fs-4"></i>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="col-12 col-sm-6 col-lg">
          <div className="card card-custom h-100">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <small className="text-muted-custom text-uppercase fw-bold">From Hamilton</small>
                  <h3 className="mb-0 mt-1">{stockProfile.stockFromHamilton.toLocaleString()}</h3>
                </div>
                <div className="bg-info bg-opacity-10 p-2 rounded">
                  <i className="bi bi-box-seam text-info fs-4"></i>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="col-12 col-sm-6 col-lg">
          <div className="card card-custom h-100">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <small className="text-muted-custom text-uppercase fw-bold">Distributed</small>
                  <h3 className="mb-0 mt-1">{stockProfile.stockDistributed.toLocaleString()}</h3>
                </div>
                <div className="bg-warning bg-opacity-10 p-2 rounded">
                  <i className="bi bi-person-check text-warning fs-4"></i>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="col-12 col-sm-6 col-lg">
          <div className="card card-custom h-100">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <small className="text-muted-custom text-uppercase fw-bold">Activated</small>
                  <h3 className="mb-0 mt-1">{stockProfile.activatedCount.toLocaleString()}</h3>
                </div>
                <div className="bg-success bg-opacity-10 p-2 rounded">
                  <i className="bi bi-check-circle text-success fs-4"></i>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="col-12 col-sm-6 col-lg">
          <div className="card card-custom h-100 border-success">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <small className="text-muted-custom text-uppercase fw-bold">Available</small>
                  <h3 className="mb-0 mt-1 text-success">{stockProfile.availableStock.toLocaleString()}</h3>
                </div>
                <div className="bg-success bg-opacity-10 p-2 rounded">
                  <i className="bi bi-archive text-success fs-4"></i>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Stock by Type */}
      <div className="row g-3 mb-4">
        {/* Physical SIM */}
        <div className="col-12 col-md-6">
          <div className="card card-custom h-100">
            <div className="card-header card-header-custom">
              <h5 className="mb-0">
                <i className="bi bi-credit-card me-2"></i>
                Physical SIM Stock
              </h5>
            </div>
            <div className="card-body">
              <div className="row text-center">
                <div className="col-4">
                  <div className="p-3 bg-light rounded">
                    <div className="fw-bold text-primary">{stockByType.physical.total.toLocaleString()}</div>
                    <small className="text-muted">Total</small>
                  </div>
                </div>
                <div className="col-4">
                  <div className="p-3 bg-light rounded">
                    <div className="fw-bold text-warning">{stockByType.physical.distributed.toLocaleString()}</div>
                    <small className="text-muted">Distributed</small>
                  </div>
                </div>
                <div className="col-4">
                  <div className="p-3 bg-light rounded">
                    <div className="fw-bold text-success">{stockByType.physical.available.toLocaleString()}</div>
                    <small className="text-muted">Available</small>
                  </div>
                </div>
              </div>
              {/* Progress bar */}
              <div className="mt-3">
                <div className="d-flex justify-content-between mb-1">
                  <small>Distribution Progress</small>
                  <small>{stockByType.physical.total > 0 ? Math.round((stockByType.physical.distributed / stockByType.physical.total) * 100) : 0}%</small>
                </div>
                <div className="progress" style={{ height: '8px' }}>
                  <div 
                    className="progress-bar bg-warning" 
                    style={{ width: `${stockByType.physical.total > 0 ? (stockByType.physical.distributed / stockByType.physical.total) * 100 : 0}%` }}
                  ></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* eSIM */}
        <div className="col-12 col-md-6">
          <div className="card card-custom h-100">
            <div className="card-header card-header-custom">
              <h5 className="mb-0">
                <i className="bi bi-phone me-2"></i>
                eSIM Stock
              </h5>
            </div>
            <div className="card-body">
              <div className="row text-center">
                <div className="col-4">
                  <div className="p-3 bg-light rounded">
                    <div className="fw-bold text-primary">{stockByType.esim.total.toLocaleString()}</div>
                    <small className="text-muted">Total</small>
                  </div>
                </div>
                <div className="col-4">
                  <div className="p-3 bg-light rounded">
                    <div className="fw-bold text-warning">{stockByType.esim.distributed.toLocaleString()}</div>
                    <small className="text-muted">Distributed</small>
                  </div>
                </div>
                <div className="col-4">
                  <div className="p-3 bg-light rounded">
                    <div className="fw-bold text-success">{stockByType.esim.available.toLocaleString()}</div>
                    <small className="text-muted">Available</small>
                  </div>
                </div>
              </div>
              {/* Progress bar */}
              <div className="mt-3">
                <div className="d-flex justify-content-between mb-1">
                  <small>Distribution Progress</small>
                  <small>{stockByType.esim.total > 0 ? Math.round((stockByType.esim.distributed / stockByType.esim.total) * 100) : 0}%</small>
                </div>
                <div className="progress" style={{ height: '8px' }}>
                  <div 
                    className="progress-bar bg-warning" 
                    style={{ width: `${stockByType.esim.total > 0 ? (stockByType.esim.distributed / stockByType.esim.total) * 100 : 0}%` }}
                  ></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Section: Pending Requests & Distributors */}
      <div className="row g-3">
        {/* Pending Requests */}
        <div className="col-12 col-lg-6">
          <div className="card card-custom h-100">
            <div className="card-header card-header-custom d-flex justify-content-between align-items-center">
              <h5 className="mb-0">
                <i className="bi bi-hourglass-split me-2"></i>
                Pending Stock Requests
              </h5>
              <span className="badge bg-warning">{pendingRequests.length}</span>
            </div>
            <div className="card-body p-0">
              {pendingRequests.length === 0 ? (
                <div className="text-center py-4 text-muted">
                  <i className="bi bi-check-circle fs-1 d-block mb-2"></i>
                  No pending requests
                </div>
              ) : (
                <div className="table-responsive">
                  <table className="table table-hover mb-0">
                    <thead>
                      <tr>
                        <th>Distributor</th>
                        <th>SIM Type</th>
                        <th>Qty</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingRequests.slice(0, 5).map((req) => (
                        <tr key={req.id}>
                          <td>{req.distributor_name || 'Unknown'}</td>
                          <td>
                            <span className={`badge ${(req.sim_type || '').toLowerCase().includes('esim') ? 'bg-info' : 'bg-secondary'}`}>
                              {req.sim_type || 'Physical'}
                            </span>
                          </td>
                          <td className="fw-bold">{req.quantity}</td>
                          <td>
                            <small className="text-muted">
                              {req.created_at ? new Date(req.created_at).toLocaleDateString() : '-'}
                            </small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* My Distributors */}
        <div className="col-12 col-lg-6">
          <div className="card card-custom h-100">
            <div className="card-header card-header-custom d-flex justify-content-between align-items-center">
              <h5 className="mb-0">
                <i className="bi bi-people me-2"></i>
                My Distributors
              </h5>
              <span className="badge bg-primary">{distributors.length}</span>
            </div>
            <div className="card-body p-0">
              {distributors.length === 0 ? (
                <div className="text-center py-4 text-muted">
                  <i className="bi bi-person-x fs-1 d-block mb-2"></i>
                  No distributors assigned
                </div>
              ) : (
                <div className="table-responsive">
                  <table className="table table-hover mb-0">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Region</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {distributors.slice(0, 5).map((dist) => (
                        <tr key={dist.id}>
                          <td className="fw-bold">{dist.name}</td>
                          <td>
                            <small className="text-muted">{dist.type || 'DISTRIBUTOR'}</small>
                          </td>
                          <td>
                            <small className="text-muted">{dist.region || '-'}</small>
                          </td>
                          <td>
                            <span className={`badge ${dist.is_active ? 'bg-success' : 'bg-secondary'}`}>
                              {dist.is_active ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Quick Stats Footer */}
      <div className="row g-3 mt-2">
        <div className="col-12">
          <div className="alert alert-info-custom d-flex align-items-center">
            <i className="bi bi-info-circle fs-4 me-3"></i>
            <div>
              <strong>Quick Stats:</strong> You have <strong>{distributors.length}</strong> active distributors and 
              <strong> {pendingRequests.length}</strong> pending stock requests awaiting approval.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
