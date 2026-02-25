import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { Mvno, BoxStockSummary, BossSyncLog, StockIssuanceRequest } from '../types/simcard';

interface SuperAdminStats {
  totalStock: number;
  totalDistributed: number;
  totalActivated: number;
  activationRate: number;
  pendingApprovals: number;
}

interface MvnoStats {
  mvnoId: string;
  mvnoName: string;
  stock: number;
  distributed: number;
  activated: number;
  activationRate: number;
  distributors: number;
  pendingRequests: number;
}

export function SuperAdminDashboard() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<SuperAdminStats>({
    totalStock: 0,
    totalDistributed: 0,
    totalActivated: 0,
    activationRate: 0,
    pendingApprovals: 0,
  });
  const [mvnoStats, setMvnoStats] = useState<MvnoStats[]>([]);
  const [recentSyncs, setRecentSyncs] = useState<BossSyncLog[]>([]);
  const [pendingRequests, setPendingRequests] = useState<StockIssuanceRequest[]>([]);
  const [mvnos, setMvnos] = useState<Mvno[]>([]);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      setLoading(true);

      // Fetch MVNOs
      const { data: mvnosData } = await supabase
        .from('mvnos')
        .select('*')
        .order('name');
      
      if (mvnosData) {
        setMvnos(mvnosData);
      }

      // Fetch boxes for stock calculation
      const { data: boxesData } = await supabase
        .from('boxes')
        .select('*');

      // Fetch distributors count per MVNO
      const { data: distributorsData } = await supabase
        .from('distributors')
        .select('id, mvno_id');

      // Calculate MVNO stats
      const mvnoStatsData: MvnoStats[] = [];
      
      for (const mvno of mvnosData || []) {
        const mvnoBoxes = (boxesData || []).filter(b => b.mvno_id === mvno.id);
        const mvnoDistributors = (distributorsData || []).filter(d => d.mvno_id === mvno.id);
        
        const stock = mvnoBoxes.reduce((sum, b) => sum + (b.remaining_sims || 0), 0);
        const distributed = mvnoBoxes.reduce((sum, b) => sum + (b.issued_sims || 0), 0);
        
        // For now, use a placeholder for activated (would come from activation_records)
        const activated = Math.floor(distributed * 0.8); // Placeholder calculation
        
        mvnoStatsData.push({
          mvnoId: mvno.id,
          mvnoName: mvno.name,
          stock,
          distributed,
          activated,
          activationRate: distributed > 0 ? Math.round((activated / distributed) * 100) : 0,
          distributors: mvnoDistributors.length,
          pendingRequests: 0,
        });
      }

      setMvnoStats(mvnoStatsData);

      // Calculate overall stats
      const totalStock = mvnoStatsData.reduce((sum, m) => sum + m.stock, 0);
      const totalDistributed = mvnoStatsData.reduce((sum, m) => sum + m.distributed, 0);
      const totalActivated = mvnoStatsData.reduce((sum, m) => sum + m.activated, 0);

      setStats({
        totalStock,
        totalDistributed,
        totalActivated,
        activationRate: totalDistributed > 0 ? Math.round((totalActivated / totalDistributed) * 100) : 0,
        pendingApprovals: 0,
      });

      // Fetch recent sync logs
      const { data: syncLogsData } = await supabase
        .from('boss_sync_logs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(5);

      if (syncLogsData) {
        setRecentSyncs(syncLogsData);
      }

      // Fetch pending stock issuance requests
      const { data: requestsData } = await supabase
        .from('stock_issuance_requests')
        .select('*')
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false })
        .limit(10);

      if (requestsData) {
        setPendingRequests(requestsData);
        setStats(prev => ({ ...prev, pendingApprovals: requestsData.length }));
      }

    } catch (error) {
      console.error('Error loading dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  const getSyncStatusIcon = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <i className="bi bi-check-circle-fill text-success"></i>;
      case 'FAILED':
        return <i className="bi bi-x-circle-fill text-danger"></i>;
      case 'RUNNING':
        return <i className="bi bi-arrow-repeat text-primary"></i>;
      case 'PARTIAL':
        return <i className="bi bi-exclamation-triangle-fill text-warning"></i>;
      default:
        return <i className="bi bi-question-circle"></i>;
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  if (loading) {
    return (
      <div className="text-center py-5">
        <div className="spinner-border spinner-custom" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
        <p className="mt-2 text-muted-custom">Loading Super Admin Dashboard...</p>
      </div>
    );
  }

  return (
    <div className="super-admin-dashboard">
      {/* Overview Cards */}
      <div className="row g-3 mb-4">
        <div className="col-md-3">
          <div className="card card-custom h-100">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <small className="text-muted-custom text-uppercase">Total Stock</small>
                  <h2 className="fw-bold mb-0">{stats.totalStock.toLocaleString()}</h2>
                </div>
                <div className="icon-box bg-primary-subtle">
                  <i className="bi bi-box-seam text-primary fs-4"></i>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="col-md-3">
          <div className="card card-custom h-100">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <small className="text-muted-custom text-uppercase">Distributed</small>
                  <h2 className="fw-bold mb-0">{stats.totalDistributed.toLocaleString()}</h2>
                </div>
                <div className="icon-box bg-success-subtle">
                  <i className="bi bi-arrow-up-circle text-success fs-4"></i>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="col-md-3">
          <div className="card card-custom h-100">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <small className="text-muted-custom text-uppercase">Activated</small>
                  <h2 className="fw-bold mb-0">{stats.totalActivated.toLocaleString()}</h2>
                </div>
                <div className="icon-box bg-info-subtle">
                  <i className="bi bi-check2-circle text-info fs-4"></i>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="col-md-3">
          <div className="card card-custom h-100">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <small className="text-muted-custom text-uppercase">Activation Rate</small>
                  <h2 className="fw-bold mb-0">{stats.activationRate}%</h2>
                </div>
                <div className="icon-box bg-warning-subtle">
                  <i className="bi bi-graph-up text-warning fs-4"></i>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* MVNO Breakdown Table */}
      <div className="card card-custom mb-4">
        <div className="card-header card-header-custom">
          <h5 className="mb-0">
            <i className="bi bi-grid me-2"></i>
            MVNO Stock Breakdown
          </h5>
        </div>
        <div className="card-body p-0">
          <div className="table-responsive">
            <table className="table table-custom mb-0">
              <thead>
                <tr>
                  <th>MVNO</th>
                  <th className="text-end">Stock</th>
                  <th className="text-end">Distributed</th>
                  <th className="text-end">Activated</th>
                  <th className="text-end">Activation Rate</th>
                  <th className="text-end">Distributors</th>
                </tr>
              </thead>
              <tbody>
                {mvnoStats.map((mvno) => (
                  <tr key={mvno.mvnoId}>
                    <td>
                      <span className="badge" style={{ backgroundColor: 'var(--brand-primary)' }}>
                        {mvno.mvnoName}
                      </span>
                    </td>
                    <td className="text-end">{mvno.stock.toLocaleString()}</td>
                    <td className="text-end">{mvno.distributed.toLocaleString()}</td>
                    <td className="text-end">{mvno.activated.toLocaleString()}</td>
                    <td className="text-end">
                      <div className="d-flex align-items-center justify-content-end gap-2">
                        <div className="progress" style={{ width: '60px', height: '6px' }}>
                          <div 
                            className="progress-bar bg-success" 
                            style={{ width: `${mvno.activationRate}%` }}
                          ></div>
                        </div>
                        <span>{mvno.activationRate}%</span>
                      </div>
                    </td>
                    <td className="text-end">{mvno.distributors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="row g-4">
        {/* Pending Approvals */}
        <div className="col-md-6">
          <div className="card card-custom h-100">
            <div className="card-header card-header-custom">
              <h5 className="mb-0">
                <i className="bi bi-hourglass-split me-2"></i>
                Pending Stock Requests
                {pendingRequests.length > 0 && (
                  <span className="badge bg-danger ms-2">{pendingRequests.length}</span>
                )}
              </h5>
            </div>
            <div className="card-body">
              {pendingRequests.length === 0 ? (
                <div className="text-center text-muted-custom py-4">
                  <i className="bi bi-check-circle fs-1"></i>
                  <p className="mt-2">No pending requests</p>
                </div>
              ) : (
                <div className="list-group list-group-flush">
                  {pendingRequests.slice(0, 5).map((request) => (
                    <div key={request.id} className="list-group-item bg-transparent px-0">
                      <div className="d-flex justify-content-between align-items-start">
                        <div>
                          <div className="fw-bold">
                            {request.sim_type} - {request.quantity} units
                          </div>
                          <small className="text-muted-custom">
                            {formatDate(request.created_at)}
                          </small>
                        </div>
                        <span className={`badge bg-${request.status === 'PENDING' ? 'warning' : 'info'}`}>
                          {request.status.replace('_', ' ')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Recent BOSS Syncs */}
        <div className="col-md-6">
          <div className="card card-custom h-100">
            <div className="card-header card-header-custom">
              <h5 className="mb-0">
                <i className="bi bi-arrow-repeat me-2"></i>
                Recent BOSS Syncs
              </h5>
            </div>
            <div className="card-body">
              {recentSyncs.length === 0 ? (
                <div className="text-center text-muted-custom py-4">
                  <i className="bi bi-inbox fs-1"></i>
                  <p className="mt-2">No sync history</p>
                </div>
              ) : (
                <div className="list-group list-group-flush">
                  {recentSyncs.map((sync) => (
                    <div key={sync.id} className="list-group-item bg-transparent px-0">
                      <div className="d-flex justify-content-between align-items-start">
                        <div className="d-flex align-items-center gap-2">
                          {getSyncStatusIcon(sync.status)}
                          <div>
                            <div className="fw-bold">{sync.sync_type} Sync</div>
                            <small className="text-muted-custom">
                              {formatDate(sync.started_at)}
                            </small>
                          </div>
                        </div>
                        <div className="text-end">
                          <small>
                            {sync.records_activated} activated, {sync.records_failed} failed
                          </small>
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
    </div>
  );
}
